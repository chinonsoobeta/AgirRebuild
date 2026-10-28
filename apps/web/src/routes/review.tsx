import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, useId, type FormEvent, type ReactNode } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { FIELD_BY_KEY, FIELDS, tableSourceLabel, pbrhExplanation } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { api, ApiError, type Assumption, type Review as ReviewData, type Source } from "../api";
import { Banner, WindowConfirmation, canEdit, DealFrame, ErrorText, StatusTag, useDeal, useSession } from "../components/ui";
import { Notice, Tag } from "../components/kit";
import { ThresholdList, Thresholds } from "../components/thresholds";
import * as I from "../components/icons";
import { useI18n, type Lang } from "../i18n";
import "../strings/documents";
import "../strings/quickstart";
import "../strings/review";

/** A client's confirmation of a value the broker stated (card 89): its button for the client, then who confirmed it and when.
 * It is not an independent confirmation, so the value stays stated by the sponsor. */
export function ClientConfirmation({ a, isClient, meId }: { a: Assumption; isClient: boolean; meId: string }) {
  const { t, f } = useI18n();
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.post(`/assumptions/${a.id}/client-confirm`, { version: a.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["review"] }),
  });
  if (a.clientConfirmedAt) {
    const date = f.date(a.clientConfirmedAt);
    return <div>{a.clientConfirmedById === meId ? t("review.clientConfirmedYou", { date })
      : a.clientConfirmedBy ? t("review.clientConfirmedBy", { who: a.clientConfirmedBy, date }) : t("review.clientConfirmedOther", { date })}</div>;
  }
  if (!isClient || !a.sponsorStated) return null;
  return (
    <>
      <button className="btn primary sm" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{t("review.clientConfirm")}</button>
      <ErrorText error={confirm.error} />
    </>
  );
}

// A source that says which currency it is in records it at the end of unit_seen ("USD", "$/mo USD").
// It is a foreign figure, shown but never used, only when that differs from the deal's currency or the deal states none.
export const foreignIn = (s: Source, dealCurrency: string | null | undefined) => {
  const code = /(?:^|\s)(CAD|USD|AUD)$/.exec(s.unit_seen ?? "")?.[1];
  return code && code !== dealCurrency ? code : undefined;
};

export function Quote({ s, currency, fieldKey }: { s: Source; currency: string | null | undefined; fieldKey?: string }) {
  const { t, msg, L } = useI18n();
  const i = s.context.indexOf(s.raw);
  // Spans only, so a quote can sit inside a choice's label.
  return (
    <span className="quote rv-quote">
      <span>{i >= 0 ? (<>{s.context.slice(0, i)}<mark>{s.raw}</mark>{s.context.slice(i + s.raw.length)}</>) : s.context}</span>
      {fieldKey && L.verify(fieldKey) && <strong>{L.verify(fieldKey)}</strong>}
      {s.ocr && <strong>{t("review.ocr")}</strong>}
      {s.rule === "suggested" && <strong>{t("review.suggested")}</strong>}
      {s.rule === "remembered" && s.note && <strong>{msg(s.note)}</strong>}
      {s.check_note && <span className={s.check_outcome === "questions" ? "src rv-question" : "src"}>{msg(s.check_note)}</span>}
      <span className="src"><I.Doc /> {s.document_name} · {msg(s.location)}</span>
      {(s.unit_seen?.startsWith("m2") || s.unit_seen?.startsWith("$/m2")) && <span className="src">{t("review.fromM2")}</span>}
      {foreignIn(s, currency) && <span className="src">{t("review.statedIn", { code: foreignIn(s, currency) })}</span>}
    </span>
  );
}

/** Card D1: a value's sources, each distinct quote (file, place, sentence and figure) once; the rules and the AI reader can both cite the same line. */
export function distinctSources<S extends Pick<Source, "document_id" | "location" | "context" | "raw">>(sources: S[]): S[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = [s.document_id, s.location, s.context, s.raw].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const metricUnit = (unit: string) => unit === "sf" || unit === "$/sf/yr";

/** A value typed in square metres becomes square feet (rent per m² becomes rent per sf) before it is posted, and the reason records what was typed. */
/** A document value no document states any more (card 63): kept only as the person's own value, with a reason, and never by Approve all. */
export const keepsWithReason = (a: Pick<Assumption, "sourceKind" | "sources">) => a.sourceKind === "document" && a.sources.length === 0;
export const approvable = <A extends Pick<Assumption, "fieldKey" | "sourceKind" | "sources">>(rows: A[]) => rows.filter((a) => !keepsWithReason(a) && !a.sources.some((s) => s.ocr || s.check_outcome === "questions") && !(a.sourceKind === "document" && FIELD_BY_KEY.get(a.fieldKey)?.verify));

export function enteredInUnit(unit: string, metric: boolean, value: number, reason: string, lang: Lang): { value: number; reason: string } {
  if (!metric || !metricUnit(unit)) return { value, reason };
  const typed = lang === "fr" ? String(value).replace(".", ",") : String(value);
  const label = unit === "sf" ? "m²" : lang === "fr" ? "$/m²/an" : "$/m²/yr";
  return { value: unit === "sf" ? value * SF_PER_M2 : value / SF_PER_M2, reason: `${reason} (${lang === "fr" ? "saisi en" : "entered as"} ${typed}${lang === "fr" ? "\u00a0" : " "}${label})` };
}

/** Card C2: in a percent or other non-dollar field a lone comma is a decimal point ("12,5" is 12.5);
 * a dollar field, and "1,200" in a count or an area, keep it as a thousands group. */
export function decimalComma(raw: FormDataEntryValue | null, unit: string): string {
  const s = String(raw ?? "").trim();
  if (unit.startsWith("$") || !/^[^,.]*,[^,.]*$/.test(s)) return s;
  return unit === "%" || !/,\d{3}\D*$/.test(s) ? s.replace(",", ".") : s;
}

/** Card C2: the field's hard limits from the contract, checked before anything is posted, so an impossible value is never offered "Use this value". */
export function hardLimit(fieldKey: string, value: number): { kind: "min" | "max"; bound: number } | { kind: "whole" } | null {
  const d = FIELD_BY_KEY.get(fieldKey);
  if (!d) return null;
  if (d.min !== undefined && value < d.min) return { kind: "min", bound: d.min };
  if (d.max !== undefined && value > d.max) return { kind: "max", bound: d.max };
  if (d.integer && !Number.isInteger(value)) return { kind: "whole" };
  return null;
}

/** The figures a deal's documents gave but Agir did not use, one row per sentence (card C2): the same sentence read twice, or the
 * same number in it read twice, shows once. */
export function groupOther<O extends { documentId: string; context: string; raw: string; label: unknown }>(other: O[]): O[][] {
  const groups = new Map<string, O[]>();
  for (const o of other) {
    const key = `${o.documentId}\u0000${o.context}`;
    const rows = groups.get(key) ?? [];
    const twin = rows.findIndex((x) => x.raw === o.raw);
    if (twin < 0) rows.push(o);
    else if (o.label && !rows[twin]!.label) rows[twin] = o;
    groups.set(key, rows);
  }
  return [...groups.values()];
}

/** Each number of a sentence marked where it stands, not inside a longer number. */
function marked(context: string, raws: string[]): ReactNode[] {
  const spans: [number, number][] = [];
  for (const raw of new Set(raws.filter(Boolean))) {
    for (let i = context.indexOf(raw); i >= 0; i = context.indexOf(raw, i + 1)) {
      const before = context[i - 1] ?? "", after = context[i + raw.length] ?? "";
      if (/\d/.test(before) || /\d/.test(after) || spans.some(([s, e]) => i < e && i + raw.length > s)) continue;
      spans.push([i, i + raw.length]);
      break;
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach(([s, e], n) => { out.push(context.slice(at, s), <mark key={n}>{context.slice(s, e)}</mark>); at = e; });
  out.push(context.slice(at));
  return out;
}

const LOOKS_LIKE = /^Looks like (.+), but the number is not written as /;
/** A one-click label is offered only when it agrees with what the note says the figure looks like (card C2): a heading line's
 * "12 rental units" that looks like hard costs is not offered as a construction period. */
export function offeredLabels(o: { note: string | null; suggestions: string[] }): string[] {
  const named = LOOKS_LIKE.exec(o.note ?? "")?.[1];
  if (!named) return o.suggestions;
  const d = FIELDS.find((x) => x.label.toLowerCase() === named.toLowerCase());
  return d && o.suggestions.includes(d.key) ? o.suggestions : [];
}

// A municipality's own land transfer tax row, matched against the deal's location as typed.
const CITY_ROWS: Record<string, RegExp> = { "quebec-city": /^(ville de )?quebec( city)?$/, montreal: /montreal/, toronto: /toronto/, "toronto-homes": /toronto/ };
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
/** Card C2: the land transfer tax options for where the deal is. A municipality with its own row gets that row first; any other
 * (Gatineau, Laval, Ottawa) gets only the province-wide rule. In Nova Scotia, the municipality named in the location comes first.
 * `matched` is false when nothing tells which option applies. */
export function landOptions<O extends { key: string; label: string }>(options: O[], location: string | null | undefined): { options: O[]; matched: boolean } {
  const parts = (location ?? "").split(",").map(fold).filter(Boolean);
  // The last part of "Gatineau, QC" names the province, not the city.
  const places = parts.length > 1 ? parts.slice(0, -1) : parts;
  if (options.length > 0 && options.every((o) => o.key.startsWith("ns-"))) {
    const named = options.filter((o) => places.some((p) => p.length >= 4 && fold(o.label).includes(p)));
    return named.length ? { options: [...named, ...options.filter((o) => !named.includes(o))], matched: true } : { options, matched: false };
  }
  const general = options.filter((o) => !CITY_ROWS[o.key]);
  const local = options.filter((o) => CITY_ROWS[o.key] && places.some((p) => CITY_ROWS[o.key]!.test(p)));
  return { options: local.length ? [...local, ...general] : general.length ? general : options, matched: true };
}
const trimCents = (s: string) => s.replace(/([.,])00(?!\d)/, "");

function ValueInput({ unit, id, defaultValue, label, prefix = "" }: { unit: string; id: string; defaultValue?: number | null; label: string; prefix?: string }) {
  const { t, f, lang } = useI18n();
  const [metric, setMetric] = useState(false);
  const suffix = f.suffix(unit);
  // A flag is a choice, not a number: yes posts 1 and no posts 0, with neither chosen to start.
  if (unit === "flag") {
    return (
      <div className="row rv-flag" role="radiogroup" id={id} aria-label={label}>
        {([["1", "common.yes"], ["0", "common.no"]] as const).map(([v, k]) => (
          <label key={v} className="row rv-radio"><input type="radio" name="value" value={v} required />{t(k)}</label>
        ))}
      </div>
    );
  }
  const shown = metric || defaultValue === null || defaultValue === undefined ? "" : lang === "fr" ? String(defaultValue).replace(".", ",") : String(defaultValue);
  return (
    <div className="rv-affix">
      {unit === "$" && lang === "en" && <span>$</span>}
      <input id={id} key={String(metric)} name={`${prefix}value`} inputMode="decimal" defaultValue={shown} required autoComplete="off" />
      {metricUnit(unit) ? (
        <select name={`${prefix}unit`} aria-label={lang === "fr" ? "Unité" : "Unit"} value={metric ? "m2" : "sf"} onChange={(e) => setMetric(e.target.value === "m2")}>
          <option value="sf">{suffix}</option>
          <option value="m2">{unit === "sf" ? "m²" : lang === "fr" ? "$/m²/an" : "$/m²/yr"}</option>
        </select>
      ) : suffix && (unit !== "$" || lang === "fr") && <span>{suffix}</span>}
    </div>
  );
}

const LABELLABLE = FIELDS.filter((x) => x.extractable);

/** A person's label for a figure Agir did not use: the field and, for an itemized field, the item. */
function UseAs({ o, items, onSave, busy }: { o: ReviewData["other"][number]; items: string[]; onSave: (b: { documentId: string; figureId: string; fieldKey: string; itemKey?: string }) => void; busy: boolean }) {
  const { t, L } = useI18n();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const def = LABELLABLE.find((x) => x.key === key);
  if (!open) return <div><button className="btn quiet sm" type="button" onClick={() => setOpen(true)}>{t("review.useAs")}</button></div>;
  const list = `items-${o.figureId}`;
  return (
    <form
      className="stack tight"
      onSubmit={(e) => {
        e.preventDefault();
        const item = String(new FormData(e.currentTarget).get("item") ?? "").trim();
        onSave({ documentId: o.documentId, figureId: o.figureId!, fieldKey: key, ...(def?.itemized ? { itemKey: item } : {}) });
      }}
    >
      <select className="select" aria-label={t("review.useAsField")} value={key} onChange={(e) => setKey(e.target.value)} required>
        <option value="">{t("review.useAsPick")}</option>
        {[...new Set(LABELLABLE.map((x) => x.group))].map((g) => (
          <optgroup key={g} label={L.group(g)}>{LABELLABLE.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{L.field(x.key)}</option>)}</optgroup>
        ))}
      </select>
      {def?.itemized && (
        <>
          <input className="input" name="item" list={list} aria-label={t("review.useAsItem")} placeholder={t("review.useAsItem")} required autoComplete="off" />
          <datalist id={list}>{items.map((i) => <option key={i} value={i} />)}</datalist>
        </>
      )}
      <div className="row"><button className="btn primary sm" type="submit" disabled={!key || busy}>{t("common.save")}</button><button className="btn quiet sm" type="button" onClick={() => setOpen(false)}>{t("common.cancel")}</button></div>
    </form>
  );
}

/** The same proposed-value controls in Not found and Choices. Acceptance uses the existing entry mutation. */
export function TableProposal({ proposal: given, unit, onUse, busy, location }: { proposal: import("@agir/contracts").Proposal; unit: string; onUse: (b: {fieldKey: string; tableId: string; optionKey: string}) => void; busy: boolean; location?: string | null }) {
  const { t, f, msg, lang, L } = useI18n();
  const { role } = useSession();
  const land = given.fieldKey === "land_transfer_tax";
  const local = land ? landOptions(given.options, location) : { options: given.options, matched: false };
  const proposal = { ...given, options: local.options };
  const [selected,setSelected] = useState(proposal.options.length === 1 || (land && local.matched) ? "0" : "");
  const [infoOpen,setInfoOpen] = useState(false);
  const infoId = useId();
  if (proposal.unavailable) {
    // Some of these come from the API in lower case; French already gives each as a sentence.
    // Card D1: the reason names its own field, so it reads as part of that row and never as a stray line between rows.
    const sentence = msg(proposal.unavailable);
    const said = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    return <p className="small muted rv-unavailable">{t("review.notProposed", { field: L.field(proposal.fieldKey) })} {/[.!?]$/.test(said) ? said : `${said}.`}</p>;
  }
  const option = selected === "" ? undefined : proposal.options[Number(selected)];
  const amount = (n: number) => unit === "$" ? new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA",{style:"currency",currency:"CAD",currencyDisplay:"narrowSymbol",minimumFractionDigits:2,maximumFractionDigits:2}).format(n) : f.value(n,unit);
  const source = <a href={proposal.url} target="_blank" rel="noreferrer">{t("review.proposalSource")}</a>;
  // Card C2: the land transfer tax is optional and says what skipping it does; nothing shows an empty amount.
  const head = land
    ? <><div>{option ? t(CITY_ROWS[option.key] ? "review.lttCity" : "review.ltt", { v: amount(option.value), place: msg(option.label.split(" — ")[0]!) }) : t("review.lttChoose")}</div>
      <div className="muted">{t("review.proposalBasis", { title: proposal.title, publisher: proposal.publisher, date: proposal.effective })}{" "}{source}</div></>
    : <div>{option ? t("review.proposed",{value:amount(option.value),publisher:proposal.publisher,date:proposal.effective}) : t("review.proposedBy",{publisher:proposal.publisher,date:proposal.effective})}{" "}{source}</div>;
  return <div className="stack tight small">
    {head}
    {/* The rebate's reason sits beside its label, not on a line of its own. */}
    {(() => {
      const pbrh = proposal.tableId === "gst-hst-pbrh" && option?.key === "pbrh";
      const info = pbrh ? <button type="button" className="iconbtn info-inline" aria-label={msg("Why GST/HST net is $0")} aria-expanded={infoOpen} aria-controls={infoId}
        onMouseEnter={()=>setInfoOpen(true)} onMouseLeave={()=>setInfoOpen(false)} onFocus={()=>setInfoOpen(true)} onBlur={()=>setInfoOpen(false)}
        onClick={()=>setInfoOpen(true)} onKeyDown={e=>{if (e.key === "Escape") setInfoOpen(false);}}><I.Info size={16} /></button> : null;
      return <>
        {proposal.options.length > 1 ? <div className="proposal-pick"><select className="select" aria-label={t("review.proposalOption")} value={selected} onChange={e=>setSelected(e.target.value)}>
          <option value="">{t("review.proposalPlaceholder")}</option>
          {proposal.options.map((o,index)=><option key={index} value={index}>{o.label.split(" — ").map(msg).join(" — ")} — {amount(o.value)}</option>)}
        </select>{info}</div> : <span>{option?.label.split(" — ").map(msg).join(" — ")}{info && " "}{info}</span>}
        {pbrh && <span id={infoId} hidden={!infoOpen}>{pbrhExplanation(proposal.readOn,lang)}</span>}
      </>;
    })()}
    {canEdit(role) && <div><button className="btn quiet sm" type="button" disabled={busy || !option} onClick={()=>option && onUse({fieldKey:proposal.fieldKey,tableId:proposal.tableId,optionKey:option.key})}>{t(land ? "review.lttAdd" : "review.useProposal")}</button></div>}
  </div>;
}

export function Review({ dealId }: { dealId: string }) {
  const { t, f, L, msg, lang } = useI18n();
  const { me, role, solo } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const dealCurrency = deal.data?.deal.currency;
  const review = useQuery({ queryKey: ["review", dealId], queryFn: () => api.get<ReviewData>(`/deals/${dealId}/review`) });
  // The worker reconciles a moment after a label, an Undo or a retired document; when it has, the review is read again.
  const updating = deal.data?.updating ?? false;
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (wasUpdating.current && !updating) void qc.invalidateQueries({ queryKey: ["review", dealId] });
    wasUpdating.current = updating;
  }, [updating, qc, dealId]);
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<string | null>(null);
  const [aiEntry, setAiEntry] = useState<{ id: string; value: number; field: string; item: string } | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  // A form's own error shows in that form (card C2), keyed by the form.
  const [formError, setFormErrorAt] = useState<{ at: string; error: unknown } | null>(null);
  const errAt = (at: string) => (formError?.at === at ? formError.error : null);
  // Card C2: a 409 shows on its row, and says "in another tab" when the person who changed the value is the one looking.
  const [stale, setStale] = useState<{ id: string; mine: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [bulkDone, setBulkDone] = useState<{ n: number; held: string[] } | null>(null);
  const sending = useRef(false);
  const [glossOpen, setGlossOpen] = useState(false);
  const [thresholdsOpen, setThresholdsOpen] = useState(() => typeof window !== "undefined" && window.location?.hash === "#thresholds");
  // Card C2: a half-typed edit is not lost to Back, Forward or a link without a word.
  const [dirty, setDirty] = useState(false);
  // The deal first: if it says no reconcile is waiting, the review read after it is already current; if one is, the effect above reads it again when it is done.
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["deal", dealId] });
    await qc.invalidateQueries({ queryKey: ["review", dealId] });
  };
  const act = useMutation({
    mutationFn: (b: { id: string; action: string; value?: number | null; reason?: string | null; version?: number; confirmOutsideWindow?: boolean }) => api.post(`/assumptions/${b.id}/review`, b),
    onSuccess: () => {
      setEditing(null);
      setDirty(false);
      setStale(null);
      setBulkDone(null);
      return refresh();
    },
    onError: (error, b) => {
      if (!(error instanceof ApiError && error.status === 409)) return;
      setStale({ id: b.id, mine: false });
      // Who changed it: the review read again for that one fact, leaving the one on screen as it is until Reload.
      void api.get<ReviewData>(`/deals/${dealId}/review`).then((fresh) => {
        if (fresh.assumptions.find((x) => x.id === b.id)?.decidedById === me.user.id) setStale({ id: b.id, mine: true });
      }).catch(() => {});
    },
  });
  const reload = () => { setStale(null); act.reset(); void refresh(); };
  const confirmRegion = useMutation({
    mutationFn: (group: ReviewData["regions"][number]) => api.post(`/deals/${dealId}/regions/confirm`, { documentId: group.documentId, source: group.source, table: group.table }),
    onSuccess: () => refresh(),
  });
  const acceptTable = useMutation({
    mutationFn: (b: {fieldKey:string;tableId:string;optionKey:string}) => api.post(`/deals/${dealId}/proposals/accept`,b),
    onSuccess: () => refresh(),
  });
  const enter = useMutation({
    mutationFn: (b: { fieldKey: string; itemKey?: string | null; value: number; reason: string; confirmOutsideWindow?: boolean }) => api.post(`/deals/${dealId}/values`, b),
    onSuccess: () => {
      setEntering(null);
      setAiEntry(null);
      setDirty(false);
      return refresh();
    },
  });
  const [adding, setAdding] = useState(false);
  const [perSf, setPerSf] = useState(false);
  const addItem = useMutation({
    mutationFn: (b: Record<string, string | number | boolean>) => api.post(`/deals/${dealId}/items`, b),
    onSuccess: () => {
      setAdding(false);
      setDirty(false);
      return refresh();
    },
  });
  const [otherOpen, setOtherOpen] = useState(false);
  const label = useMutation({
    mutationFn: (b: { documentId: string; figureId: string; fieldKey: string; itemKey?: string }) => api.post(`/deals/${dealId}/figure-labels`, b),
    onSuccess: () => refresh(),
  });
  const unlabel = useMutation({
    mutationFn: (b: { documentId: string; figureId: string }) => api.del(`/deals/${dealId}/figure-labels`, b),
    onSuccess: () => refresh(),
  });
  const defaults = useMutation({ mutationFn: (fields: string[]) => api.post(`/deals/${dealId}/defaults`, { fields }), onSuccess: () => refresh() });
  const bulk = useMutation({
    mutationFn: async (items: Assumption[]) => {
      for (const a of items) {
        await api.post(`/assumptions/${a.id}/review`, { action: "approve", version: a.version });
        // Card D1: each row moves to Approved as its approval returns; the review is read again once all are done.
        qc.setQueryData<ReviewData>(["review", dealId], (old) => old && { ...old, assumptions: old.assumptions.map((x) => (x.id === a.id ? { ...x, status: "approved" } : x)) });
      }
    },
    onSuccess: () => refresh(),
  });
  const [showAll, setShowAll] = useState(false);
  const formOpen = !!(editing || keeping || entering || adding || aiEntry);
  useEffect(() => { if (!formOpen) setDirty(false); }, [formOpen]);
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: () => dirty, disabled: !dirty, withResolver: true });
  // Card D1: when the person's own approval clears the review far down the page, "Review is clear / Go to Run" is brought into view.
  const topCard = useRef<HTMLDivElement>(null);
  const readiness = review.data?.readiness.status;
  const wasReadiness = useRef(readiness);
  const acting = act.isPending || bulk.isPending || enter.isPending || defaults.isPending || acceptTable.isPending || confirmRegion.isPending || addItem.isPending;
  const actedAt = useRef(0);
  if (acting) actedAt.current = Date.now();
  useEffect(() => {
    const before = wasReadiness.current;
    wasReadiness.current = readiness;
    if (before !== "blocked" || readiness !== "ready" || Date.now() - actedAt.current > 10_000) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    topCard.current?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [readiness]);

  if (!deal.data || !review.data) return <p className="muted">{t("common.loading")}</p>;
  const r = review.data;
  const editable = canEdit(role);
  const name = (a: { fieldKey: string; itemKey?: string | null }) =>
    a.fieldKey === "unit_count" && !a.itemKey && !("id" in a) ? t("review.revenueProgram") : L.field(a.fieldKey, a.itemKey);
  const by = (st: string) => r.assumptions.filter((a) => a.status === st);
  // Values keep the order of the to-do list, so the page reads in the order the list gives.
  const todoAt = (id: string) => { const i = r.todo.items.findIndex((item) => item.assumptionId === id); return i < 0 ? Infinity : i; };
  const inTodoOrder = (rows: Assumption[]) => [...rows].sort((x, y) => todoAt(x.id) - todoAt(y.id));
  const conflicts = inTodoOrder(by("conflicting"));
  const pending = inTodoOrder(by("needs_review"));
  const awaiting = by("awaiting_second_approval");
  const approved = r.assumptions.filter((a) => a.status === "approved" || a.status === "default_accepted");
  const stated = approved.filter((a) => a.sponsorStated).length;
  const rejected = by("rejected");
  // A choice, once made, is an approved value; it is listed again under the choices. The test is readiness's own for
  // a choice: an optional, single field no document is read for, whose absence has a stated meaning.
  const madeChoices = approved.filter((a) => {
    const d = FIELD_BY_KEY.get(a.fieldKey);
    return !!d && d.extractable === false && !d.itemized && d.required === false && !!d.absentMeans;
  });
  const focused = pending.find((a) => a.id === focus) ?? pending[0];
  const unused = r.other.filter((o) => o.figureId && o.value !== null && !o.label).length;
  const itemNames = [...new Set(r.assumptions.map((a) => a.itemKey).filter((i): i is string => !!i))];
  const plainPending = pending.filter(a => r.todo.items.some(item => item.kind === "needs_review" && item.assumptionId === a.id));
  const docsBusy = deal.data.documents.processing > 0;
  const summary: string[] = t("review.summary", { c: conflicts.length, m: r.missing.length, r: pending.length + awaiting.length, a: approved.length });
  const materialNote = <p className="small muted row rv-note"><I.Lock />{t(solo ? "review.materialNoteSolo" : "review.materialNote")}</p>;
  /** A value typed in a form: a decimal comma read as a point, a non-number refused, and the hard limits checked before anything is posted. */
  const readValue = (fd: FormData, fieldKey: string, unit: string, prefix = "") => {
    const n = f.parse(decimalComma(fd.get(`${prefix}value`), unit));
    const p = hardLimit(fieldKey, enteredInUnit(unit, fd.get(`${prefix}unit`) === "m2", n, "", lang).value);
    if (p) throw new Error(p.kind === "whole" ? t("review.errWhole") : t(p.kind === "min" ? "review.errMin" : "review.errMax", { v: f.value(p.bound, unit) }));
    return n;
  };
  const termLink = (k: GlossKey | undefined) => k && (
    <a className="rv-term" href={`#term-${k}`} onClick={() => setGlossOpen(true)} aria-label={t("review.termLink", { term: t(`terms.rv.${k}`)[0] })}>?</a>
  );
  const materialLink = <a className="sub rv-material" href="#term-material" onClick={() => setGlossOpen(true)}>{t("common.material")}</a>;
  const keepForm = (a: Assumption) => (
    <form
      className="stack tight"
      onChange={() => setDirty(true)}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        act.mutate({ id: a.id, action: "approve", reason: String(new FormData(e.currentTarget).get("reason")).trim(), version: a.version });
        setKeeping(null);
      }}
    >
      <p className="small muted">{t("review.keepHint")}</p>
      <div className="field"><label htmlFor={`k-${a.id}`}>{t("review.why")}</label><input className="input" id={`k-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      {a.material && materialNote}
      <div className="row"><button className="btn primary sm" type="submit">{t("review.keep").replace("…", "")}</button><button className="btn quiet sm" type="button" onClick={() => setKeeping(null)}>{t("common.cancel")}</button></div>
    </form>
  );
  const modifyForm = (a: Assumption) => (
    <form
      className="stack tight"
      onChange={() => { setDirty(true); if (!act.isPending) act.reset(); }}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setFormErrorAt(null);
        const fd = new FormData(e.currentTarget);
        try {
          const e = enteredInUnit(a.unit, fd.get("unit") === "m2", readValue(fd, a.fieldKey, a.unit), String(fd.get("reason")), lang);
          act.mutate({ id: a.id, action: "modify", ...e, version: a.version });
        } catch (err) {
          setFormErrorAt({ at: `v-${a.id}`, error: err });
        }
      }}
    >
      <div className="grid2 rv-entry">
        <div className="field"><label htmlFor={`v-${a.id}`}>{t("review.differentValue")}</label><ValueInput unit={a.unit} id={`v-${a.id}`} defaultValue={a.value} label={t("review.differentValue")} /></div>
        <div className="field"><label htmlFor={`r-${a.id}`}>{t("review.why")}</label><input className="input" id={`r-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      </div>
      {a.material && materialNote}
      <ErrorText error={errAt(`v-${a.id}`) ?? (act.variables?.id === a.id && !stale ? act.error : null)} />
      <WindowConfirmation error={act.variables?.id === a.id ? act.error : null} busy={act.isPending} onConfirm={() => act.variables && act.mutate({...act.variables, confirmOutsideWindow: true})} />
      <div className="row"><button className="btn primary sm" type="submit">{t("review.saveValue")}</button><button className="btn quiet sm" type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button></div>
    </form>
  );

  // The form that enters a value for a field no document gave: a missing input, or a line that was not found.
  const entryForm = (m: { fieldKey: string; itemKey?: string | null; unit: string; label: string }, id: string, head: ReactNode, defaultValue?: number) => (
    <form
      key={id}
      className="stack tight"
      onChange={() => { setDirty(true); if (!enter.isPending) enter.reset(); }}
      onSubmit={(e) => {
        e.preventDefault();
        setFormErrorAt(null);
        const fd = new FormData(e.currentTarget);
        try {
          enter.mutate({ fieldKey: m.fieldKey, itemKey: m.itemKey ?? null, ...enteredInUnit(m.unit, fd.get("unit") === "m2", readValue(fd, m.fieldKey, m.unit), String(fd.get("reason")), lang) });
        } catch (err) {
          setFormErrorAt({ at: id, error: err });
        }
      }}
    >
      {head}
      <ErrorText error={errAt(id) ?? (enter.variables?.fieldKey === m.fieldKey && enter.variables?.itemKey === (m.itemKey ?? null) ? enter.error : null)} />
      <WindowConfirmation error={enter.variables?.fieldKey === m.fieldKey && enter.variables?.itemKey === (m.itemKey ?? null) ? enter.error : null} busy={enter.isPending} onConfirm={() => enter.variables && enter.mutate({...enter.variables, confirmOutsideWindow: true})} />
      {editable && (
        <>
          <div className="grid2 rv-entry">
            <div className="field">
              {m.unit === "flag" ? <span className="label">{name(m)}</span> : <label htmlFor={id}>{t("review.col.value")}<span className="sr-only">{`, ${name(m)}`}</span></label>}
              <ValueInput unit={m.unit} id={id} label={name(m)} defaultValue={defaultValue} />
            </div>
            <div className="field"><label htmlFor={`${id}-why`}>{t("review.whyHint")}</label><input className="input" id={`${id}-why`} name="reason" placeholder={t("review.sourceHint")} minLength={10} required /></div>
          </div>
          <div className="row"><button className="btn primary" type="submit">{t("review.saveValue")}</button></div>
        </>
      )}
    </form>
  );

  const aiEntryControl = (id: string, value: number) => editable && <>
    <div><button className="btn quiet sm" type="button" onClick={() => { setAiEntry({ id, value, field: "", item: "" }); enter.reset(); setFormErrorAt(null); }}>{t("review.aiEnter")}</button></div>
    {aiEntry?.id === id && <div className="stack tight">
      <select className="select" aria-label={t("review.col.input")} value={aiEntry.field} onChange={e => setAiEntry({ ...aiEntry, field: e.target.value, item: "" })}>
        <option value="">{t("review.useAs")}</option>
        {LABELLABLE.map(field => <option key={field.key} value={field.key}>{L.field(field.key)}</option>)}
      </select>
      {(() => {
        const field = FIELD_BY_KEY.get(aiEntry.field);
        if (!field) return null;
        const item = aiEntry.item;
        return <>
          {field.itemized && <input className="input" aria-label={t("review.col.input")} value={item} onChange={e => setAiEntry({ ...aiEntry, item: e.target.value })} list="ai-entry-items" />}
          <datalist id="ai-entry-items">{itemNames.map(item => <option key={item} value={item} />)}</datalist>
          {(!field.itemized || item.trim()) && entryForm({ fieldKey: field.key, itemKey: field.itemized ? item.trim() : null, unit: field.unit, label: field.label }, `ai-${aiEntry.id}-${field.key}-${item}`, <span>{L.field(field.key, item || null)}</span>, aiEntry.value)}
        </>;
      })()}
    </div>}
  </>;
  // A unit type or space no document states: one request enters every value, so it is added whole or not at all.
  const addItemForm = () => (
    <form
      className="card card-pad stack tight"
      onChange={() => { setDirty(true); if (!addItem.isPending) addItem.reset(); }}
      onSubmit={(e) => {
        e.preventDefault();
        setFormErrorAt(null);
        const fd = new FormData(e.currentTarget);
        try {
          const itemName = String(fd.get("name") ?? "").trim();
          if (!itemName) throw new Error(t("qs.errName"));
          if (itemName.includes("|")) throw new Error(t("qs.errPipe"));
          const reason = String(fd.get("reason") ?? "").trim();
          if (reason.length < 10) throw new Error(t("qs.errReason"));
          const num = (k: string, unit: string) => f.parse(decimalComma(fd.get(k), unit));
          const occ = String(fd.get("occ-value") ?? "").trim();
          const body: Record<string, string | number> = { name: itemName, reason, ...(occ ? { occupancyPct: num("occ-value", "%") } : {}) };
          if (perSf) {
            const area = enteredInUnit("sf", fd.get("area-unit") === "m2", num("area-value", "sf"), reason, lang);
            const rent = enteredInUnit("$/sf/yr", fd.get("psf-unit") === "m2", num("psf-value", "$/sf/yr"), area.reason, lang);
            Object.assign(body, { areaSf: area.value, rentPsfAnnual: rent.value, reason: rent.reason });
          } else {
            Object.assign(body, { unitCount: num("count-value", "units"), rentMonthly: num("rent-value", "$/unit/mo") });
          }
          addItem.mutate(body);
        } catch (err) {
          setFormErrorAt({ at: "add", error: err });
        }
      }}
    >
      <div className="field"><label htmlFor="add-name">{t("review.addItemName")}</label><input className="input" id="add-name" name="name" maxLength={60} autoComplete="off" required /></div>
      <div className="row" role="radiogroup" aria-label={t("review.addItem")}>
        <label className="row rv-radio"><input type="radio" name="basis" checked={!perSf} onChange={() => setPerSf(false)} />{t("review.addItemPerUnit")}</label>
        <label className="row rv-radio"><input type="radio" name="basis" checked={perSf} onChange={() => setPerSf(true)} />{t("review.addItemPerSf")}</label>
      </div>
      <div className="grid2 rv-entry" key={String(perSf)}>
        {perSf ? (
          <>
            <div className="field"><label htmlFor="add-area">{L.field("rentable_area_sf")}</label><ValueInput unit="sf" id="add-area" label={L.field("rentable_area_sf")} prefix="area-" /></div>
            <div className="field"><label htmlFor="add-psf">{L.field("rent_psf_annual")}</label><ValueInput unit="$/sf/yr" id="add-psf" label={L.field("rent_psf_annual")} prefix="psf-" /></div>
          </>
        ) : (
          <>
            <div className="field"><label htmlFor="add-count">{t("qs.unitCount")}</label><ValueInput unit="units" id="add-count" label={t("qs.unitCount")} prefix="count-" /></div>
            <div className="field"><label htmlFor="add-rent">{t("qs.unitRent")}</label><ValueInput unit="$/unit/mo" id="add-rent" label={t("qs.unitRent")} prefix="rent-" /></div>
          </>
        )}
      </div>
      <div className="field">
        <label htmlFor="add-occ">{`${L.field("item_occupancy_pct")} (${t("qs.optional")})`}</label>
        <div className="rv-affix"><input id="add-occ" name="occ-value" inputMode="decimal" autoComplete="off" /><span>{f.suffix("%")}</span></div>
      </div>
      <div className="field"><label htmlFor="add-why">{t("review.why")}</label><input className="input" id="add-why" name="reason" placeholder={t("review.sourceHint")} minLength={10} required /></div>
      <div className="row">
        <button className="btn primary sm" type="submit" disabled={addItem.isPending}>{t("common.save")}</button>
        <button className="btn quiet sm" type="button" onClick={() => { setAdding(false); setFormErrorAt(null); }}>{t("common.cancel")}</button>
      </div>
      <ErrorText error={errAt("add") ?? addItem.error} />
      <WindowConfirmation error={addItem.error} busy={addItem.isPending} onConfirm={() => addItem.variables && addItem.mutate({...addItem.variables, confirmOutsideWindow: true})} />
    </form>
  );

  const conflictItem = (a: Assumption) => {
    const choice = picked[a.id];
    const vals = (a.conflictValues ?? []).map((x) => x.value);
    return (
      <fieldset key={`conflict-${a.id}`} className="card rv-fieldset">
        <legend className="sr-only">{name(a)}</legend>
        <div className="card-head">
          <div><h3 className="h3">{name(a)}{termLink(termOf(a.fieldKey))}</h3><span className="small muted">{a.material ? `${t("common.material")} · ` : ""}{t("review.conflictFigures", { n: vals.length })}</span></div>
          <StatusTag tone="stop" glyph={I.Conflict}>{t("review.conflicting")}</StatusTag>
        </div>
        <div className="card-pad stack tight">
          {a.sources.some((s) => foreignIn(s, dealCurrency)) && a.reason && (
            // A figure in another currency is never a choice: say why, show it, and leave the amount to be entered.
            <div className="stack tight">
              <p>{msg(a.reason)}</p>
              {distinctSources(a.sources.filter((s) => foreignIn(s, dealCurrency))).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)}
            </div>
          )}
          {(a.conflictValues ?? []).map((v) => {
            const conservative = a.conservative && v.value === (a.conservative === "max" ? Math.max(...vals) : Math.min(...vals));
            return (
              <label key={v.value} className={choice === v.value ? "choice on" : "choice"}>
                <input type="radio" name={`c-${a.id}`} checked={choice === v.value} onChange={() => setPicked({ ...picked, [a.id]: v.value })} disabled={!editable} />
                <span className="rv-grow">
                  <span className="t num">{f.value(v.value, a.unit)}{conservative && <span className="muted">{t("review.conservative")}</span>}</span>
                  <span className="d">{v.documents.map((d) => msg(d)).join(", ")}</span>
                  {distinctSources(a.sources.filter((s) => !foreignIn(s, dealCurrency) && Math.abs(s.value - v.value) < 0.5)).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)}
                </span>
              </label>
            );
          })}
          {vals.length > 0 && <p className="small muted">{t("review.choosingNote", { material: a.material })}</p>}
          {editing === a.id ? modifyForm(a) : editable && (
            <div className="row">
              {vals.length > 0 && <button className="btn primary" type="button" disabled={choice === undefined || act.isPending} onClick={() => act.mutate({ id: a.id, action: "resolve", value: choice!, version: a.version })}>
                {choice === undefined ? t("review.choose") : t("review.resolveWith", { v: f.value(choice, a.unit) })}
              </button>}
              <button className={vals.length > 0 ? "btn ghost" : "btn primary"} type="button" onClick={() => setEditing(a.id)}>{t("review.enterDifferent")}</button>
            </div>
          )}
          <WindowConfirmation error={act.variables?.action === "resolve" && act.variables.id === a.id ? act.error : null} busy={act.isPending} onConfirm={() => act.variables && act.mutate({...act.variables, confirmOutsideWindow: true})} />
        </div>
      </fieldset>
    );
  };
  const awaitingItem = (a: Assumption) => {
    const mine = a.decidedById === me.user.id;
    return (
      <div key={`awaiting-${a.id}`} className="card card-pad stack tight">
        <div className="row between"><h3 className="h3">{name(a)}</h3><StatusTag tone="review" glyph={I.Lock}>{t("review.awaiting")}</StatusTag></div>
        <p>
          <span className="num rv-big">{f.value(a.pendingValue, a.unit)}</span>{" "}
          <span className="muted">{t("review.enteredBy", { who: a.decidedBy, old: a.value !== null ? f.value(a.value, a.unit) : null })}</span>
        </p>
        {a.reason && <p className="small muted">{t("review.reason", { r: a.reason })}</p>}
        {editable && (
          <div className="row">
            {mine && solo
              ? <button className="btn primary sm" type="button" onClick={() => act.mutate({ id: a.id, action: "use_as_stated" })}>{t("review.useAsStated")}</button>
              : <button className="btn primary sm" type="button" disabled={mine} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>}
            <button className="btn quiet sm" type="button" onClick={() => act.mutate({ id: a.id, action: "reject", reason: t("review.declined") })}>{t("review.decline")}</button>
            {mine && !solo && <span className="small muted">{t("review.mine")}</span>}
          </div>
        )}
      </div>
    );
  };
  const missingItem = (m: ReviewData["missing"][number]) => {
    const id = `m-${m.fieldKey}-${m.itemKey ?? ""}`;
    return (
      <div className="card card-pad" key={id}>
        {entryForm(m, id,
          <>
            <div className="row between"><h3 className="h3">{name(m)}{termLink(termOf(m.fieldKey))}</h3><Tag tone="review">{t("review.required")}</Tag></div>
            <p className="small muted">{L.group(m.groupLabel ? groupKey(m.groupLabel) : "")}{m.default !== null ? t("review.default", { v: f.value(m.default, m.unit) }) : ""}{m.material ? t("review.materialTag") : ""}</p>
            {/* Card C2: the named default is one action, with what it rests on; the audit path is the same defaults route. */}
            {m.default !== null && <div className="stack tight rv-default">
              {editable && <div><button className="btn primary sm" type="button" disabled={defaults.isPending} onClick={() => defaults.mutate([m.fieldKey])}>{t("review.useDefault", { v: trimCents(f.value(m.default, m.unit)) })}</button></div>}
              <p className="small muted">{t("review.defaultBasis")}</p>
            </div>}
            {m.detail && <p className="small muted">{msg(m.detail)}</p>}
            {L.help(m.fieldKey, m.help) && <p className="small muted">{L.help(m.fieldKey, m.help)}</p>}
            {m.likely.length > 0 && (
              <div className="stack tight small">
                <span className="muted">{t("review.likely")}</span>
                {m.likely.map((x) => (
                  <div key={`${x.documentId}|${x.figureId}`} className="row between">
                    <span>{x.document_name} <span className="muted">{msg(x.location)}</span> <span className="num">{x.context}</span></span>
                    {editable && <button className="btn quiet sm" type="button" disabled={label.isPending} onClick={() => label.mutate({ documentId: x.documentId, figureId: x.figureId, fieldKey: m.fieldKey })}>{t("review.useFigure")}</button>}
                  </div>
                ))}
              </div>
            )}
          </>,
        )}
      </div>
    );
  };
  const pendingRow = (a: Assumption) => {
    const open = editable && (editing === a.id || keeping === a.id);
    const docs = new Set(a.sources.filter((s) => a.value !== null && Math.abs(s.value - a.value) < 0.5).map((s) => s.document_id));
    const on = focused?.id === a.id;
    return (
      <Fragment key={a.id}>
        <tr id={`row-${a.id}`} className={on ? "rv-on" : undefined}>
          <td>
            <button type="button" className="rv-pick" aria-pressed={on} onClick={() => setFocus(a.id)}>{name(a)}</button>{termLink(termOf(a.fieldKey))}
            {a.sources.filter((s, i, all) => s.check_note && all.findIndex(x => x.check_note === s.check_note) === i).map((s, i) => <span key={i} className={s.check_outcome === "questions" ? "sub rv-question" : "sub"}>{msg(s.check_note)}</span>)}
            {a.reason && <span className="sub">{msg(a.reason)}</span>}
            {a.material && materialLink}
          </td>
          <td className="r num">{f.value(a.value, a.unit)}</td>
          <td>{docs.size > 1 ? t("review.agree", { n: docs.size }) : a.sources[0]?.document_name}</td>
          <td>
            {editable && !open && (
              <div className="acts">
                {keepsWithReason(a)
                  ? <button className="btn primary sm" type="button" onClick={() => setKeeping(a.id)}>{t("review.keep")}</button>
                  : <button className="btn primary sm" type="button" onClick={() => act.mutate({ id: a.id, action: "approve", version: a.version })}>{t("review.approve")}</button>}
                <button className="btn quiet sm" type="button" onClick={() => setEditing(a.id)}>{t("review.edit")}</button>
                <button className="btn ghost sm" type="button" onClick={() => act.mutate({ id: a.id, action: "reject", reason: t("review.rejectedInReview"), version: a.version })}>{t("review.reject")}</button>
              </div>
            )}
          </td>
        </tr>
        {/* Card C2: the selected value's source line sits under its row. */}
        {on && !open && <tr className="rv-src"><td colSpan={4} aria-live="polite"><div className="stack tight">{sourceOf(a)}</div></td></tr>}
        {open && <tr><td colSpan={4}>{editing === a.id ? modifyForm(a) : keepForm(a)}</td></tr>}
        {stale?.id === a.id && <tr className="rv-stale"><td colSpan={4}>{staleNote}</td></tr>}
      </Fragment>
    );
  };
  const sourceOf = (a: Assumption) => a.sources.length
    ? distinctSources(a.sources).slice(0, 4).map((src, n) => <Quote key={n} s={src} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)
    : <p className="small muted">{a.tableSource ? tableSourceLabel(a.tableSource, lang) : a.sourceKind === "default" ? t("review.namedDefault") : t("review.enteredByShort", { who: a.decidedBy ?? "—" })}</p>;
  const staleNote = stale && (
    <div className="row between rv-stale-note" role="alert">
      <span className="error-text">{t(stale.mine ? "review.staleTab" : "review.staleOther")}</span>
      <button className="btn quiet sm" type="button" onClick={reload}>{t("review.reload")}</button>
    </div>
  );
  const approvedRow = (a: Assumption) => {
    const ticked = a.sourceKind === "default" || !!a.tableSource;
    const approvedBy = a.decidedBy ? t("review.approvedBy", { who: a.decidedBy, date: a.decidedAt ? f.date(a.decidedAt) : null }) : null;
    return (
      <tr key={a.id}>
        <td>{ticked && <span className="rv-tick"><I.Check /></span>}{name(a)}</td>
        <td className="r num">{f.value(a.value, a.unit)}</td>
        <td>
          {a.tableSource ? <>{tableSourceLabel(a.tableSource, lang)}{a.tableSource.recheckBy && <span className="sub">{t("review.recheck", { date: f.date(a.tableSource.recheckBy) })}</span>}</>
            : a.sourceKind === "default" ? <><StatusTag tone="pass" glyph={I.Check}>{t("review.defaultAccepted")}</StatusTag>{approvedBy && <span className="sub">{approvedBy}</span>}</>
            : a.sourceKind === "analyst" ? t("review.enteredByShort", { who: a.decidedBy })
            : <>{a.sources[0]?.document_name}{approvedBy && <span className="sub">{approvedBy}</span>}</>}
          {a.confirmedByReview ? <span className="sub">{t("review.confirmedByReview", { date: f.date(a.secondApprovedAt!) })}</span> : a.secondApprover && <span className="sub">{t("review.confirmedBy", { who: a.secondApprover })}</span>}
          {a.sponsorStated && <span className="sub">{t("review.statedBy", { who: a.decidedBy })}</span>}
          {a.clientConfirmedAt && <span className="sub"><ClientConfirmation a={a} isClient={role === "client"} meId={me.user.id} /></span>}
        </td>
        <td>
          <div className="acts">
            {role === "client" && !a.clientConfirmedAt && <ClientConfirmation a={a} isClient meId={me.user.id} />}
            {(editable || role === "reviewer") && a.sponsorStated && <button className="btn primary sm" type="button" disabled={a.decidedById === me.user.id} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>}
            {editable && <button className="btn ghost sm" type="button" onClick={() => act.mutate({ id: a.id, action: "reopen", version: a.version })}>{t("review.reopen")}</button>}
          </div>
        </td>
      </tr>
    );
  };

  // The to-do: one numbered line per kind of work, in the order the list first names it, each with the inputs it covers.
  type Group = { kind: string; anchor: string; names: string[] };
  const groups: Group[] = [];
  let aiSeen = 0;
  for (const item of r.todo.items) {
    const kind = item.kind === "please_check" ? "needs_review" : item.kind;
    if (!item.blocking) { if (item.kind === "ai_check") aiSeen++; continue; }
    const a = item.assumptionId ? r.assumptions.find((x) => x.id === item.assumptionId) : undefined;
    const check = item.kind === "ai_check" ? r.aiReading?.pleaseCheck[aiSeen++] : undefined;
    const named = check ? L.field(check.field, check.item) : a ? name(a) : name(item);
    const anchor = kind === "conflict" ? "conflicts" : kind === "missing" ? "missing" : kind === "impossible" ? "impossible" : "pending";
    const g = groups.find((x) => x.kind === kind) ?? groups[groups.push({ kind, anchor, names: [] }) - 1]!;
    g.names.push(named);
  }
  const groupLine = (g: Group) => {
    const n = g.names.length;
    return t(g.kind === "conflict" ? "review.b.conflicts" : g.kind === "missing" ? "review.b.missing" : g.kind === "impossible" ? "review.b.impossible"
      : g.kind === "awaiting" ? "review.b.awaiting" : g.kind === "ai_check" ? "review.b.aiCheck" : "review.b.pending", { n });
  };
  const detail = (names: string[]) => names.length > 4 ? `${names.slice(0, 4).join(", ")} ${t("review.andMore", { n: names.length - 4 })}` : names.join(", ");

  const impossibleItems = r.todo.items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === "impossible");
  const aiChecks = r.todo.items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === "ai_check");
  const hasMissingSection = r.missing.length > 0 || r.notFound.length > 0 || (r.tableNotices ?? []).length > 0;
  const hasPendingSection = pending.length > 0 || awaiting.length > 0 || aiChecks.length > 0 || (r.regions ?? []).length > 0;
  // Values stated by one person, named defaults and cited tables always show; the rest show a few at a time.
  const priority = (a: Assumption) => a.sponsorStated ? 0 : a.sourceKind === "default" || a.tableSource ? 1 : 2;
  const approvedSorted = [...approved].sort((x, y) => priority(x) - priority(y));
  const alwaysShown = approvedSorted.filter((a) => priority(a) < 2).length;
  const FEW = 5;
  const shownApproved = showAll ? approvedSorted : approvedSorted.slice(0, Math.max(FEW, alwaysShown));
  const approvable_ = approvable(plainPending);
  // Card C2: one count. Every value to review is either approved together or held back with its reason, so the two add up.
  const heldBack = [...pending.filter((a) => !approvable_.includes(a)), ...awaiting];
  const heldReason = (a: Assumption): string => {
    const question = a.sources.find((s) => s.check_outcome === "questions" && s.check_note);
    return keepsWithReason(a) ? t("review.heldNoSource")
      : a.status === "awaiting_second_approval" ? t("review.heldAwaiting")
      : question ? msg(question.check_note)
      : a.sources.some((s) => s.ocr) ? t("review.ocr")
      : L.verify(a.fieldKey) ?? t("review.heldCheck");
  };
  const heldLine = (a: Assumption) => `${name(a)} — ${heldReason(a)}`;
  const approveAll = () => {
    if (sending.current || bulk.isPending) return;
    sending.current = true;
    setConfirming(false);
    const items = approvable_, held = heldBack.map(heldLine);
    bulk.mutate(items, { onSuccess: () => setBulkDone({ n: items.length, held }), onSettled: () => { sending.current = false; } });
  };
  const bulkBlock = editable && (approvable_.length > 1 || bulk.isPending) && (
    <div className="stack tight rv-bulk" id="approve-all">
      <div><button className="btn primary" type="button" disabled={bulk.isPending || confirming} aria-busy={bulk.isPending || undefined} aria-expanded={confirming} aria-controls="approve-all-confirm" onClick={() => setConfirming(true)}>{bulk.isPending ? t("review.approving", { n: bulk.variables?.length ?? approvable_.length }) : t("review.approveAll", { n: approvable_.length })}</button></div>
      {heldBack.length > 0 && !bulk.isPending && (
        <div className="small">
          <p>{t("review.canApproveTogether", { n: approvable_.length, h: heldBack.length })}</p>
          <ul className="rv-held">{heldBack.map((a) => <li key={a.id}>{heldLine(a)}</li>)}</ul>
        </div>
      )}
      {confirming && (
        <div id="approve-all-confirm" className="rv-confirm stack tight" role="alertdialog" aria-labelledby="approve-all-q" onKeyDown={(e) => { if (e.key === "Escape") setConfirming(false); }}>
          <p id="approve-all-q">{t("review.approveAllConfirm", { n: approvable_.length })}</p>
          <div className="row">
            <button className="btn primary sm" type="button" autoFocus disabled={bulk.isPending} onClick={approveAll}>{t("review.approveAllYes", { n: approvable_.length })}</button>
            <button className="btn quiet sm" type="button" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
  // Card D1: when only a few values are left and Approve all does not cover them, each gets its row's Approve and Edit in the top card.
  const quickRows = editable && !bulkBlock && pending.length <= 3 ? pending : [];
  const toRow = (a: Assumption) => {
    setFocus(a.id);
    setTimeout(() => document.getElementById(`row-${a.id}`)?.scrollIntoView?.({ block: "center" }), 0);
  };
  const quickRow = (a: Assumption) => (
    <>
      <span className="small">{name(a)} <span className="num muted">{f.value(a.value, a.unit)}</span></span>
      <span className="acts">
        {keepsWithReason(a)
          ? <button className="btn primary sm" type="button" onClick={() => { setKeeping(a.id); toRow(a); }}>{t("review.keep")}</button>
          : <button className="btn primary sm" type="button" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "approve", version: a.version })}>{t("review.approve")}</button>}
        <button className="btn quiet sm" type="button" onClick={() => { setEditing(a.id); toRow(a); }}>{t("review.edit")}</button>
      </span>
    </>
  );
  const otherGroups = groupOther(r.other);
  const otherCount = otherGroups.reduce((n, g) => n + g.length, 0);

  return (
    <>
      <DealFrame o={deal.data} active="review" />
      <div className="with-aside">
        <div className="stack">
          {blocker?.status === "blocked" && (
            <div className="card card-pad stack tight rv-leave" role="alertdialog" aria-labelledby="rv-leave-q">
              <p id="rv-leave-q"><strong>{t("review.leaveTitle")}</strong> {t("review.leaveBody")}</p>
              <div className="row">
                <button className="btn primary sm" type="button" autoFocus onClick={() => blocker.reset()}>{t("review.stay")}</button>
                <button className="btn quiet sm" type="button" onClick={() => blocker.proceed()}>{t("review.leave")}</button>
              </div>
            </div>
          )}
          {docsBusy && <Banner tone="neutral" title={t("review.stillReading")}>{t("review.stillReadingBody")}</Banner>}
          {updating && <p className="small muted" role="status">{t("review.updating")}</p>}

          <div className="card rv-top" ref={topCard}>
            {r.readiness.status === "blocked" ? (
              <div className="card-pad stack tight">
                <div className="row">{conflicts.length > 0 || impossibleItems.length > 0 ? <Tag tone="stop">{t("review.tagBlocked")}</Tag> : <Tag tone="review">{t("review.tagNeedsYou")}</Tag>}<h2 className="h2">{r.todo.blocking ? t("review.todoCount", { n: groups.length }) : t("review.todoReady")}</h2></div>
                {groups.length > 0 && (
                  <ol className="todo rv-todo">
                    {groups.map((g, i) => (
                      <li key={g.kind} className="todo-item">
                        <span className="todo-n">{i + 1}</span>
                        <div className="rv-grow">
                          <a href={`#${g.anchor}`} className="rv-todo-link">{groupLine(g)}</a>
                          {g.kind === "needs_review" && quickRows.length > 0
                            ? <ul className="rv-quick">{quickRows.map((a) => <li key={a.id} className="row between">{quickRow(a)}</li>)}</ul>
                            : <p className="small muted">{detail(g.names)}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div className="card-pad stack tight">
                <Banner tone="neutral" title={t("review.clear")}>{t("review.clearBody")}{stated > 0 && ` ${t("review.statedWaiting", { n: stated })}`}</Banner>
                <div><Link to="/deals/$dealId/run" params={{ dealId }} className="btn primary">{t("review.goRun")}</Link></div>
              </div>
            )}
            {(bulkBlock || bulkDone || bulk.error) && (
              <div className="card-pad stack tight rv-bulk-pad">
                {bulkDone && (
                  <div role="status" className="small">
                    <p>{t("review.bulkDone", { n: bulkDone.n, h: bulkDone.held.length })}</p>
                    {bulkDone.held.length > 0 && <ul className="rv-held">{bulkDone.held.map((line) => <li key={line}>{line}</li>)}</ul>}
                  </div>
                )}
                {bulkBlock}
                <ErrorText error={bulk.error} />
              </div>
            )}
            <div className="card-foot small muted">{summary.join(" · ")}</div>
          </div>
          <ErrorText error={enter.error ?? defaults.error ?? label.error} />

          {impossibleItems.length > 0 && (
            <section className="section" id="impossible">
              <h2 className="h2">{t("review.impossible")}</h2>
              {impossibleItems.map(({ item, index }) => {
                const a = r.assumptions.find(a => a.id === item.assumptionId);
                const problem = r.readiness.impossible.find(i => i.fieldKey === item.fieldKey && (i.itemKey || null) === item.itemKey)!;
                return <div className="card card-pad stack tight" key={`impossible-${index}`}><h3 className="h3">{L.item(problem)}</h3>{editable && (a ? modifyForm(a) : entryForm({ ...problem, unit: FIELD_BY_KEY.get(item.fieldKey)!.unit }, `impossible-${index}`, <span>{name(item)}</span>))}</div>;
              })}
            </section>
          )}

          {conflicts.length > 0 && (
            <section className="section" id="conflicts">
              <div><h2 className="h2">{t("review.conflictsTitle")}</h2><p className="muted rv-lead">{t("review.conflictsBody")}</p></div>
              {conflicts.map(conflictItem)}
            </section>
          )}

          {hasMissingSection && (
            <section className="section" id="missing">
              {/* Card D1: "Missing" heads only required values; with none, the optional group below stands on its own. */}
              {r.missing.length > 0 && <div>
                <h2 className="h2">{t("review.missing")}</h2>
                <p className="muted rv-lead">{t("review.missingBody", { defaults: r.missing.some(m => m.default !== null) })}</p>
                {unused > 0 && <p className="small muted rv-lead">{t("review.unusedLine", { n: unused })} <a href="#unused-figures" onClick={() => setOtherOpen(true)}>{t("review.unusedLink")}</a></p>}
              </div>}
              {r.missing.map(missingItem)}
              {(r.tableNotices ?? []).map(p => <div className="card card-pad stack tight" key={p.fieldKey}>
                <p>{t("review.tableNow",{value:f.value(p.options[0]?.value,FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$")})}</p>
                <TableProposal proposal={p} unit={FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$"} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} location={deal.data.deal.location} />
              </div>)}
              {r.notFound.length > 0 && (
                <details className="card rv-optional">
                <summary className="card-pad"><h3 className="h3">{t("review.optionalTitle")} <span className="num muted">{r.notFound.length}</span></h3></summary>
                <div className="card-pad stack tight rv-optional-body">
                  <p className="small muted">{t("review.notFoundBody")}</p>
                  {r.notFound.map((m) => {
                    const id = `n-${m.fieldKey}`;
                    return (
                      <div key={id} className="stack tight rv-line">
                        <div className="row between">
                          <span>{t("review.notFoundLine", { field: name(m), meaning: L.absent(m.fieldKey) })}</span>
                          {editable && entering !== id && <button className="btn quiet sm" type="button" onClick={() => setEntering(id)}>{t("review.notFoundEnter")}</button>}
                        </div>
                        {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} location={deal.data.deal.location} />}
                        {entering === id && entryForm(m, id, null)}
                      </div>
                    );
                  })}
                </div>
                </details>
              )}
            </section>
          )}
          <ErrorText error={acceptTable.error} />

          {hasPendingSection && (
            <section className="section" id="pending">
              <div className="row between">
                <div><h2 className="h2">{t("review.pendingTitle")}</h2>{pending.length > 0 && <p className="muted rv-lead">{t("review.selectValue")}</p>}</div>
                {bulkBlock && <a className="small" href="#approve-all">{t("review.approveAllLink", { n: approvable_.length })}</a>}
              </div>
              {pending.length > 0 && (
                <div className="card">
                  <div className="scroll">
                    <table className="table rv-table">
                      <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
                      <tbody>{pending.map(pendingRow)}</tbody>
                    </table>
                  </div>
                </div>
              )}
              {awaiting.map(awaitingItem)}
              {aiChecks.map(({ index }) => {
                const aiIndex = r.todo.items.slice(0, index).filter(i => i.kind === "ai_check").length;
                const check = r.aiReading!.pleaseCheck[aiIndex]!;
                return <div className="card card-pad stack tight small" key={`ai-check-${aiIndex}`}>
                  <h3 className="h3">{L.field(check.field, check.item)} · {f.value(check.value, FIELD_BY_KEY.get(check.field)?.unit ?? "")}</h3>
                  <span className="quote">{check.quote}<span className="src">{check.file} · {msg(check.location)}</span></span><span>{msg(check.reason)}</span>
                  {aiEntryControl(`check-${aiIndex}`, check.value)}
                </div>;
              })}
              {(r.regions ?? []).map((g) => {
                const rent = g.fields.every(k => ["unit_count", "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual"].includes(k));
                const cost = g.fields.every(k => FIELD_BY_KEY.get(k)?.group === "budget");
                const loan = g.fields.every(k => ["senior", "mezzanine", "refinance"].includes(FIELD_BY_KEY.get(k)?.group ?? ""));
                const fields = [...(rent ? [t("review.regionType")] : []), ...g.fields.map(k => L.field(k)).map(x => /^[A-ZÀ-Ý][a-zà-ÿ]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x)].join(", "); // Card 137 audit: names sit mid-sentence; an acronym (GST/HST) keeps its case.
                return <div className="card card-pad stack tight" key={`${g.documentId}:${g.source}:${g.table}`}>
                  <h3 className="h3">{g.documentName} · {g.table}</h3>
                  <p>{rent || cost || loan ? t("review.regionIntro", { kind: t(rent ? "review.regionRent" : cost ? "review.regionBudget" : "review.regionLoan"), fields }) : t("review.regionOther", { fields })}</p>
                  {editable && <div><button className="btn primary" type="button" disabled={confirmRegion.isPending} onClick={() => confirmRegion.mutate(g)}>{t("review.regionConfirm", { n: g.ids.length })}</button></div>}
                  {g.leftOut.map(x => <p className="small muted" key={x.id}>{name(r.assumptions.find(a => a.id === x.id)!)}: {msg(x.reason)}</p>)}
                  <ErrorText error={confirmRegion.variables?.documentId === g.documentId && confirmRegion.variables?.table === g.table ? confirmRegion.error : null} />
                </div>;
              })}
            </section>
          )}
          {stale && !pending.some((a) => a.id === stale.id) ? staleNote : <ErrorText error={stale ? null : act.error} />}

          <section className="section" id="approved">
            <div className="row between">
              <h2 className="h2">{t("review.approved")} <span className="muted num">{approved.length}</span></h2>
              {(showAll ? approved.length > FEW : approvedSorted.length > shownApproved.length)
                ? <button className="btn ghost sm" type="button" aria-expanded={showAll} aria-controls="approved-rows" onClick={() => setShowAll(!showAll)}>{showAll ? t("review.showFewer") : t("review.showAll", { n: approved.length })}</button>
                : null}
            </div>
            {approved.length > 0 && (
              <div className="card">
                <div className="scroll">
                  <table className="table rv-table" id="approved-rows">
                    <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
                    <tbody>{shownApproved.map(approvedRow)}</tbody>
                  </table>
                </div>
                <div className="card-foot small muted">{t("review.approvedFoot")}</div>
              </div>
            )}
            {editable && (adding ? addItemForm() : <div><button className="btn quiet sm" type="button" onClick={() => { setAdding(true); setFormErrorAt(null); }}>{t("review.addItem")}</button></div>)}
            {rejected.length > 0 && (
              <details className="rv-details">
                <summary>{t("review.rejected")} <span className="num muted">{rejected.length}</span></summary>
                <ul className="stack tight small muted rv-list">
                  {rejected.map((a) => <li key={a.id}>{name(a)} : {f.value(a.value, a.unit)}{a.reason ? ` (${msg(a.reason)})` : ""}</li>)}
                </ul>
              </details>
            )}
          </section>

          {(r.choices.length > 0 || madeChoices.length > 0) && (
            <section className="section" id="choices">
              <h2 className="h2">{t("review.choices")}</h2>
              <div className="card card-pad stack tight">
                <p className="muted">{t("review.choicesBody")}</p>
                {r.choices.map((m) => {
                  const id = `c-${m.fieldKey}`;
                  return (
                    <div key={id} className="stack tight rv-line">
                      <div className="row between">
                        <span>{t("review.choiceLine", { field: name(m), meaning: L.absent(m.fieldKey) })}</span>
                        {editable && entering !== id && <button className="btn ghost sm" type="button" onClick={() => setEntering(id)}>{m.unit === "flag" ? t("review.choiceEnter") : t("review.notFoundEnter")}</button>}
                      </div>
                      {L.help(m.fieldKey, m.help) && <p className="small muted">{L.help(m.fieldKey, m.help)}</p>}
                      {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} location={deal.data.deal.location} />}
                      {entering === id && entryForm(m, id, null)}
                    </div>
                  );
                })}
                {madeChoices.map((a) => (
                  <div key={a.id} className="row between rv-line">
                    <span>{t("review.madeChoice", { field: name(a), value: f.value(a.value, a.unit), dflt: a.sourceKind === "default", who: a.decidedBy, you: !!a.decidedById && a.decidedById === me.user.id, date: a.decidedAt ? new Date(a.decidedAt).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { year: "numeric", month: "short", day: "numeric" }) : null })}</span>
                    {editable && <button className="btn ghost sm" type="button" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "reopen", version: a.version })}>{t("review.change")}</button>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {r.aiReading?.outcome === "failed" && <p className="small muted">{t("review.aiUnavailable")}</p>}
          <details id="unused-figures" className="card rv-unused" open={otherOpen} onToggle={(e) => setOtherOpen(e.currentTarget.open)}>
            <summary className="card-pad row between">
              <span className="muted">{t("review.otherIntro", { n: otherCount })}</span>
              <span className="rv-link">{t("review.unusedLink")}</span>
            </summary>
            <div className="card-pad stack tight rv-unused-body">
              <h2 className="h3">{t("review.other")}</h2>
              <p className="small muted">{t("review.otherBody")}</p>
              {!!r.aiReading?.notUsed.length && <section className="stack tight">
                <h3 className="h3">{t("review.aiUnused")}</h3>
                {r.aiReading.notUsed.map((item, i) => {
                  const figure = item.figureId ? r.other.find(o => o.figureId === item.figureId && o.document_name === item.file && o.location === item.location) : undefined;
                  return <div key={i} className="stack tight small">
                    <strong className="num">{f.value(item.value, "")}</strong>
                    <span className="quote">{item.quote}<span className="src">{item.file} · {msg(item.location)}</span></span><span>{msg(item.why)}</span>
                    {editable && figure ? <UseAs o={figure} items={itemNames} busy={label.isPending} onSave={b => label.mutate(b)} /> : aiEntryControl(`unused-${i}`, item.value)}
                  </div>;
                })}
              </section>}
              <ErrorText error={label.error ?? unlabel.error} />
              <div className="scroll">
                <table className="table">
                  <thead><tr><th>{t("review.col.doc")}</th><th>{t("review.col.text")}</th><th>{t("review.col.whyNot")}</th></tr></thead>
                  <tbody>
                    {otherGroups.map((rows, n) => (
                      <tr key={n}>
                        <td className="small">{rows[0]!.document_name}<span className="sub">{[...new Set(rows.map((o) => msg(o.location)))].join(", ")}</span></td>
                        <td className="small num">{marked(rows[0]!.context, rows.map((o) => o.raw))}</td>
                        <td className="small muted stack tight">
                          {rows.map((o, i) => (
                            <div key={i} className="stack tight">
                              <span>{rows.length > 1 && <><mark className="num">{o.raw}</mark>{" "}</>}{msg(o.note)}</span>
                              {o.label ? (
                                <div className="stack tight">
                                  <strong>{t("review.labelledAs", { field: L.field(o.label.fieldKey, o.label.itemKey), who: o.label.by })}</strong>
                                  {editable && <div><button className="btn quiet sm" type="button" disabled={unlabel.isPending} onClick={() => unlabel.mutate({ documentId: o.documentId, figureId: o.figureId! })}>{t("review.undo")}</button></div>}
                                </div>
                              ) : editable && o.figureId && o.value !== null ? (
                                <div className="stack tight">
                                  {offeredLabels(o).map((k) => (
                                    <div key={k}><button className="btn quiet sm" type="button" disabled={label.isPending} onClick={() => label.mutate({ documentId: o.documentId, figureId: o.figureId!, fieldKey: k })}>{t("review.useAsSuggested", { field: L.field(k) })}</button></div>
                                  ))}
                                  <UseAs o={o} items={itemNames} busy={label.isPending} onSave={(b) => label.mutate(b)} />
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </div>

        <aside className="stack rv-aside" aria-label={t("review.aside")}>
          <div className="card card-pad"><ReviewGlossary open={glossOpen} onToggle={setGlossOpen} /></div>
          {/* Card C2: the pass marks are there for whoever wants them, folded by default. */}
          <section className="card card-pad" id="thresholds">
            <details className="rv-adv" open={thresholdsOpen} onToggle={(e) => setThresholdsOpen(e.currentTarget.open)}>
              <summary><h2 className="h3">{t("review.thresholds")}</h2></summary>
              <div className="stack tight rv-adv-body">
                <p className="small muted">{t("review.thresholdsBody")}</p>
                <ThresholdList dealId={dealId}>
                  {(version, invalid) => role === "owner" && <Thresholds key={version} scope="deals" id={dealId} initialVersion={version} open={invalid || undefined} summary={t("thresholds.change")} />}
                </ThresholdList>
                {role !== "owner" && <p className="small muted">{t("thresholds.ownerOnly")}</p>}
              </div>
            </details>
          </section>
          <Notice>{t(solo ? "review.modeSolo" : "review.modeTeam")}</Notice>
          <Notice title={t("review.recorded")}>{t("review.recordedBody")}</Notice>
          {role === "owner" && (
            <Notice tone="accent" title={t("settings.eyes.title")}>
              {t("settings.eyes.body")} <Link to="/settings/review-access">{t("settings.eyes.link")}</Link>
            </Notice>
          )}
        </aside>
      </div>
    </>
  );
}

// Card C2: the review's own glossary, in the words the page uses, each entry an anchor the page links to.
const GLOSS = ["dcr", "covenant", "capRate", "noi", "egi", "ltc", "amortization", "interestOnly", "leaseUp", "stabilized", "hold", "mezzanine", "bps", "material"] as const;
type GlossKey = (typeof GLOSS)[number];
export const termOf = (fieldKey: string): GlossKey | undefined =>
  fieldKey === "exit_cap_rate_pct" ? "capRate" : fieldKey === "min_dscr_covenant" ? "covenant" : fieldKey.endsWith("_amort_years") ? "amortization"
  : fieldKey.endsWith("_io_months") ? "interestOnly" : fieldKey === "lease_up_months" ? "leaseUp" : fieldKey === "stabilized_occupancy_pct" ? "stabilized"
  : fieldKey === "hold_years" ? "hold" : fieldKey === "expense_ratio_pct" ? "egi" : fieldKey.startsWith("mezz_") ? "mezzanine" : fieldKey.includes("ltc") ? "ltc" : undefined;
function ReviewGlossary({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <details id="terms" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>{t("glossary.title")}</summary>
      <dl className="stack gloss">
        {GLOSS.map((k) => {
          const [term, meaning] = t(`terms.rv.${k}`);
          return <div key={k} id={`term-${k}`}><dt>{term}</dt><dd className="muted">{meaning}</dd></div>;
        })}
      </dl>
    </details>
  );
}

// The API sends the English group label; map it back to its key for translation.
const GROUP_KEYS: Record<string, string> = {
  Budget: "budget", Revenue: "revenue", Timeline: "timeline", Operations: "operations", Exit: "exit", "Senior loan": "senior",
  "Mezzanine loan": "mezzanine", Equity: "equity", Refinance: "refinance", "LP/GP split": "waterfall", "Stated figures (checks)": "stated",
};
function groupKey(label: string) {
  return GROUP_KEYS[label] ?? label;
}
