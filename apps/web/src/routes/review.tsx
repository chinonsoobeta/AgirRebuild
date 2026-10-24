import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FIELD_BY_KEY, FIELDS, tableSourceLabel } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { api, type Assumption, type Review as ReviewData, type Source } from "../api";
import { Banner, WindowConfirmation, canEdit, DealHeader, ErrorText, Glossary, StatusTag, useDeal, useSession } from "../components/ui";
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
      <button className="btn primary small" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{t("review.clientConfirm")}</button>
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
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="row small" style={{ gap: 8, fontWeight: 600 }}><I.Doc />{s.document_name}</span>
      <div className="source-quote">{i >= 0 ? (<>{s.context.slice(0, i)}<mark>{s.raw}</mark>{s.context.slice(i + s.raw.length)}</>) : s.context}</div>
      {fieldKey && L.verify(fieldKey) && <span className="small" style={{ fontWeight: 600 }}>{L.verify(fieldKey)}</span>}
      {s.ocr && <span className="small" style={{ fontWeight: 600 }}>{t("review.ocr")}</span>}
      {s.rule === "suggested" && <span className="small" style={{ fontWeight: 600 }}>{t("review.suggested")}</span>}
      {s.rule === "remembered" && s.note && <span className="small" style={{ fontWeight: 600 }}>{msg(s.note)}</span>}
      {s.check_note && <span className="small muted" style={s.check_outcome === "questions" ? { color: "var(--review-text)", fontWeight: 600 } : undefined}>{msg(s.check_note)}</span>}
      <span className="small faint">{msg(s.location)}</span>
      {(s.unit_seen?.startsWith("m2") || s.unit_seen?.startsWith("$/m2")) && <span className="small faint">{t("review.fromM2")}</span>}
      {foreignIn(s, currency) && <span className="small faint">{t("review.statedIn", { code: foreignIn(s, currency) })}</span>}
    </div>
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
  return { value: unit === "sf" ? value * SF_PER_M2 : value / SF_PER_M2, reason: `${reason} (${lang === "fr" ? "saisi en" : "entered as"} ${typed} ${label})` };
}

function ValueInput({ unit, id, defaultValue, label, prefix = "" }: { unit: string; id: string; defaultValue?: number | null; label: string; prefix?: string }) {
  const { t, f, lang } = useI18n();
  const [metric, setMetric] = useState(false);
  const suffix = f.suffix(unit);
  // A flag is a choice, not a number: yes posts 1 and no posts 0, with neither chosen to start.
  if (unit === "flag") {
    return (
      <div className="row" role="radiogroup" id={id} aria-label={label} style={{ gap: 16, minHeight: 44 }}>
        {([["1", "common.yes"], ["0", "common.no"]] as const).map(([v, k]) => (
          <label key={v} className="row" style={{ gap: 6 }}><input type="radio" name="value" value={v} required />{t(k)}</label>
        ))}
      </div>
    );
  }
  const shown = metric || defaultValue === null || defaultValue === undefined ? "" : lang === "fr" ? String(defaultValue).replace(".", ",") : String(defaultValue);
  return (
    <div className="input-affix" style={{ maxWidth: 320 }}>
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
  if (!open) return <button className="btn quiet small" type="button" onClick={() => setOpen(true)}>{t("review.useAs")}</button>;
  const list = `items-${o.figureId}`;
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        const item = String(new FormData(e.currentTarget).get("item") ?? "").trim();
        onSave({ documentId: o.documentId, figureId: o.figureId!, fieldKey: key, ...(def?.itemized ? { itemKey: item } : {}) });
      }}
    >
      <select aria-label={t("review.useAsField")} value={key} onChange={(e) => setKey(e.target.value)} required>
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
      <div className="row"><button className="btn small" type="submit" disabled={!key || busy}>{t("common.save")}</button><button className="btn quiet small" type="button" onClick={() => setOpen(false)}>{t("common.cancel")}</button></div>
    </form>
  );
}

/** The same proposed-value controls in Not found and Choices. Acceptance uses the existing entry mutation. */
export function TableProposal({ proposal, unit, onUse, busy }: { proposal: import("@agir/contracts").Proposal; unit: string; onUse: (b: {fieldKey: string; tableId: string; optionKey: string}) => void; busy: boolean }) {
  const { t, f, msg, lang } = useI18n();
  const { role } = useSession();
  const [selected,setSelected] = useState(proposal.options.length === 1 ? "0" : "");
  if (proposal.unavailable) return <p className="small muted">{msg(proposal.unavailable)}</p>;
  const option = selected === "" ? undefined : proposal.options[Number(selected)];
  const amount = (n: number) => unit === "$" ? new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA",{style:"currency",currency:"CAD",currencyDisplay:"narrowSymbol",minimumFractionDigits:2,maximumFractionDigits:2}).format(n) : f.value(n,unit);
  return <div className="stack small" style={{gap:8}}>
    <div>{t("review.proposed",{value:option ? amount(option.value) : "—",publisher:proposal.publisher,date:proposal.effective})}{" "}<a href={proposal.url} target="_blank" rel="noreferrer">{t("review.proposalSource")}</a></div>
    {proposal.options.length > 1 ? <select aria-label={t("review.proposalOption")} value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">{t("review.proposalPlaceholder")}</option>
      {proposal.options.map((o,index)=><option key={index} value={index}>{o.label.split(" — ").map(msg).join(" — ")} — {amount(o.value)}</option>)}
    </select> : <span>{option?.label.split(" — ").map(msg).join(" — ")}</span>}
    {canEdit(role) && <div><button className="btn quiet small" type="button" disabled={busy || !option} onClick={()=>option && onUse({fieldKey:proposal.fieldKey,tableId:proposal.tableId,optionKey:option.key})}>{t("review.useProposal")}</button></div>}
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

  if (!deal.data || !review.data) return <p className="muted">{t("common.loading")}</p>;
  const r = review.data;
  const editable = canEdit(role);
  const name = (a: { fieldKey: string; itemKey?: string | null }) =>
    a.fieldKey === "unit_count" && !a.itemKey && !("id" in a) ? t("review.revenueProgram") : L.field(a.fieldKey, a.itemKey);
  const by = (st: string) => r.assumptions.filter((a) => a.status === st);
  const conflicts = by("conflicting");
  const pending = by("needs_review");
  const awaiting = by("awaiting_second_approval");
  const approved = r.assumptions.filter((a) => a.status === "approved" || a.status === "default_accepted");
  const stated = approved.filter((a) => a.sponsorStated).length;
  const rejected = by("rejected");
  const total = conflicts.length + r.missing.length + pending.length + awaiting.length + approved.length;
  const focused = r.assumptions.find((a) => a.id === focus) ?? conflicts[0] ?? pending[0];
  const unused = r.other.filter((o) => o.figureId && o.value !== null && !o.label).length;
  const itemNames = [...new Set(r.assumptions.map((a) => a.itemKey).filter((i): i is string => !!i))];
  const selectedDefaults = tickedDefaults.filter(key => r.missing.some(m => m.fieldKey === key && m.default !== null));
  const plainPending = pending.filter(a => r.todo.items.some(item => item.kind === "needs_review" && item.assumptionId === a.id));
  const docsBusy = deal.data.documents.processing > 0;
  const summary: string[] = t("review.summary", { c: conflicts.length, m: r.missing.length, r: pending.length + awaiting.length, a: approved.length });

  const keepForm = (a: Assumption) => (
    <form
      className="stack"
      style={{ gap: 10, paddingTop: 4, textAlign: "left", whiteSpace: "normal" }}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        act.mutate({ id: a.id, action: "approve", reason: String(new FormData(e.currentTarget).get("reason")).trim(), version: a.version });
        setKeeping(null);
      }}
    >
      <p className="help">{t("review.keepHint")}</p>
      <div className="field"><label htmlFor={`k-${a.id}`}>{t("review.why")}</label><input className="input" id={`k-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      {a.material && <p className="help row" style={{ gap: 6 }}><I.Lock />{t(solo ? "review.materialNoteSolo" : "review.materialNote")}</p>}
      <div className="row"><button className="btn primary small" type="submit">{t("review.keep").replace("…", "")}</button><button className="btn quiet small" type="button" onClick={() => setKeeping(null)}>{t("common.cancel")}</button></div>
    </form>
  );
  const modifyForm = (a: Assumption) => (
    <form
      className="stack"
      style={{ gap: 10, paddingTop: 4, textAlign: "left" }}
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
      <div className="field"><label htmlFor={`v-${a.id}`}>{t("review.differentValue")}</label><ValueInput unit={a.unit} id={`v-${a.id}`} defaultValue={a.value} label={t("review.differentValue")} /></div>
      <div className="field"><label htmlFor={`r-${a.id}`}>{t("review.why")}</label><input className="input" id={`r-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      {a.material && <p className="help row" style={{ gap: 6 }}><I.Lock />{t(solo ? "review.materialNoteSolo" : "review.materialNote")}</p>}
      <ErrorText error={formError ?? act.error} />
      <WindowConfirmation error={act.variables?.id === a.id ? act.error : null} busy={act.isPending} onConfirm={() => act.variables && act.mutate({...act.variables, confirmOutsideWindow: true})} />
      <div className="row"><button className="btn primary small" type="submit">{t("review.saveValue")}</button><button className="btn quiet small" type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button></div>
    </form>
  );

  // The form that enters a value for a field no document gave: a missing input, or a line that was not found.
  const entryForm = (m: { fieldKey: string; itemKey?: string | null; unit: string; label: string }, id: string, head: ReactNode, defaultValue?: number) => (
    <form
      key={id}
      className="stack"
      style={{ gap: 8, paddingTop: 12, borderTop: "1px solid var(--sunken)" }}
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
        <div className="row" style={{ alignItems: "flex-start" }}>
          <ValueInput unit={m.unit} id={id} label={name(m)} defaultValue={defaultValue} />
          <input className="input grow" name="reason" aria-label={t("review.sourceFor", { label: name(m) })} placeholder={t("review.sourceHint")} minLength={10} required style={{ minWidth: 220, flexBasis: 240 }} />
          <button className="btn small" type="submit" style={{ height: 44 }}>{t("common.save")}</button>
        </div>
      )}
    </form>
  );

  const aiEntryControl = (id: string, value: number) => editable && <>
    <button className="btn quiet small" type="button" onClick={() => { setAiEntry({ id, value, field: "", item: "" }); enter.reset(); setFormError(null); }}>{t("review.aiEnter")}</button>
    {aiEntry?.id === id && <div className="stack">
      <select aria-label={t("review.col.input")} value={aiEntry.field} onChange={e => setAiEntry({ ...aiEntry, field: e.target.value, item: "" })}>
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
      className="stack"
      style={{ gap: 12, paddingTop: 12 }}
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
      <div className="row" role="radiogroup" aria-label={t("review.addItem")} style={{ gap: 16 }}>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="basis" checked={!perSf} onChange={() => setPerSf(false)} />{t("review.addItemPerUnit")}</label>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="basis" checked={perSf} onChange={() => setPerSf(true)} />{t("review.addItemPerSf")}</label>
      </div>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }} key={String(perSf)}>
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
        <div className="input-affix" style={{ maxWidth: 320 }}><input id="add-occ" name="occ-value" inputMode="decimal" autoComplete="off" /><span>{f.suffix("%")}</span></div>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <input className="input grow" name="reason" aria-label={t("review.why")} placeholder={t("review.sourceHint")} minLength={10} required style={{ minWidth: 220, flexBasis: 240 }} />
        <button className="btn small" type="submit" style={{ height: 44 }} disabled={addItem.isPending}>{t("common.save")}</button>
        <button className="btn quiet small" type="button" style={{ height: 44 }} onClick={() => { setAdding(false); setFormError(null); }}>{t("common.cancel")}</button>
      </div>
      <ErrorText error={formError ?? addItem.error} />
      <WindowConfirmation error={addItem.error} busy={addItem.isPending} onConfirm={() => addItem.variables && addItem.mutate({...addItem.variables, confirmOutsideWindow: true})} />
    </form>
  );

  const conflictItem = (a: Assumption) => {
    const choice = picked[a.id];
    const vals = (a.conflictValues ?? []).map((x) => x.value);
    return (
      <fieldset key={`conflict-${a.id}`} className={`card ${focused?.id === a.id ? "focus" : ""}`} onFocus={() => setFocus(a.id)} onClick={() => setFocus(a.id)} style={{ margin: 0 }}>
        <legend className="sr-only">{name(a)}</legend>
        <div className="row">
          <span style={{ fontSize: 17, fontWeight: 600 }}>{name(a)}</span>
          <StatusTag tone="stop" glyph={I.Conflict}>{t("review.conflicting")}</StatusTag>
          {a.material && <span className="chip"><I.Lock />{t("common.material")}</span>}
        </div>
        {a.sources.some((s) => foreignIn(s, dealCurrency)) && a.reason && (
          // A figure in another currency is never a choice: say why, show it, and leave the amount to be entered.
          <div className="stack" style={{ gap: 8 }}>
            <p>{msg(a.reason)}</p>
            {a.sources.filter((s) => foreignIn(s, dealCurrency)).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} fieldKey={a.sourceKind === "document" ? a.fieldKey : undefined} />)}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {(a.conflictValues ?? []).map((v) => {
            const conservative = a.conservative && v.value === (a.conservative === "max" ? Math.max(...vals) : Math.min(...vals));
            return (
              <label key={v.value} className="choice">
                <input type="radio" name={`c-${a.id}`} checked={choice === v.value} onChange={() => setPicked({ ...picked, [a.id]: v.value })} disabled={!editable} />
                <span className="stack" style={{ gap: 4 }}>
                  <span className="val">{f.value(v.value, a.unit)}</span>
                  <span className="small muted">{v.documents.map((d) => msg(d)).join(", ")}{conservative ? t("review.conservative") : ""}</span>
                </span>
              </label>
            );
          })}
        </div>
        {editing === a.id ? (
          modifyForm(a)
        ) : (
          <div className="spread">
            <span className="small faint">{vals.length > 0 ? t("review.choosingNote", { material: a.material }) : ""}</span>
            {editable && (
              <div className="row">
                <button className={`btn small ${vals.length > 0 ? "quiet" : "primary"}`} type="button" onClick={() => setEditing(a.id)}>{t("review.enterDifferent")}</button>
                {vals.length > 0 && <button className="btn primary small" type="button" disabled={choice === undefined || act.isPending} onClick={() => act.mutate({ id: a.id, action: "resolve", value: choice!, version: a.version })}>
                  {choice === undefined ? t("review.choose") : t("review.resolveWith", { v: f.value(choice, a.unit) })}
                </button>}
              </div>
            )}
          </div>
        )}
      </fieldset>
    );
  };
  const awaitingItem = (a: Assumption) => {
    const mine = a.decidedById === me.user.id;
    return (
      <div key={`awaiting-${a.id}`} className="card">
        <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{name(a)}</span><StatusTag tone="review" glyph={I.Lock}>{t("review.awaiting")}</StatusTag></div>
        <p>
          <span className="num" style={{ fontSize: 20 }}>{f.value(a.pendingValue, a.unit)}</span>{" "}
          <span className="muted">{t("review.enteredBy", { who: a.decidedBy, old: a.value !== null ? f.value(a.value, a.unit) : null })}</span>
        </p>
        {a.reason && <p className="small muted">{t("review.reason", { r: a.reason })}</p>}
        {editable && (
          <div className="row">
            {mine && solo
              ? <button className="btn primary small" type="button" onClick={() => act.mutate({ id: a.id, action: "use_as_stated" })}>{t("review.useAsStated")}</button>
              : <button className="btn primary small" type="button" disabled={mine} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>}
            <button className="btn quiet small" type="button" onClick={() => act.mutate({ id: a.id, action: "reject", reason: t("review.declined") })}>{t("review.decline")}</button>
            {mine && !solo && <span className="why">{t("review.mine")}</span>}
          </div>
        )}
      </div>
    );
  };
  const missingItem = (m: ReviewData["missing"][number]) => {
    const id = `m-${m.fieldKey}-${m.itemKey ?? ""}`;
    return entryForm(m, id,
      <>
        <div className="spread">
          <label htmlFor={id} style={{ fontWeight: 600 }}>{name(m)}</label>
          <span className="small faint">{L.group(m.groupLabel ? groupKey(m.groupLabel) : "")}{m.default !== null ? t("review.default", { v: f.value(m.default, m.unit) }) : ""}{m.material ? t("review.materialTag") : ""}</span>
        </div>
        {editable && m.default !== null && <label className="row small">
          <input type="checkbox" checked={selectedDefaults.includes(m.fieldKey)} onChange={e => setTickedDefaults(e.target.checked ? [...selectedDefaults, m.fieldKey] : selectedDefaults.filter(key => key !== m.fieldKey))} />
          {t("review.useDefault", { v: f.value(m.default, m.unit) })}
        </label>}
        {m.detail && <p className="small muted">{msg(m.detail)}</p>}
        {L.help(m.fieldKey, m.help) && <span className="help">{L.help(m.fieldKey, m.help)}</span>}
        {m.likely.length > 0 && (
          <div className="stack small" style={{ gap: 6 }}>
            <span className="muted">{t("review.likely")}</span>
            {m.likely.map((x) => (
              <div key={`${x.documentId}|${x.figureId}`} className="spread">
                <span>{x.document_name} <span className="faint">{msg(x.location)}</span> <span className="num">{x.context}</span></span>
                {editable && <button className="btn quiet small" type="button" disabled={label.isPending} onClick={() => label.mutate({ documentId: x.documentId, figureId: x.figureId, fieldKey: m.fieldKey })}>{t("review.useFigure")}</button>}
              </div>
            ))}
          </div>
        )}
      </>,
    );
  };
  const pendingItem = (a: Assumption) => (
    <div className="card" key={a.id} onClick={() => setFocus(a.id)} style={{ background: focused?.id === a.id ? "var(--sunken)" : undefined, cursor: "pointer" }}>
      <div>{name(a)}{a.sources.filter((s, i, all) => s.check_note && all.findIndex(x => x.check_note === s.check_note) === i).map((s, i) => <div key={i} className="small muted" style={s.check_outcome === "questions" ? { color: "var(--review-text)", fontWeight: 600 } : undefined}>{msg(s.check_note)}</div>)}{a.material && <span className="faint small">{t("review.materialTag")}</span>}</div>
      <div className="r num">{f.value(a.value, a.unit)}</div>
      <div className="small muted">{a.sources.length > 1 ? t("review.agree", { n: a.sources.length }) : a.sources[0]?.document_name}</div>
      <div className="r" style={{ whiteSpace: "nowrap" }}>
        {editable &&
          (editing === a.id ? (
            modifyForm(a)
          ) : keeping === a.id ? (
            keepForm(a)
          ) : (
            <>
              {keepsWithReason(a)
                ? <button className="btn small" type="button" onClick={(e) => { e.stopPropagation(); setKeeping(a.id); }}>{t("review.keep")}</button>
                : <button className="btn small" type="button" onClick={(e) => { e.stopPropagation(); act.mutate({ id: a.id, action: "approve", version: a.version }); }}>{t("review.approve")}</button>}{" "}
              <button className="btn quiet small" type="button" onClick={(e) => { e.stopPropagation(); setEditing(a.id); }}>{t("review.edit")}</button>
              <button className="btn quiet small" type="button" onClick={(e) => { e.stopPropagation(); act.mutate({ id: a.id, action: "reject", reason: t("review.rejectedInReview"), version: a.version }); }}>{t("review.reject")}</button>
            </>
          ))}
      </div>
    </div>
  );
  const blockedLine = [
    conflicts.length && t("review.b.conflicts", { n: conflicts.length }),
    r.missing.length && t("review.b.missing", { n: r.missing.length }),
    pending.length && t("review.b.pending", { n: pending.length }),
    awaiting.length && t("review.b.awaiting", { n: awaiting.length }),
    r.readiness.impossible.length && t("review.b.impossible", { n: r.readiness.impossible.length }),
  ].filter(Boolean).join(" ");

  return (
    <>
      <DealHeader o={deal.data} active="review" />
      {docsBusy && <Banner tone="neutral" title={t("review.stillReading")}>{t("review.stillReadingBody")}</Banner>}
      {updating && <p className="small muted" role="status">{t("review.updating")}</p>}
      <Glossary />
      <div className="side">
        <div className="stack" style={{ gap: 24 }}>
          <div className="stack" style={{ gap: 12 }}>
            <p className="serif" style={{ fontSize: 28, lineHeight: 1.25 }}>
              <span style={{ color: conflicts.length ? "var(--stop-text)" : undefined }}>{summary[0]}</span> ·{" "}
              <span style={{ color: r.missing.length ? "var(--stop-text)" : undefined }}>{summary[1]}</span> ·{" "}
              <span style={{ color: pending.length + awaiting.length ? "var(--review-text)" : undefined }}>{summary[2]}</span> · {summary[3]}
            </p>
            {total > 0 && (
              <div className="bar" role="img" aria-label={summary.join(", ")}>
                <span style={{ flexGrow: conflicts.length + r.missing.length, background: "var(--stop)" }} />
                <span style={{ flexGrow: pending.length + awaiting.length, background: "var(--review)" }} />
                <span style={{ flexGrow: approved.length, background: "var(--pass)" }} />
              </div>
            )}
          </div>

          {r.readiness.status === "blocked" ? (
            <Banner tone="stop" title={t("review.blocked")}><span>{blockedLine}{t("review.b.tail")}</span></Banner>
          ) : (
            <Banner tone="neutral" title={t("review.clear")}>{t("review.clearBody")}{stated > 0 && ` ${t("review.statedWaiting", { n: stated })}`}</Banner>
          )}

          <section className="stack" style={{ gap: 12 }}>
            <h2 className="h-section">{r.todo.blocking ? t("review.todoCount", { n: r.todo.blocking }) : t("review.todoReady")}</h2>
            {editable && approvable(plainPending).length > 1 && <button className="btn small" type="button" disabled={bulk.isPending} onClick={() => { if (confirm(t("review.approveAllConfirm", { n: approvable(plainPending).length }))) bulk.mutate(approvable(plainPending)); }}>{t("review.approveAll", { n: approvable(plainPending).length })}</button>}
            {r.missing.length > 0 && unused > 0 && <p className="small muted">{t("review.unusedLine", { n: unused })} <a href="#unused-figures" onClick={() => setOtherOpen(true)}>{t("review.unusedLink")}</a></p>}
            {r.todo.items.map((item, index) => {
              const a = r.assumptions.find(a => a.id === item.assumptionId);
              if (item.kind === "conflict" && a) return conflictItem(a);
              if (item.kind === "impossible") {
                const problem = r.readiness.impossible.find(i => i.fieldKey === item.fieldKey && (i.itemKey || null) === item.itemKey)!;
                return <div className="card" key={`impossible-${index}`}><strong>{L.item(problem)}</strong>{editable && (a ? modifyForm(a) : entryForm({ ...problem, unit: FIELD_BY_KEY.get(item.fieldKey)!.unit }, `impossible-${index}`, <span>{name(item)}</span>))}</div>;
              }
              if (item.kind === "missing") return missingItem(r.missing.find(m => m.fieldKey === item.fieldKey && (m.itemKey || null) === item.itemKey)!);
              if ((item.kind === "please_check" || item.kind === "needs_review") && a) return pendingItem(a);
              if (item.kind === "awaiting" && a) return awaitingItem(a);
              if (item.kind === "ai_check") {
                const aiIndex = r.todo.items.slice(0, index).filter(i => i.kind === "ai_check").length;
                const check = r.aiReading!.pleaseCheck[aiIndex]!;
                return <div className="card stack small" key={`ai-check-${aiIndex}`}>
                  <strong>{L.field(check.field, check.item)} · {f.value(check.value, "")}</strong>
                  <span>{check.quote}</span><span>{check.file} · {msg(check.location)}</span><span>{msg(check.reason)}</span>
                  {aiEntryControl(`check-${aiIndex}`, check.value)}
                </div>;
              }
              return null;
            })}
            {editable && r.missing.some(m => m.default !== null) && <button className="btn small" type="button" disabled={!selectedDefaults.length || defaults.isPending} onClick={() => defaults.mutate(selectedDefaults)}>{t("review.acceptTickedDefaults", { n: selectedDefaults.length })}</button>}
            <ErrorText error={enter.error ?? defaults.error ?? label.error ?? formError} />
          </section>

          {(r.tableNotices ?? []).map(p=><div className="card" key={p.fieldKey}>
            <p>{t("review.tableNow",{value:f.value(p.options[0]?.value,FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$")})}</p>
            <TableProposal proposal={p} unit={FIELDS.find(d=>d.key === p.fieldKey)?.unit ?? "$"} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />
          </div>)}
          <ErrorText error={acceptTable.error} />
          {r.notFound.length > 0 && (
            <div className="card">
              <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{t("review.notFound")}</span></div>
              <p className="small muted">{t("review.notFoundBody")}</p>
              {r.notFound.map((m) => {
                const id = `n-${m.fieldKey}`;
                return (
                  <div key={id} className="stack" style={{ gap: 8, paddingTop: 12, borderTop: "1px solid var(--sunken)" }}>
                    <div className="spread">
                      <span>{t("review.notFoundLine", { field: name(m), meaning: L.absent(m.fieldKey) })}</span>
                      {editable && entering !== id && <button className="btn quiet small" type="button" onClick={() => setEntering(id)}>{t("review.notFoundEnter")}</button>}
                    </div>
                    {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />}
                    {entering === id && entryForm(m, id, <label htmlFor={id} className="sr-only">{name(m)}</label>)}
                  </div>
                );
              })}
            </div>
          )}

          {r.choices.length > 0 && (
            <div className="card">
              <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{t("review.choices")}</span></div>
              <p className="small muted">{t("review.choicesBody")}</p>
              {r.choices.map((m) => {
                const id = `c-${m.fieldKey}`;
                return (
                  <div key={id} className="stack" style={{ gap: 8, paddingTop: 12, borderTop: "1px solid var(--sunken)" }}>
                    <div className="spread">
                      <span>{t("review.choiceLine", { field: name(m), meaning: L.absent(m.fieldKey) })}</span>
                      {editable && entering !== id && <button className="btn quiet small" type="button" onClick={() => setEntering(id)}>{m.unit === "flag" ? t("review.choiceEnter") : t("review.notFoundEnter")}</button>}
                    </div>
                    {L.help(m.fieldKey, m.help) && <span className="help">{L.help(m.fieldKey, m.help)}</span>}
                    {r.proposals?.find(p=>p.fieldKey === m.fieldKey) && <TableProposal key={r.proposals.find(p=>p.fieldKey === m.fieldKey)!.tableId} proposal={r.proposals.find(p=>p.fieldKey === m.fieldKey)!} unit={m.unit} onUse={b=>acceptTable.mutate(b)} busy={acceptTable.isPending} />}
                    {/* A Yes/No choice is named by its radiogroup; a number needs a label of its own. */}
                    {entering === id && entryForm(m, id, m.unit === "flag" ? <span className="sr-only">{name(m)}</span> : <label htmlFor={id} className="sr-only">{name(m)}</label>)}
                  </div>
                );
              })}
            </div>
          )}

          {(r.regions ?? []).map((g) => {
            const rent = g.fields.every(k => ["unit_count", "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual"].includes(k));
            const cost = g.fields.every(k => FIELD_BY_KEY.get(k)?.group === "budget");
            const loan = g.fields.every(k => ["senior", "mezzanine", "refinance"].includes(FIELD_BY_KEY.get(k)?.group ?? ""));
            const fields = [...(rent ? [t("review.regionType")] : []), ...g.fields.map(k => L.field(k)).map(x => /^[A-ZÀ-Ý][a-zà-ÿ]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x)].join(", "); // Card 137 audit: names sit mid-sentence; an acronym (GST/HST) keeps its case.
            return <div className="card stack" key={`${g.documentId}:${g.source}:${g.table}`} style={{ gap: 8 }}>
              <strong>{g.documentName} · {g.table}</strong>
              <p>{rent || cost || loan ? t("review.regionIntro", { kind: t(rent ? "review.regionRent" : cost ? "review.regionBudget" : "review.regionLoan"), fields }) : t("review.regionOther", { fields })}</p>
              {editable && <button className="btn primary" type="button" disabled={confirmRegion.isPending} onClick={() => confirmRegion.mutate(g)}>{t("review.regionConfirm", { n: g.ids.length })}</button>}
              {g.leftOut.map(x => <div className="small muted" key={x.id}>{name(r.assumptions.find(a => a.id === x.id)!)}: {msg(x.reason)}</div>)}
              <ErrorText error={confirmRegion.variables?.documentId === g.documentId && confirmRegion.variables?.table === g.table ? confirmRegion.error : null} />
            </div>;
          })}
          <ErrorText error={act.error ?? bulk.error} />
          <WindowConfirmation error={act.variables?.action === "resolve" ? act.error : null} busy={act.isPending} onConfirm={() => act.variables && act.mutate({...act.variables, confirmOutsideWindow: true})} />

          <details style={{ borderTop: "1px solid var(--rule)", paddingTop: 16 }} open={stated > 0 || undefined}>
            <summary>{t("review.approved")} <span className="num faint" style={{ fontWeight: 400 }}>{approved.length}</span></summary>
            <table className="tbl" style={{ marginTop: 14 }}>
              <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th className="r"><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
              <tbody>
                {approved.map((a) => (
                  <tr key={a.id}>
                    <td>{name(a)}</td>
                    <td className="r num">{f.value(a.value, a.unit)}</td>
                    <td className="small muted">
                      {a.tableSource ? tableSourceLabel(a.tableSource,lang) : a.sourceKind === "default" ? <StatusTag tone="pass" glyph={I.Bookmark}>{t("review.defaultAccepted")}</StatusTag> : a.sourceKind === "analyst" ? t("review.enteredByShort", { who: a.decidedBy }) : a.sources[0]?.document_name}
                      {a.confirmedByReview ? <span>{t("review.confirmedByReview", { date: f.date(a.secondApprovedAt!) })}</span> : a.secondApprover && <span>{t("review.confirmedBy", { who: a.secondApprover })}</span>}
                      {a.sponsorStated && <div>{t("review.statedBy", { who: a.decidedBy })}</div>}
                      {a.clientConfirmedAt && <ClientConfirmation a={a} isClient={role === "client"} meId={me.user.id} />}
                    </td>
                    <td className="r">
                      {role === "client" && !a.clientConfirmedAt && <ClientConfirmation a={a} isClient meId={me.user.id} />}
                      {(editable || role === "reviewer") && a.sponsorStated && <button className="btn primary small" type="button" disabled={a.decidedById === me.user.id} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>}
                      {editable && <button className="btn quiet small" type="button" onClick={() => act.mutate({ id: a.id, action: "reopen", version: a.version })}>{t("review.reopen")}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {editable && (adding ? addItemForm() : <div><button className="btn small" type="button" onClick={() => { setAdding(true); setFormError(null); }}>{t("review.addItem")}</button></div>)}
          {rejected.length > 0 && (
            <details style={{ borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
              <summary>{t("review.rejected")} <span className="num faint" style={{ fontWeight: 400 }}>{rejected.length}</span></summary>
              <ul className="stack small muted" style={{ marginTop: 12, gap: 6 }}>
                {rejected.map((a) => <li key={a.id}>{name(a)} : {f.value(a.value, a.unit)}{a.reason ? ` (${msg(a.reason)})` : ""}</li>)}
              </ul>
            </details>
          )}
            {r.aiReading?.outcome === "failed" && <p className="small muted">{t("review.aiUnavailable")}</p>}
          <details id="unused-figures" style={{ borderTop: "1px solid var(--rule)", paddingTop: 16 }} open={otherOpen} onToggle={(e) => setOtherOpen(e.currentTarget.open)}>
            <summary>{t("review.other")} <span className="num faint" style={{ fontWeight: 400 }}>{r.other.length}</span></summary>
            <p className="small muted" style={{ marginTop: 8 }}>{t("review.otherBody")}</p>
            {!!r.aiReading?.notUsed.length && <section className="stack">
              <h3>{t("review.aiUnused")}</h3>
              {r.aiReading.notUsed.map((item, i) => {
                const figure = item.figureId ? r.other.find(o => o.figureId === item.figureId && o.document_name === item.file && o.location === item.location) : undefined;
                return <div key={i} className="stack small">
                  <strong className="num">{f.value(item.value, "")}</strong>
                  <span>{item.quote}</span><span>{item.file} · {msg(item.location)}</span><span>{msg(item.why)}</span>
                  {editable && figure ? <UseAs o={figure} items={itemNames} busy={label.isPending} onSave={b => label.mutate(b)} /> : aiEntryControl(`unused-${i}`, item.value)}
                </div>;
              })}
            </section>}
            <ErrorText error={label.error ?? unlabel.error} />
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead><tr><th>{t("review.col.doc")}</th><th>{t("review.col.text")}</th><th>{t("review.col.whyNot")}</th></tr></thead>
              <tbody>
                {r.other.map((o, n) => (
                  <tr key={n}>
                    <td className="small">{o.document_name}<div className="faint">{msg(o.location)}</div></td>
                    <td className="small num">{o.context}</td>
                    <td className="small muted">
                      {msg(o.note)}
                      {o.label ? (
                        <div className="stack" style={{ gap: 4 }}>
                          <span style={{ fontWeight: 600 }}>{t("review.labelledAs", { field: L.field(o.label.fieldKey, o.label.itemKey), who: o.label.by })}</span>
                          {editable && <button className="btn quiet small" type="button" disabled={unlabel.isPending} onClick={() => unlabel.mutate({ documentId: o.documentId, figureId: o.figureId! })}>{t("review.undo")}</button>}
                        </div>
                      ) : editable && o.figureId && o.value !== null ? (
                        <div className="stack" style={{ gap: 4 }}>
                          {o.suggestions.map((k) => (
                            <button key={k} className="btn quiet small" type="button" disabled={label.isPending} onClick={() => label.mutate({ documentId: o.documentId, figureId: o.figureId!, fieldKey: k })}>{t("review.useAsSuggested", { field: L.field(k) })}</button>
                          ))}
                          <UseAs o={o} items={itemNames} busy={label.isPending} onSave={(b) => label.mutate(b)} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>

        <aside className="panel stack" style={{ gap: 16, position: "sticky", top: 24 }} aria-label={t("review.where")}>
          <span className="label">{t("review.where")}</span>
          {focused ? (
            <>
              <strong>{name(focused)}</strong>
              {focused.sources.length ? focused.sources.slice(0, 4).map((src, n) => <Quote key={n} s={src} currency={dealCurrency} fieldKey={focused.sourceKind === "document" ? focused.fieldKey : undefined} />) : <p className="small muted">{focused.tableSource ? tableSourceLabel(focused.tableSource,lang) : focused.sourceKind === "default" ? t("review.namedDefault") : t("review.enteredByShort", { who: focused.decidedBy ?? "—" })}</p>}
            </>
          ) : (
            <p className="small muted">{t("review.selectValue")}</p>
          )}
          <div className="stack small muted" style={{ gap: 6, borderTop: "1px solid var(--rule)", paddingTop: 14 }}>
            <strong style={{ color: "var(--ink)" }}>{t("review.recorded")}</strong>
            <span>{t("review.recordedBody")}</span>
          </div>
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
