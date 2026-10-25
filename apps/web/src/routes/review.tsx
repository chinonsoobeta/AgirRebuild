import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, useId, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FIELD_BY_KEY, FIELDS, tableSourceLabel, pbrhExplanation } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { api, type Assumption, type Review as ReviewData, type Source } from "../api";
import { Banner, WindowConfirmation, canEdit, DealFrame, ErrorText, Glossary, StatusTag, useDeal, useSession } from "../components/ui";
import { Notice, Tag } from "../components/kit";
import { Thresholds } from "../components/thresholds";
import * as I from "../components/icons";
import { useI18n, type Lang } from "../i18n";

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
export function TableProposal({ proposal, unit, onUse, busy }: { proposal: import("@agir/contracts").Proposal; unit: string; onUse: (b: {fieldKey: string; tableId: string; optionKey: string}) => void; busy: boolean }) {
  const { t, f, msg, lang } = useI18n();
  const { role } = useSession();
  const [selected,setSelected] = useState(proposal.options.length === 1 ? "0" : "");
  const [infoOpen,setInfoOpen] = useState(false);
  const infoId = useId();
  if (proposal.unavailable) return <p className="small muted">{msg(proposal.unavailable)}</p>;
  const option = selected === "" ? undefined : proposal.options[Number(selected)];
  const amount = (n: number) => unit === "$" ? new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA",{style:"currency",currency:"CAD",currencyDisplay:"narrowSymbol",minimumFractionDigits:2,maximumFractionDigits:2}).format(n) : f.value(n,unit);
  return <div className="stack tight small">
    <div>{t("review.proposed",{value:option ? amount(option.value) : "—",publisher:proposal.publisher,date:proposal.effective})}{" "}<a href={proposal.url} target="_blank" rel="noreferrer">{t("review.proposalSource")}</a></div>
    {proposal.options.length > 1 ? <select className="select" aria-label={t("review.proposalOption")} value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">{t("review.proposalPlaceholder")}</option>
      {proposal.options.map((o,index)=><option key={index} value={index}>{o.label.split(" — ").map(msg).join(" — ")} — {amount(o.value)}</option>)}
    </select> : <span>{option?.label.split(" — ").map(msg).join(" — ")}</span>}
    {proposal.tableId === "gst-hst-pbrh" && option?.key === "pbrh" && <span>
      <button type="button" className="btn quiet sm" aria-label={msg("Why GST/HST net is $0")} aria-expanded={infoOpen} aria-controls={infoId}
        onMouseEnter={()=>setInfoOpen(true)} onMouseLeave={()=>setInfoOpen(false)} onFocus={()=>setInfoOpen(true)} onBlur={()=>setInfoOpen(false)}
        onClick={()=>setInfoOpen(true)} onKeyDown={e=>{if (e.key === "Escape") setInfoOpen(false);}}>ⓘ</button>
      <span id={infoId} hidden={!infoOpen}>{pbrhExplanation(proposal.readOn,lang)}</span>
    </span>}
    {canEdit(role) && <div><button className="btn quiet sm" type="button" disabled={busy || !option} onClick={()=>option && onUse({fieldKey:proposal.fieldKey,tableId:proposal.tableId,optionKey:option.key})}>{t("review.useProposal")}</button></div>}
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
  const [tickedDefaults, setTickedDefaults] = useState<string[]>([]);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [formError, setFormError] = useState<unknown>(null);
  // The deal first: if it says no reconcile is waiting, the review read after it is already current; if one is, the effect above reads it again when it is done.
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["deal", dealId] });
    await qc.invalidateQueries({ queryKey: ["review", dealId] });
  };
  const act = useMutation({
    mutationFn: (b: { id: string; action: string; value?: number | null; reason?: string | null; version?: number; confirmOutsideWindow?: boolean }) => api.post(`/assumptions/${b.id}/review`, b),
    onSuccess: () => {
      setEditing(null);
      return refresh();
    },
  });
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
      return refresh();
    },
  });
  const [adding, setAdding] = useState(false);
  const [perSf, setPerSf] = useState(false);
  const addItem = useMutation({
    mutationFn: (b: Record<string, string | number | boolean>) => api.post(`/deals/${dealId}/items`, b),
    onSuccess: () => {
      setAdding(false);
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
  const defaults = useMutation({ mutationFn: (fields: string[]) => api.post(`/deals/${dealId}/defaults`, { fields }), onSuccess: () => { setTickedDefaults([]); return refresh(); } });
  const bulk = useMutation({
    mutationFn: async (items: Assumption[]) => {
      for (const a of items) await api.post(`/assumptions/${a.id}/review`, { action: "approve", version: a.version });
    },
    onSuccess: () => refresh(),
  });
  const [showAll, setShowAll] = useState(false);

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
  const focused = pending.find((a) => a.id === focus) ?? pending[0];
  const unused = r.other.filter((o) => o.figureId && o.value !== null && !o.label).length;
  const itemNames = [...new Set(r.assumptions.map((a) => a.itemKey).filter((i): i is string => !!i))];
  const selectedDefaults = tickedDefaults.filter(key => r.missing.some(m => m.fieldKey === key && m.default !== null));
  const plainPending = pending.filter(a => r.todo.items.some(item => item.kind === "needs_review" && item.assumptionId === a.id));
  const docsBusy = deal.data.documents.processing > 0;
  const summary: string[] = t("review.summary", { c: conflicts.length, m: r.missing.length, r: pending.length + awaiting.length, a: approved.length });
  const materialNote = <p className="small muted row rv-note"><I.Lock />{t(solo ? "review.materialNoteSolo" : "review.materialNote")}</p>;

  const keepForm = (a: Assumption) => (
    <form
      className="stack tight"
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
      onChange={() => { if (!act.isPending) act.reset(); }}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setFormError(null);
        const fd = new FormData(e.currentTarget);
        try {
          const e = enteredInUnit(a.unit, fd.get("unit") === "m2", f.parse(fd.get("value")), String(fd.get("reason")), lang);
          act.mutate({ id: a.id, action: "modify", ...e, version: a.version });
        } catch (err) {
          setFormError(err);
        }
      }}
    >
      <div className="grid2 rv-entry">
        <div className="field"><label htmlFor={`v-${a.id}`}>{t("review.differentValue")}</label><ValueInput unit={a.unit} id={`v-${a.id}`} defaultValue={a.value} label={t("review.differentValue")} /></div>
        <div className="field"><label htmlFor={`r-${a.id}`}>{t("review.why")}</label><input className="input" id={`r-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      </div>
      {a.material && materialNote}
      <ErrorText error={formError ?? act.error} />
      <WindowConfirmation error={act.variables?.id === a.id ? act.error : null} busy={act.isPending} onConfirm={() => act.variables && act.mutate({...act.variables, confirmOutsideWindow: true})} />
      <div className="row"><button className="btn primary sm" type="submit">{t("review.saveValue")}</button><button className="btn quiet sm" type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button></div>
    </form>
  );

  // The form that enters a value for a field no document gave: a missing input, or a line that was not found.
  const entryForm = (m: { fieldKey: string; itemKey?: string | null; unit: string; label: string }, id: string, head: ReactNode, defaultValue?: number) => (
    <form
      key={id}
      className="stack tight"
      onChange={() => { if (!enter.isPending) enter.reset(); }}
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(null);
        const fd = new FormData(e.currentTarget);
        try {
          enter.mutate({ fieldKey: m.fieldKey, itemKey: m.itemKey ?? null, ...enteredInUnit(m.unit, fd.get("unit") === "m2", f.parse(fd.get("value")), String(fd.get("reason")), lang) });
        } catch (err) {
          setFormError(err);
        }
      }}
    >
      {head}
      <ErrorText error={enter.variables?.fieldKey === m.fieldKey && enter.variables?.itemKey === (m.itemKey ?? null) ? enter.error : null} />
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
    <div><button className="btn quiet sm" type="button" onClick={() => { setAiEntry({ id, value, field: "", item: "" }); enter.reset(); setFormError(null); }}>{t("review.aiEnter")}</button></div>
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
      onChange={() => { if (!addItem.isPending) addItem.reset(); }}
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(null);
        const fd = new FormData(e.currentTarget);
        try {
          const itemName = String(fd.get("name") ?? "").trim();
          if (!itemName) throw new Error(t("qs.errName"));
          if (itemName.includes("|")) throw new Error(t("qs.errPipe"));
          const reason = String(fd.get("reason") ?? "").trim();
          if (reason.length < 10) throw new Error(t("qs.errReason"));
          const num = (k: string) => f.parse(fd.get(k));
          const occ = String(fd.get("occ-value") ?? "").trim();
          const body: Record<string, string | number> = { name: itemName, reason, ...(occ ? { occupancyPct: num("occ-value") } : {}) };
          if (perSf) {
            const area = enteredInUnit("sf", fd.get("area-unit") === "m2", num("area-value"), reason, lang);
            const rent = enteredInUnit("$/sf/yr", fd.get("psf-unit") === "m2", num("psf-value"), area.reason, lang);
            Object.assign(body, { areaSf: area.value, rentPsfAnnual: rent.value, reason: rent.reason });
          } else {
            Object.assign(body, { unitCount: num("count-value"), rentMonthly: num("rent-value") });
          }
          addItem.mutate(body);
        } catch (err) {
          setFormError(err);
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
        <button className="btn quiet sm" type="button" onClick={() => { setAdding(false); setFormError(null); }}>{t("common.cancel")}</button>
      </div>
      <ErrorText error={formError ?? addItem.error} />
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
          <div><h3 className="h3">{name(a)}</h3><span className="small muted">{a.material ? `${t("common.material")} · ` : ""}{t("review.conflictFigures", { n: vals.length })}</span></div>
          <StatusTag tone="stop" glyph={I.Conflict}>{t("review.conflicting")}</StatusTag>
        </div>
        <div className="card-pad stack tight">
          {a.sources.some((s) => foreignIn(s, dealCurrency)) && a.reason && (
            // A figure in another currency is never a choice: say why, show it, and leave the amount to be entered.
            <div className="stack tight">
              <p>{msg(a.reason)}</p>
              {a.sources.filter((s) => foreignIn(s, dealCurrency)).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)}
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
                  {a.sources.filter((s) => !foreignIn(s, dealCurrency) && Math.abs(s.value - v.value) < 0.5).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)}
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
            <div className="row between"><h3 className="h3">{name(m)}</h3><Tag tone="review">{t("review.required")}</Tag></div>
            <p className="small muted">{L.group(m.groupLabel ? groupKey(m.groupLabel) : "")}{m.default !== null ? t("review.default", { v: f.value(m.default, m.unit) }) : ""}{m.material ? t("review.materialTag") : ""}</p>
            {editable && m.default !== null && <label className="row small rv-radio">
              <input type="checkbox" checked={selectedDefaults.includes(m.fieldKey)} onChange={e => setTickedDefaults(e.target.checked ? [...selectedDefaults, m.fieldKey] : selectedDefaults.filter(key => key !== m.fieldKey))} />
              {t("review.useDefault", { v: f.value(m.default, m.unit) })}
            </label>}
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
    return (
      <Fragment key={a.id}>
        <tr className={focused?.id === a.id ? "rv-on" : undefined}>
          <td>
            <button type="button" className="rv-pick" aria-pressed={focused?.id === a.id} onClick={() => setFocus(a.id)}>{name(a)}</button>
            {a.sources.filter((s, i, all) => s.check_note && all.findIndex(x => x.check_note === s.check_note) === i).map((s, i) => <span key={i} className={s.check_outcome === "questions" ? "sub rv-question" : "sub"}>{msg(s.check_note)}</span>)}
            {a.reason && <span className="sub">{msg(a.reason)}</span>}
            {a.material && <span className="sub">{t("common.material")}</span>}
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
        {open && <tr><td colSpan={4}>{editing === a.id ? modifyForm(a) : keepForm(a)}</td></tr>}
      </Fragment>
    );
  };
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

  return (
    <>
      <DealFrame o={deal.data} active="review" />
      <div className="with-aside">
        <div className="stack">
          {docsBusy && <Banner tone="neutral" title={t("review.stillReading")}>{t("review.stillReadingBody")}</Banner>}
          {updating && <p className="small muted" role="status">{t("review.updating")}</p>}

          <div className="card">
            {r.readiness.status === "blocked" ? (
              <div className="card-pad stack tight">
                <div className="row"><Tag tone="stop">{t("review.tagBlocked")}</Tag><h2 className="h2">{r.todo.blocking ? t("review.todoCount", { n: groups.length }) : t("review.todoReady")}</h2></div>
                {groups.length > 0 && (
                  <ol className="todo rv-todo">
                    {groups.map((g, i) => (
                      <li key={g.kind} className="todo-item">
                        <span className="todo-n">{i + 1}</span>
                        <div><a href={`#${g.anchor}`} className="rv-todo-link">{groupLine(g)}</a><p className="small muted">{detail(g.names)}</p></div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div className="card-pad stack tight">
                <Banner tone="neutral" title={t("review.clear")}>{t("review.clearBody")}{stated > 0 && ` ${t("review.statedWaiting", { n: stated })}`}</Banner>
              </div>
            )}
            <div className="card-foot small muted">{summary.join(" · ")}</div>
          </div>
          <ErrorText error={enter.error ?? defaults.error ?? label.error ?? formError} />

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
              <div>
                <h2 className="h2">{t("review.missing")}</h2>
                {r.missing.length > 0 && <p className="muted rv-lead">{t("review.missingBody", { defaults: r.missing.some(m => m.default !== null) })}</p>}
                {r.missing.length > 0 && unused > 0 && <p className="small muted rv-lead">{t("review.unusedLine", { n: unused })} <a href="#unused-figures" onClick={() => setOtherOpen(true)}>{t("review.unusedLink")}</a></p>}
              </div>
              {r.missing.map(missingItem)}
              {editable && r.missing.some(m => m.default !== null) && <div><button className="btn quiet" type="button" disabled={!selectedDefaults.length || defaults.isPending} onClick={() => defaults.mutate(selectedDefaults)}>{t("review.acceptTickedDefaults", { n: selectedDefaults.length })}</button></div>}
              {(r.tableNotices ?? []).map(p => <div className="card card-pad stack tight" key={p.fieldKey}>
                <p>{t("review.tableNow",{value:f.value(p.options[0]?.value,FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$")})}</p>
                <TableProposal proposal={p} unit={FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$"} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />
              </div>)}
              {r.notFound.length > 0 && (
                <div className="card card-pad stack tight">
                  <h3 className="h3">{t("review.notFound")}</h3>
                  <p className="small muted">{t("review.notFoundBody")}</p>
                  {r.notFound.map((m) => {
                    const id = `n-${m.fieldKey}`;
                    return (
                      <div key={id} className="stack tight rv-line">
                        <div className="row between">
                          <span>{t("review.notFoundLine", { field: name(m), meaning: L.absent(m.fieldKey) })}</span>
                          {editable && entering !== id && <button className="btn quiet sm" type="button" onClick={() => setEntering(id)}>{t("review.notFoundEnter")}</button>}
                        </div>
                        {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />}
                        {entering === id && entryForm(m, id, null)}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          <ErrorText error={acceptTable.error} />

          {hasPendingSection && (
            <section className="section" id="pending">
              <div className="row between">
                <div><h2 className="h2">{t("review.pendingTitle")}</h2>{pending.length > 0 && <p className="muted rv-lead">{t("review.selectValue")}</p>}</div>
                {editable && approvable_.length > 1 && <button className="btn quiet" type="button" disabled={bulk.isPending} onClick={() => { if (confirm(t("review.approveAllConfirm", { n: approvable_.length }))) bulk.mutate(approvable_); }}>{t("review.approveAll", { n: approvable_.length })}</button>}
              </div>
              {pending.length > 0 && (
                <div className="card">
                  <div className="scroll">
                    <table className="table">
                      <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
                      <tbody>{pending.map(pendingRow)}</tbody>
                    </table>
                  </div>
                  {focused && (
                    <div className="card-foot stack tight" aria-live="polite">
                      {focused.sources.length ? focused.sources.slice(0, 4).map((src, n) => <Quote key={n} s={src} currency={dealCurrency} fieldKey={focused.sourceKind === "document" ? focused.fieldKey : undefined} />)
                        : <p className="small muted">{focused.tableSource ? tableSourceLabel(focused.tableSource,lang) : focused.sourceKind === "default" ? t("review.namedDefault") : t("review.enteredByShort", { who: focused.decidedBy ?? "—" })}</p>}
                    </div>
                  )}
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
          <ErrorText error={act.error ?? bulk.error} />

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
                  <table className="table" id="approved-rows">
                    <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
                    <tbody>{shownApproved.map(approvedRow)}</tbody>
                  </table>
                </div>
                <div className="card-foot small muted">{t("review.approvedFoot")}</div>
              </div>
            )}
            {editable && (adding ? addItemForm() : <div><button className="btn quiet sm" type="button" onClick={() => { setAdding(true); setFormError(null); }}>{t("review.addItem")}</button></div>)}
            {rejected.length > 0 && (
              <details className="rv-details">
                <summary>{t("review.rejected")} <span className="num muted">{rejected.length}</span></summary>
                <ul className="stack tight small muted rv-list">
                  {rejected.map((a) => <li key={a.id}>{name(a)} : {f.value(a.value, a.unit)}{a.reason ? ` (${msg(a.reason)})` : ""}</li>)}
                </ul>
              </details>
            )}
          </section>

          {r.choices.length > 0 && (
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
                      {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />}
                      {entering === id && entryForm(m, id, null)}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {r.aiReading?.outcome === "failed" && <p className="small muted">{t("review.aiUnavailable")}</p>}
          <details id="unused-figures" className="card rv-unused" open={otherOpen} onToggle={(e) => setOtherOpen(e.currentTarget.open)}>
            <summary className="card-pad row between">
              <span className="muted">{t("review.otherIntro", { n: r.other.length })}</span>
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
                    {r.other.map((o, n) => (
                      <tr key={n}>
                        <td className="small">{o.document_name}<span className="sub">{msg(o.location)}</span></td>
                        <td className="small num">{o.context}</td>
                        <td className="small muted">
                          {msg(o.note)}
                          {o.label ? (
                            <div className="stack tight">
                              <strong>{t("review.labelledAs", { field: L.field(o.label.fieldKey, o.label.itemKey), who: o.label.by })}</strong>
                              {editable && <div><button className="btn quiet sm" type="button" disabled={unlabel.isPending} onClick={() => unlabel.mutate({ documentId: o.documentId, figureId: o.figureId! })}>{t("review.undo")}</button></div>}
                            </div>
                          ) : editable && o.figureId && o.value !== null ? (
                            <div className="stack tight">
                              {o.suggestions.map((k) => (
                                <div key={k}><button className="btn quiet sm" type="button" disabled={label.isPending} onClick={() => label.mutate({ documentId: o.documentId, figureId: o.figureId!, fieldKey: k })}>{t("review.useAsSuggested", { field: L.field(k) })}</button></div>
                              ))}
                              <UseAs o={o} items={itemNames} busy={label.isPending} onSave={(b) => label.mutate(b)} />
                            </div>
                          ) : null}
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
          <section className="card card-pad stack tight">
            <h2 className="h3">{t("review.thresholds")}</h2>
            <p className="small muted">{t("review.thresholdsBody")}</p>
            <Thresholds scope="deals" id={dealId} summary={t("thresholds.show")} />
          </section>
          <Notice>{t(solo ? "review.modeSolo" : "review.modeTeam")}</Notice>
          <Notice title={t("review.recorded")}>{t("review.recordedBody")}</Notice>
          {role === "owner" && (
            <Notice tone="accent" title={t("settings.eyes.title")}>
              {t("settings.eyes.body")} <Link to="/settings/review-access">{t("settings.eyes.link")}</Link>
            </Notice>
          )}
          <div className="card card-pad"><Glossary /></div>
        </aside>
      </div>
    </>
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
