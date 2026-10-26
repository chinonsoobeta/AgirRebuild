import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { currentDocuments, documentsHash, type Db, type BlobStore } from "@agir/db";
import { addressedText, documentKind, parseDocument, verifyReadings, READER_PROMPT, READER_PROMPT_VERSION, type ReaderResponse, type ReadingDocument } from "@agir/extraction";

const unit = z.enum(["$", "%", "sf", "m2", "$/sf", "$/m2", "months", "years", "units", "x", "vacancy_%"]);
const value = { value: z.number(), unit_seen: unit, file: z.string(), location: z.string(), quote: z.string() };
const schema = z.object({
  readings: z.array(z.object({ ...value, field: z.string(), item: z.string().nullable(), note: z.string().nullable(), confidence: z.enum(["high", "medium", "low"]) })),
  conflicts: z.array(z.object({ field: z.string(), item: z.string().nullable(), values: z.array(z.object(value)), why: z.string() })),
  not_used: z.array(z.object({ value: z.number(), file: z.string(), location: z.string(), quote: z.string(), why: z.string() })),
});
export type ReaderRequest = { model: string; max_tokens: number; inference_geo: "us"; system: string; output_config: { effort: "low"; format: ReturnType<typeof zodOutputFormat<typeof schema>> }; messages: { role: "user"; content: string }[] };
export type ReaderProvider = (request: ReaderRequest) => Promise<ReaderResponse>;
const provider: ReaderProvider = async request => {
  const reply = await new Anthropic({ timeout: 140_000, maxRetries: 0 }).messages.parse(request);
  if (!reply.parsed_output || reply.stop_reason === "max_tokens" || reply.stop_reason === "refusal") throw new Error("ReaderResponseError");
  return reply.parsed_output;
};
export { currentDocuments, documentsHash };

/** What a stored reading keeps of each document it used: the bytes stay in the blob store, so a replay parses them again. */
type DocumentRef = { id: string; name: string; sha256: string };
/** Readings stored before card C kept the parsed document itself; both shapes replay. */
type StoredDocument = DocumentRef | ReadingDocument;

/** Whether the workspace lets Agir read documents with the model (card C); on unless the owner turned it off. */
export async function aiReadingOn(db: Db, workspaceId: string) {
  const [ws] = await db.query<{ ai_reading: boolean }>(`select ai_reading from workspaces where id=$1`, [workspaceId]);
  return ws?.ai_reading ?? false;
}

/** Called after extraction commits, outside any transaction, before reconciliation. */
export async function readDeal(db: Db, store: BlobStore, dealId: string, workspaceId: string, injected?: ReaderProvider) {
  const read = injected ?? (process.env.ANTHROPIC_API_KEY ? provider : null);
  if (!read || !(await aiReadingOn(db, workspaceId))) return;
  const docs = await currentDocuments(db, dealId);
  if (docs.some(d => ["uploaded", "checking", "reading", "extracting"].includes(d.stage))) return;
  const extracted = docs.filter(d => d.stage === "extracted");
  if (!extracted.length) return;
  const hash = documentsHash(docs);
  const model = process.env.AGIR_READER_MODEL || "claude-opus-5-5";
  if ((await db.query(`select id from ai_readings where deal_id=$1 and model=$2 and prompt_version=$3 and documents_hash=$4`, [dealId, model, READER_PROMPT_VERSION, hash])).length) return;
  const documents: (ReadingDocument & { sha256: string })[] = [];
  // The owner's decision of 2026-10-24: inference stays in the United States.
  const request: ReaderRequest = { model, max_tokens: 16000, inference_geo: "us", system: READER_PROMPT, output_config: { effort: "low", format: zodOutputFormat(schema) }, messages: [{ role: "user", content: "" }] };
  let response: ReaderResponse | null = null;
  let error: { class: string; status: number | null } | null = null;
  // Parsing failures also leave a safe failure row and allow the rules to reconcile.
  try {
    for (const d of extracted) {
      const document = await parseDocument(await store.get(d.storage_key), d.name);
      if ((d.role_set ?? documentKind(document).role) === "context") continue;
      documents.push({ id: d.id, name: d.name, sha256: d.sha256, document });
    }
    if (!documents.length) return;
    request.messages[0]!.content = documents.map(d => addressedText(d.document, d.name)).join("\n\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = schema.parse(await read(request)); error = null; break; }
      catch (e) { error = { class: e instanceof Error ? e.constructor.name : "Error", status: e instanceof Anthropic.APIError ? e.status ?? null : null }; }
    }
  } catch (e) {
    error = { class: e instanceof Error ? e.constructor.name : "Error", status: e instanceof Anthropic.APIError ? e.status ?? null : null };
  }
  // Keep only which documents the boundary checked against (never their text): a replay parses the same bytes again.
  const verification = response ? { documents: documents.map(({ id, name, sha256 }) => ({ id, name, sha256 })), ...verifyReadings(response, documents) } : null;
  await db.query(`insert into ai_readings (deal_id,workspace_id,model,prompt_version,documents_hash,response,outcome,error,verification) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (deal_id, model, prompt_version, documents_hash) do nothing`, [dealId, workspaceId, model, READER_PROMPT_VERSION, hash, response && JSON.stringify(response), response ? "ok" : "failed", error && JSON.stringify(error), verification && JSON.stringify(verification)]);
}

/** No provider here: replay only the current document set and the current prompt version, and nothing while the workspace has AI reading off. */
export async function storedReadings(db: Db, store: BlobStore, dealId: string) {
  const [deal] = await db.query<{ workspace_id: string }>(`select workspace_id from deals where id=$1`, [dealId]);
  if (!deal || !(await aiReadingOn(db, deal.workspace_id))) return [];
  const docs = await currentDocuments(db, dealId);
  const [stored] = await db.query<{ id: string; response: ReaderResponse; verification: { documents: StoredDocument[] } }>(`select id,response,verification from ai_readings where deal_id=$1 and documents_hash=$2 and prompt_version=$3 and outcome='ok' order by created_at desc, id desc limit 1`, [dealId, documentsHash(docs), READER_PROMPT_VERSION]);
  if (!stored) return [];
  // A document removed or no longer extracted since the reading is left out, so its readings fail the boundary.
  const documents: ReadingDocument[] = [];
  const refs: DocumentRef[] = [];
  for (const d of stored.verification.documents) {
    const current = docs.find(c => c.id === d.id && c.name === d.name && c.stage === "extracted" && (!("sha256" in d) || c.sha256 === d.sha256));
    if (!current) continue;
    documents.push({ id: d.id, name: d.name, document: "document" in d ? d.document : await parseDocument(await store.get(current.storage_key), d.name) });
    refs.push({ id: d.id, name: d.name, sha256: current.sha256 });
  }
  const verified = verifyReadings(stored.response, documents);
  await db.query(`update ai_readings set verification=$2 where id=$1`, [stored.id, JSON.stringify({ documents: refs, ...verified })]);
  return [...verified.readings, ...verified.conflicts.flat()].flatMap(r => r.candidate ? [r.candidate] : []);
}
