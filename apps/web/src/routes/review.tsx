import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { FIELDS } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { api, type Assumption, type Review as ReviewData, type Source } from "../api";
import { Banner, canEdit, DealHeader, ErrorText, Glossary, StatusTag, useDeal, useSession } from "../components/ui";
import * as I from "../components/icons";
import { useI18n, type Lang } from "../i18n";

// A source that says which currency it is in records it at the end of unit_seen ("USD", "$/mo USD").
// It is a foreign figure, shown but never used, only when that differs from the deal's currency or the deal states none.
export const foreignIn = (s: Source, dealCurrency: string | null | undefined) => {
  const code = /(?:^|\s)(CAD|USD|AUD)$/.exec(s.unit_seen ?? "")?.[1];
  return code && code !== dealCurrency ? code : undefined;
};

function Quote({ s, currency }: { s: Source; currency: string | null | undefined }) {
  const { t, msg } = useI18n();
  const i = s.context.indexOf(s.raw);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="row small" style={{ gap: 8, fontWeight: 600 }}><I.Doc />{s.document_name}</span>
      <div className="source-quote">{i >= 0 ? (<>{s.context.slice(0, i)}<mark>{s.raw}</mark>{s.context.slice(i + s.raw.length)}</>) : s.context}</div>
      {s.rule === "suggested" && <span className="small" style={{ fontWeight: 600 }}>{t("review.suggested")}</span>}
      <span className="small faint">{msg(s.location)}</span>
      {(s.unit_seen?.startsWith("m2") || s.unit_seen?.startsWith("$/m2")) && <span className="small faint">{t("review.fromM2")}</span>}
      {foreignIn(s, currency) && <span className="small faint">{t("review.statedIn", { code: foreignIn(s, currency) })}</span>}
    </div>
  );
}

const metricUnit = (unit: string) => unit === "sf" || unit === "$/sf/yr";

/** A value typed in square metres becomes square feet (rent per m² becomes rent per sf) before it is posted, and the reason records what was typed. */
export function enteredInUnit(unit: string, metric: boolean, value: number, reason: string, lang: Lang): { value: number; reason: string } {
  if (!metric || !metricUnit(unit)) return { value, reason };
  const typed = lang === "fr" ? String(value).replace(".", ",") : String(value);
  const label = unit === "sf" ? "m²" : lang === "fr" ? "$/m²/an" : "$/m²/yr";
  return { value: unit === "sf" ? value * SF_PER_M2 : value / SF_PER_M2, reason: `${reason} (${lang === "fr" ? "saisi en" : "entered as"} ${typed} ${label})` };
}

function ValueInput({ unit, id, defaultValue }: { unit: string; id: string; defaultValue?: number | null }) {
  const { f, lang } = useI18n();
  const [metric, setMetric] = useState(false);
  const suffix = f.suffix(unit);
  const shown = metric || defaultValue === null || defaultValue === undefined ? "" : lang === "fr" ? String(defaultValue).replace(".", ",") : String(defaultValue);
  return (
    <div className="input-affix" style={{ maxWidth: 320 }}>
      {unit === "$" && lang === "en" && <span>$</span>}
      <input id={id} key={String(metric)} name="value" inputMode="decimal" defaultValue={shown} required autoComplete="off" />
      {metricUnit(unit) ? (
        <select name="unit" aria-label={lang === "fr" ? "Unité" : "Unit"} value={metric ? "m2" : "sf"} onChange={(e) => setMetric(e.target.value === "m2")}>
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

export function Review({ dealId }: { dealId: string }) {
  const { t, f, L, msg, lang } = useI18n();
  const { me, role, solo } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const dealCurrency = deal.data?.deal.currency;
  const review = useQuery({ queryKey: ["review", dealId], queryFn: () => api.get<ReviewData>(`/deals/${dealId}/review`) });
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [formError, setFormError] = useState<unknown>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["review", dealId] }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]);
  const act = useMutation({
    mutationFn: (b: { id: string; action: string; value?: number | null; reason?: string | null; version?: number }) => api.post(`/assumptions/${b.id}/review`, b),
    onSuccess: () => {
      setEditing(null);
      return refresh();
    },
  });
  const enter = useMutation({
    mutationFn: (b: { fieldKey: string; itemKey?: string | null; value: number; reason: string }) => api.post(`/deals/${dealId}/values`, b),
    onSuccess: () => {
      setEntering(null);
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
  const defaultable = r.missing.filter((m) => m.default !== null);
  const docsBusy = deal.data.documents.processing > 0;
  const summary: string[] = t("review.summary", { c: conflicts.length, m: r.missing.length, r: pending.length + awaiting.length, a: approved.length });

  const modifyForm = (a: Assumption) => (
    <form
      className="stack"
      style={{ gap: 10, paddingTop: 4, textAlign: "left" }}
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
      <div className="field"><label htmlFor={`v-${a.id}`}>{t("review.differentValue")}</label><ValueInput unit={a.unit} id={`v-${a.id}`} defaultValue={a.value} /></div>
      <div className="field"><label htmlFor={`r-${a.id}`}>{t("review.why")}</label><input className="input" id={`r-${a.id}`} name="reason" minLength={10} required placeholder={t("review.whyHint")} /></div>
      {a.material && <p className="help row" style={{ gap: 6 }}><I.Lock />{t(solo ? "review.materialNoteSolo" : "review.materialNote")}</p>}
      <ErrorText error={formError ?? act.error} />
      <div className="row"><button className="btn primary small" type="submit">{t("review.saveValue")}</button><button className="btn quiet small" type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button></div>
    </form>
  );

  // The form that enters a value for a field no document gave: a missing input, or a line that was not found.
  const entryForm = (m: ReviewData["missing"][number], id: string, head: ReactNode) => (
    <form
      key={id}
      className="stack"
      style={{ gap: 8, paddingTop: 12, borderTop: "1px solid var(--sunken)" }}
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
      {editable && (
        <div className="row" style={{ alignItems: "flex-start" }}>
          <ValueInput unit={m.unit} id={id} />
          <input className="input grow" name="reason" aria-label={t("review.sourceFor", { label: name(m) })} placeholder={t("review.sourceHint")} minLength={10} required style={{ minWidth: 220, flexBasis: 240 }} />
          <button className="btn small" type="submit" style={{ height: 44 }}>{t("common.save")}</button>
        </div>
      )}
    </form>
  );

  const blockedLine = [
    conflicts.length && t("review.b.conflicts", { n: conflicts.length }),
    r.missing.length && t("review.b.missing", { n: r.missing.length }),
    pending.length && t("review.b.pending", { n: pending.length }),
    awaiting.length && t("review.b.awaiting", { n: awaiting.length }),
    r.readiness.impossible.length && t("review.b.impossible", { n: r.readiness.impossible.length }),
  ].filter(Boolean).join("; ");

  return (
    <>
      <DealHeader o={deal.data} active="review" />
      {docsBusy && <Banner tone="neutral" title={t("review.stillReading")}>{t("review.stillReadingBody")}</Banner>}
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

          {(conflicts.length > 0 || r.missing.length > 0 || awaiting.length > 0) && <h2 className="h-section">{t("review.needsDecision")}</h2>}

          {conflicts.map((a) => {
            const choice = picked[a.id];
            const vals = (a.conflictValues ?? []).map((x) => x.value);
            return (
              <fieldset key={a.id} className={`card ${focused?.id === a.id ? "focus" : ""}`} onFocus={() => setFocus(a.id)} onClick={() => setFocus(a.id)} style={{ margin: 0 }}>
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
                    {a.sources.filter((s) => foreignIn(s, dealCurrency)).map((s, i) => <Quote key={i} s={s} currency={dealCurrency} />)}
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
          })}

          {r.readiness.impossible.length > 0 && (
            <div className="card">
              <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{t("review.impossible")}</span><StatusTag tone="stop" glyph={I.Conflict}>{t("review.b.impossible", { n: r.readiness.impossible.length })}</StatusTag></div>
              <ul className="stack" style={{ gap: 8, margin: 0, paddingLeft: 20 }}>
                {r.readiness.impossible.map((i, k) => (
                  <li key={`${i.fieldKey}-${i.itemKey ?? ""}-${k}`}>{L.item(i)}</li>
                ))}
              </ul>
            </div>
          )}

          {r.missing.length > 0 && (
            <div className="card">
              <div className="spread">
                <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{t("review.missing")}</span><StatusTag tone="stop" glyph={I.Missing}>{t("review.nMissing", { n: r.missing.length })}</StatusTag></div>
                {editable && defaultable.length > 0 && (
                  <button className="btn small" type="button" onClick={() => defaults.mutate(defaultable.map((m) => m.fieldKey))} disabled={defaults.isPending}>
                    <I.Bookmark />{t("review.acceptDefaults", { n: defaultable.length })}
                  </button>
                )}
              </div>
              <p className="small muted">{t("review.missingBody", { defaults: defaultable.length > 0 })}</p>
              <ErrorText error={enter.error ?? defaults.error ?? formError} />
              {unused > 0 && (
                <p className="small muted">{t("review.unusedLine", { n: unused })} <a href="#unused-figures" onClick={() => setOtherOpen(true)}>{t("review.unusedLink")}</a></p>
              )}
              {r.missing.map((m) => {
                const id = `m-${m.fieldKey}-${m.itemKey ?? ""}`;
                return entryForm(m, id,
                  <>
                    <div className="spread">
                      <label htmlFor={id} style={{ fontWeight: 600 }}>{name(m)}</label>
                      <span className="small faint">{L.group(m.groupLabel ? groupKey(m.groupLabel) : "")}{m.default !== null ? t("review.default", { v: f.value(m.default, m.unit) }) : ""}{m.material ? t("review.materialTag") : ""}</span>
                    </div>
                    {L.help(m.fieldKey, m.help) && <span className="help">{L.help(m.fieldKey, m.help)}</span>}
                  </>,
                );
              })}
            </div>
          )}

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
                    {entering === id && entryForm(m, id, <label htmlFor={id} className="sr-only">{name(m)}</label>)}
                  </div>
                );
              })}
            </div>
          )}

          {awaiting.map((a) => {
            const mine = a.decidedById === me.user.id;
            return (
              <div key={a.id} className="card">
                <div className="row"><span style={{ fontSize: 17, fontWeight: 600 }}>{name(a)}</span><StatusTag tone="review" glyph={I.Lock}>{t("review.awaiting")}</StatusTag></div>
                <p>
                  <span className="num" style={{ fontSize: 20 }}>{f.value(a.pendingValue, a.unit)}</span>{" "}
                  <span className="muted">{t("review.enteredBy", { who: a.decidedBy, old: a.value !== null ? f.value(a.value, a.unit) : null })}</span>
                </p>
                {a.reason && <p className="small muted">{t("review.reason", { r: a.reason })}</p>}
                {editable && (
                  <div className="row">
                    <button className="btn primary small" type="button" disabled={mine} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>
                    <button className="btn quiet small" type="button" onClick={() => act.mutate({ id: a.id, action: "reject", reason: t("review.declined") })}>{t("review.decline")}</button>
                    {mine && <span className="why">{t("review.mine")}</span>}
                  </div>
                )}
              </div>
            );
          })}

          {pending.length > 0 && (
            <div className="stack" style={{ gap: 12 }}>
              <div className="spread">
                <h2 className="h-section">{t("review.needsReview")} <span className="num faint" style={{ fontWeight: 400 }}>{pending.length}</span></h2>
                {editable && pending.length > 1 && (
                  <button className="btn small" type="button" disabled={bulk.isPending} onClick={() => { if (confirm(t("review.approveAllConfirm", { n: pending.length }))) bulk.mutate(pending); }}>
                    {t("review.approveAll", { n: pending.length })}
                  </button>
                )}
              </div>
              <table className="tbl">
                <thead><tr><th>{t("review.col.input")}</th><th className="r">{t("review.col.value")}</th><th>{t("review.col.source")}</th><th className="r"><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
                <tbody>
                  {pending.map((a) => (
                    <tr key={a.id} onClick={() => setFocus(a.id)} style={{ background: focused?.id === a.id ? "var(--sunken)" : undefined, cursor: "pointer" }}>
                      <td>{name(a)}{a.material && <span className="faint small">{t("review.materialTag")}</span>}</td>
                      <td className="r num">{f.value(a.value, a.unit)}</td>
                      <td className="small muted">{a.sources.length > 1 ? t("review.agree", { n: a.sources.length }) : a.sources[0]?.document_name}</td>
                      <td className="r" style={{ whiteSpace: "nowrap" }}>
                        {editable &&
                          (editing === a.id ? (
                            modifyForm(a)
                          ) : (
                            <>
                              <button className="btn small" type="button" onClick={(e) => { e.stopPropagation(); act.mutate({ id: a.id, action: "approve", version: a.version }); }}>{t("review.approve")}</button>{" "}
                              <button className="btn quiet small" type="button" onClick={(e) => { e.stopPropagation(); setEditing(a.id); }}>{t("review.edit")}</button>
                              <button className="btn quiet small" type="button" onClick={(e) => { e.stopPropagation(); act.mutate({ id: a.id, action: "reject", reason: t("review.rejectedInReview"), version: a.version }); }}>{t("review.reject")}</button>
                            </>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ErrorText error={act.error ?? bulk.error} />

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
                      {a.sourceKind === "default" ? <StatusTag tone="pass" glyph={I.Bookmark}>{t("review.defaultAccepted")}</StatusTag> : a.sourceKind === "analyst" ? t("review.enteredByShort", { who: a.decidedBy }) : a.sources[0]?.document_name}
                      {a.confirmedByReview ? <span>{t("review.confirmedByReview", { date: f.date(a.secondApprovedAt!) })}</span> : a.secondApprover && <span>{t("review.confirmedBy", { who: a.secondApprover })}</span>}
                      {a.sponsorStated && <div>{t("review.statedBy", { who: a.decidedBy })}</div>}
                    </td>
                    <td className="r">
                      {(editable || role === "reviewer") && a.sponsorStated && <button className="btn primary small" type="button" disabled={a.decidedById === me.user.id} onClick={() => act.mutate({ id: a.id, action: "second_approve" })}>{t("review.confirm")}</button>}
                      {editable && <button className="btn quiet small" type="button" onClick={() => act.mutate({ id: a.id, action: "reopen", version: a.version })}>{t("review.reopen")}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {rejected.length > 0 && (
            <details style={{ borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
              <summary>{t("review.rejected")} <span className="num faint" style={{ fontWeight: 400 }}>{rejected.length}</span></summary>
              <ul className="stack small muted" style={{ marginTop: 12, gap: 6 }}>
                {rejected.map((a) => <li key={a.id}>{name(a)} : {f.value(a.value, a.unit)}{a.reason ? ` (${msg(a.reason)})` : ""}</li>)}
              </ul>
            </details>
          )}
          <details id="unused-figures" style={{ borderTop: "1px solid var(--rule)", paddingTop: 16 }} open={otherOpen} onToggle={(e) => setOtherOpen(e.currentTarget.open)}>
            <summary>{t("review.other")} <span className="num faint" style={{ fontWeight: 400 }}>{r.other.length}</span></summary>
            <p className="small muted" style={{ marginTop: 8 }}>{t("review.otherBody")}</p>
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
                        <UseAs o={o} items={itemNames} busy={label.isPending} onSave={(b) => label.mutate(b)} />
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
              {focused.sources.length ? focused.sources.slice(0, 4).map((src, n) => <Quote key={n} s={src} currency={dealCurrency} />) : <p className="small muted">{focused.sourceKind === "default" ? t("review.namedDefault") : t("review.enteredByShort", { who: focused.decidedBy ?? "—" })}</p>}
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
