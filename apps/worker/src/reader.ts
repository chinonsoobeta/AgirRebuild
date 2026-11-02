import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { currentDocuments, documentsHash, sha256Hex, type Db, type BlobStore } from "@agir/db";
import { documentKind, parseDocument, parseSavedOcr, mergeOcr, readingTexts, redactDocument, verifyReadings, type ReadingVerification, READER_PROMPT, READER_PROMPT_VERSION, type ReaderResponse, type ReadingDocument, type Redaction } from "@agir/extraction";

// Card 192: the SDK sends an enum as a description, so the API does not hold the model to the list. These stay strings here,
// so one odd label fails its own reading in verifyReading instead of throwing away the whole paid reply.
const unit = z.string().describe("One of: $, %, sf, m2, $/sf, $/m2, months, years, units, x, vacancy_%");
const value = { value: z.number(), unit_seen: unit, file: z.string(), location: z.string(), quote: z.string() };
const schema = z.object({
  readings: z.array(z.object({ ...value, field: z.string(), item: z.string().nullable(), note: z.string().nullable(), confidence: z.string().describe("One of: high, medium, low") })),
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

/** Both the first AI reading and replay use the OCR saved beside the original file. */
export async function loadDocument(store: BlobStore, storageKey: string, name: string) {
  const document = await parseDocument(await store.get(storageKey), name);
  const saved = parseSavedOcr(await store.getOcr(storageKey));
  return saved ? mergeOcr(document, saved) : document;
}

/** What a stored reading keeps of each document it used: the bytes stay in the blob store, so a replay parses them again. */
/** `sheetsLeftOut` names what a long workbook kept from the AI reader, when it kept anything. */
type DocumentRef = { id: string; name: string; sha256?: string; text_sha256?: string; sheetsLeftOut?: string[] };
/** Readings stored before card C kept the parsed document itself; both shapes replay. */
type StoredDocument = DocumentRef | ReadingDocument;
/** How many of each kind the redaction pass removed from each document, by document id (card S7); absent before it. */
type Redactions = Record<string, Redaction[]>;

/** Whether the workspace lets Agir read documents with the model (card C); on unless the owner turned it off. */
export async function aiReadingOn(db: Db, workspaceId: string) {
  const [ws] = await db.query<{ ai_reading: boolean }>(`select ai_reading from workspaces where id=$1`, [workspaceId]);
  return ws?.ai_reading ?? false;
}

/** Called after extraction commits, outside any transaction, before reconciliation. */
export async function readDeal(db: Db, store: BlobStore, dealId: string, workspaceId: string, injected?: ReaderProvider, onlyUnread = false) {
  const read = injected ?? (process.env.ANTHROPIC_API_KEY ? provider : null);
  if (!read || !(await aiReadingOn(db, workspaceId))) return;
  const docs = await currentDocuments(db, dealId);
  if (docs.some(d => ["uploaded", "checking", "reading", "extracting"].includes(d.stage))) return;
  const extracted = docs.filter(d => d.stage === "extracted");
  if (!extracted.length) return;
  const hash = documentsHash(docs);
  const model = process.env.AGIR_READER_MODEL || "claude-opus-5-5";
  // Lookups must fail the job and retry; only parsing and provider failures are safe failure rows.
  const previous = await db.query<{ id: string; model: string; prompt_version: string; documents_hash: string; verification: { documents: DocumentRef[] } }>(
    `select id,model,prompt_version,documents_hash,verification from ai_readings where deal_id=$1 and outcome='ok'`, [dealId],
  );
  // One failed reading of this exact set is enough for the jobs that settle files; a person can ask again from Review.
  if (onlyUnread && (await db.query(`select id from ai_readings where deal_id=$1 and model=$2 and prompt_version=$3 and documents_hash=$4 and outcome='failed'`, [dealId, model, READER_PROMPT_VERSION, hash])).length) return;
  const current = previous.find(r => r.model === model && r.prompt_version === READER_PROMPT_VERSION && r.documents_hash === hash);
  const documents: (ReadingDocument & { sha256: string; text: string; text_sha256: string; sheetsLeftOut: string[] })[] = [];
  const redactions: Redactions = {};
  const covers = (row: typeof previous[number], d: typeof documents[number]) => row.verification.documents.some(ref =>
    ref.id === d.id && (ref.sha256 === undefined || ref.sha256 === d.sha256) && (ref.text_sha256 === undefined || ref.text_sha256 === d.text_sha256));
  // The owner's decision of 2026-10-24: inference stays in the United States.
  const request: ReaderRequest = { model, max_tokens: 16000, inference_geo: "us", system: READER_PROMPT, output_config: { effort: "low", format: zodOutputFormat(schema) }, messages: [{ role: "user", content: "" }] };
  let response: ReaderResponse | null = null;
  let error: { class: string; status: number | null } | null = null;
  let reconcileJob: number | undefined;
  try {
    // Parsing failures also leave a safe failure row and allow the rules to reconcile.
    try {
      const loaded: (ReadingDocument & { sha256: string; asked: boolean })[] = [];
      for (const d of extracted) {
        const document = await loadDocument(store, d.storage_key, d.name);
        if ((d.role_set ?? documentKind(document).role) === "context") continue;
        const redacted = redactDocument(document);
        loaded.push({ id: d.id, name: d.name, sha256: d.sha256, document: redacted.document, asked: d.role_set != null });
        redactions[d.id] = redacted.redactions;
      }
      if (!loaded.length) return;
      const texts = readingTexts(loaded);
      loaded.forEach(({ asked: _asked, ...d }, i) => documents.push({ ...d, ...texts[i]!, text_sha256: sha256Hex(texts[i]!.text) }));
    } catch (e) {
      error = { class: e instanceof Error ? e.constructor.name : "Error", status: e instanceof Anthropic.APIError ? e.status ?? null : null };
    }
    if (!error) {
      if (onlyUnread ? documents.every(d => previous.some(r => covers(r, d))) : current && documents.every(d => covers(current, d))) return;
      request.messages[0]!.content = documents.map(d => d.text).join("\n\n");
      if (onlyUnread) {
        const [job] = await db.query<{ id: number }>(`insert into jobs(kind,payload,run_after) values('reconcile_deal',$1,now()+interval '600 seconds') returning id`, [JSON.stringify({ deal_id: dealId })]);
        reconcileJob = job!.id;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try { response = schema.parse(await read(request)); error = null; break; }
        catch (e) { error = { class: e instanceof Error ? e.constructor.name : "Error", status: e instanceof Anthropic.APIError ? e.status ?? null : null }; }
      }
    }
    // A failed wider reading must not replace a successful one at the same key.
    if (!response && current) return;
    const verification = response ? { documents: documents.map(({ id, name, sha256, text_sha256, sheetsLeftOut }) => ({ id, name, sha256, text_sha256, ...(sheetsLeftOut.length ? { sheetsLeftOut } : {}) })), redactions, ...verifyReadings(response, documents) } : null;
    await db.transaction(async tx => {
      if (response && current) await tx.query(`update ai_readings set documents_hash=$2 where id=$1`, [current.id, `${hash}:superseded:${current.id}`]);
      await tx.query(`insert into ai_readings (deal_id,workspace_id,model,prompt_version,documents_hash,response,outcome,error,verification) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (deal_id, model, prompt_version, documents_hash) do update set response=excluded.response, outcome=excluded.outcome, error=excluded.error, verification=excluded.verification, created_at=now() where ai_readings.outcome='failed'`, [dealId, workspaceId, model, READER_PROMPT_VERSION, hash, response && JSON.stringify(response), response ? "ok" : "failed", error && JSON.stringify(error), verification && JSON.stringify(verification)]);
    });
  } finally {
    if (reconcileJob !== undefined) await db.query(`update jobs set run_after=now() where id=$1 and status='queued'`, [reconcileJob]);
  }
}

/** No provider here: replay verified figures while their documents remain, unless a newer reading speaks for the field. */
export async function storedReadings(db: Db, store: BlobStore, dealId: string) {
  const [deal] = await db.query<{ workspace_id: string }>(`select workspace_id from deals where id=$1`, [dealId]);
  if (!deal || !(await aiReadingOn(db, deal.workspace_id))) return [];
  const docs = await currentDocuments(db, dealId);
  const stored = await db.query<{ id: string; current: boolean; response: ReaderResponse; verification: { documents: StoredDocument[]; redactions?: Redactions } }>(
    `select id,response,verification,(documents_hash=$2 and prompt_version=$3) as current from ai_readings where deal_id=$1 and outcome='ok' order by (documents_hash=$2 and prompt_version=$3) desc, created_at desc, id desc`,
    [dealId, documentsHash(docs), READER_PROMPT_VERSION],
  );
  const parsed = new Map<string, Awaited<ReturnType<typeof loadDocument>>>();
  const spoken = new Set<string | null>(), setAside = new Set<string>();
  const result: NonNullable<ReadingVerification["candidate"]>[] = [];
  for (const row of stored) {
    // Readings made before redaction keep their original verification boundary.
    const redacted = row.verification.redactions;
    const documents: ReadingDocument[] = [];
    const refs: DocumentRef[] = row.verification.documents.map(d => ({
      id: d.id, name: d.name,
      ...("sha256" in d ? { sha256: d.sha256 } : { sha256: docs.find(c => c.id === d.id)?.sha256 }),
      ...("text_sha256" in d ? { text_sha256: d.text_sha256 } : {}),
      ...("sheetsLeftOut" in d ? { sheetsLeftOut: d.sheetsLeftOut } : {}),
    }));
    for (const d of row.verification.documents) {
      const current = docs.find(c => c.id === d.id && c.name === d.name && c.stage === "extracted" && (!("sha256" in d) || c.sha256 === d.sha256));
      if (!current) continue;
      let document = parsed.get(d.id);
      if (!document) {
        document = "document" in d ? d.document : await loadDocument(store, current.storage_key, d.name);
        parsed.set(d.id, document);
      }
      if ((current.role_set ?? documentKind(document).role) === "context") continue;
      documents.push({ id: d.id, name: d.name, document: redacted ? redactDocument(document).document : document });
    }
    const verified = verifyReadings(row.response, documents);
    // Older rows must retain document references so a person can restore a document's role later.
    if (row.current) await db.query(`update ai_readings set verification=$2 where id=$1`, [row.id, JSON.stringify({ documents: refs, ...(redacted ? { redactions: redacted } : {}), ...verified })]);
    const candidates = [...verified.readings, ...verified.conflicts.flat()].flatMap(r => r.candidate ? [r.candidate] : []);
    result.push(...candidates.filter(c => row.current || (!spoken.has(c.fieldKey) && !setAside.has(JSON.stringify([c.documentName, c.value])))));
    for (const c of candidates) spoken.add(c.fieldKey);
    for (const r of row.response.not_used) setAside.add(JSON.stringify([r.file, r.value]));
  }
  return result;
}
