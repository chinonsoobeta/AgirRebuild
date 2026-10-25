import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FIELDS, FIELD_BY_KEY, RENTAL_ONLY_FIELDS, TEMPLATES, heldSeniorAmortUnused, type TemplateQuestion } from "@agir/contracts";
import { api, ApiError, type Review } from "../api";
import { ErrorText, WindowConfirmation } from "./ui";
import { ChoiceCards, Notice } from "./kit";
import { useI18n } from "../i18n";

type Entry = { fieldKey: string; itemKey: string | null; value: number };
const KEPT = ["approved", "default_accepted", "awaiting_second_approval"];
const UNIT_FIELDS = ["unit_count", "unit_rent_monthly", "unit_sale_price"];
type Section = "units" | "costs" | "income" | "loans" | "partners";
/** Where a question sits on the screen. Only the layout: the order of the answers sent stays the template's. */
const sectionOf = (field: string): Section => {
  if (UNIT_FIELDS.includes(field)) return "units";
  const group = FIELD_BY_KEY.get(field)!.group;
  if (group === "senior" || group === "refinance" || field === "senior_presale_threshold_pct") return "loans";
  if (group === "waterfall") return "partners";
  if (group === "sale" || group === "exit" || field === "stabilized_occupancy_pct" || field === "other_income_annual") return "income";
  return "costs";
};

export function QuickStart({ dealId }: { dealId: string }) {
  const { t, f, L } = useI18n();
  const qc = useQueryClient();
  const [key, setKey] = useState(TEMPLATES[0]!.key);
  const [held, setHeld] = useState(false);
  const [saleNoLoan, setSaleNoLoan] = useState(false);
  const [amortUnused, setAmortUnused] = useState(false);
  const [types, setTypes] = useState([0]);
  const [next, setNext] = useState(1);
  const [formError, setFormError] = useState<unknown>(null);
  const [total, setTotal] = useState<number>();
  const formRef = useRef<HTMLFormElement>(null);
  const tpl = TEMPLATES.find((x) => x.key === key)!;
  const reviewQ = ["review", dealId];
  const review = useQuery({ queryKey: reviewQ, queryFn: () => api.get<Review>(`/deals/${dealId}/review`) });
  const save = useMutation({
    mutationFn: async ({ entries, reason, confirmOutsideWindow }: { entries: Entry[]; reason: string; confirmOutsideWindow?: string }) => {
      // Posting is not atomic: read what is already entered, and treat a 409 as done, so a retry resumes.
      const now = await qc.fetchQuery({ queryKey: reviewQ, queryFn: () => api.get<Review>(`/deals/${dealId}/review`), staleTime: 0 });
      const have = new Set(now.assumptions.filter((a) => KEPT.includes(a.status)).map((a) => `${a.fieldKey}|${a.itemKey ?? ""}`));
      for (const e of entries) {
        if (have.has(`${e.fieldKey}|${e.itemKey ?? ""}`)) continue;
        try {
          await api.post(`/deals/${dealId}/values`, { ...e, reason, confirmOutsideWindow: confirmOutsideWindow === `${e.fieldKey}|${e.itemKey ?? ""}` });
        } catch (err) {
          if (err instanceof ApiError && err.detail?.code === "outside_window") err.detail.entryKey = `${e.fieldKey}|${e.itemKey ?? ""}`;
          if (!(err instanceof ApiError && err.status === 409)) throw err;
        }
      }
      if (tpl.defaults.length > 0) await api.post(`/deals/${dealId}/defaults`, { fields: tpl.defaults });
    },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: reviewQ }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]),
  });

  const number = (fd: FormData, name: string, field: string, label: string): number => {
    const def = FIELD_BY_KEY.get(field)!;
    const v = f.parse(fd.get(name));
    if (def.integer && !Number.isInteger(v)) throw new Error(t("qs.errWhole", { label }));
    if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) {
      throw new Error(t("qs.errRange", { label, min: f.value(def.min ?? -Infinity, def.unit), max: f.value(def.max ?? Infinity, def.unit) }));
    }
    return v;
  };
  const unusedSeniorAmort = (fd: FormData) => heldSeniorAmortUnused((field) => {
    const raw = String(fd.get(field) ?? "").trim();
    return raw ? f.parse(raw) : undefined;
  });
  // The running unit total under the table: display only, the submit check stays the one that counts.
  const countUnits = (form: HTMLFormElement) => {
    let n = 0;
    for (const [name, raw] of new FormData(form).entries()) {
      if (name !== "unit_count" && !name.startsWith("unit_count-")) continue;
      const text = String(raw).trim();
      if (!text) continue;
      try { n += f.parse(text); } catch { return undefined; }
    }
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  useEffect(() => { if (formRef.current) setTotal(countUnits(formRef.current)); }, [types, key]);
  const updateAmortUnused = (form: HTMLFormElement) => {
    try { setAmortUnused(unusedSeniorAmort(new FormData(form))); }
    catch { setAmortUnused(false); }
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    const fd = new FormData(e.currentTarget);
    try {
      const reason = String(fd.get("reason") ?? "").trim();
      if (reason.length < 10) throw new Error(t("qs.errReason"));
      if (tpl.defaults.length > 0 && !fd.get("accept")) throw new Error(t("qs.errAccept"));
      const names = types.map((n) => String(fd.get(`name-${n}`) ?? "").trim());
      if (tpl.questions.some((q) => q.repeatable)) {
        if (names.some((n) => !n)) throw new Error(t("qs.errName"));
        if (names.some((n) => n.includes("|"))) throw new Error(t("qs.errPipe"));
        if (new Set(names).size !== names.length) throw new Error(t("qs.errDup"));
      }
      if (!tpl.sells && held && Boolean(String(fd.get("refinance_amount") ?? "").trim()) === Boolean(String(fd.get("refinance_ltv_pct") ?? "").trim())) {
        throw new Error(t("qs.errRefinance"));
      }
      const partnerAnswers = ["lp_share_pct", "preferred_return_pct", "gp_promote_pct"].map((field) => Boolean(String(fd.get(field) ?? "").trim()));
      if (partnerAnswers.some(Boolean) && !partnerAnswers.every(Boolean)) throw new Error(t("qs.errPartners"));
      const skipAmort = unusedSeniorAmort(fd);
      const entries: Entry[] = tpl.sells ? [{ fieldKey: "sell_units", itemKey: null, value: 1 }] : [];
      let units = 0;
      let skip: string[] = [];
      for (const q of tpl.questions) {
        const label = L.field(q.field);
        if (skip.includes(q.field) || (q.heldOnly && !held) || (q.field === "refinance_and_hold" && !held) ||
          (q.field === "senior_amort_years" && skipAmort)) continue;
        if (q.repeatable) {
          types.forEach((n, i) => {
            const v = number(fd, `${q.field}-${n}`, q.field, `${label} (${names[i]})`);
            if (q.field === "unit_count") units += v;
            entries.push({ fieldKey: q.field, itemKey: names[i]!, value: v });
          });
          continue;
        }
        if (q.optional && !String(fd.get(q.field) ?? "").trim()) continue;
        const v = number(fd, q.field, q.field, label);
        if (q.field === "unit_count") units += v;
        if (q.skipsIfZero && v === 0) skip = q.skipsIfZero;
        entries.push({ fieldKey: q.field, itemKey: q.item ?? null, value: v });
      }
      if (units < tpl.minUnits || units > tpl.maxUnits) throw new Error(t("qs.errUnits", { min: tpl.minUnits, max: tpl.maxUnits }));
      save.mutate({ entries, reason });
    } catch (err) {
      setFormError(err);
    }
  };

  if (save.isSuccess) return <Notice tone="pass" role="status" title={t(tpl.sells ? "qs.doneSales" : "qs.done")}><Link className="btn primary sm" to="/deals/$dealId/review" params={{ dealId }}>{t("qs.next")}</Link></Notice>;
  if (!review.data || (review.data.assumptions.length > 0 && !save.isPending && !save.isError)) return null;

  const hidden = FIELDS.filter((d) => (tpl.sells ? !RENTAL_ONLY_FIELDS.includes(d.key) && d.key !== "sell_units" : d.group !== "sale") && d.required === false && d.absentMeans && !tpl.questions.some((q) => q.field === d.key && (!q.heldOnly || held)));
  const input = (name: string, field: string, optional?: boolean, label?: string, describedBy?: string) => {
    const unit = FIELD_BY_KEY.get(field)!.unit;
    return (
      <div className="qs-affix">
        {unit === "$" && <span aria-hidden="true">$</span>}
        <input id={name} name={name} inputMode="decimal" autoComplete="off" required={!optional} aria-label={label} aria-describedby={describedBy}
          onChange={tpl.sells && field === "senior_loan_amount" ? (e) => {
            try { setSaleNoLoan(f.parse(e.currentTarget.value) === 0); }
            catch { setSaleNoLoan(false); }
          } : field === "senior_io_months" || field === "refinance_month" ? (e) => updateAmortUnused(e.currentTarget.form!) : undefined} />
        {unit !== "$" && f.suffix(unit) && <span aria-hidden="true">{f.suffix(unit)}</span>}
      </div>
    );
  };
  const shown = tpl.questions.filter((q) => (!q.heldOnly || held) && !(tpl.sells && saleNoLoan && (q.field === "senior_rate_pct" || q.field === "senior_presale_threshold_pct")));
  const ask = shown.some((q) => q.field === "refinance_and_hold");
  const repeat = shown.some((q) => q.repeatable && q.field === "unit_count");
  const question = (q: TemplateQuestion) => {
    const [label, hint] = L.ask(q.field);
    const text = tpl.sells && q.field === "gst_hst_net" ? t("qs.saleGstQuestion") : label;
    const unused = q.field === "senior_amort_years" && amortUnused;
    return (
      <div key={q.field} className="field">
        <label htmlFor={q.field}>{unused ? `${text} (${t("qs.amortUnused")})` : q.optional ? `${text} (${t("qs.optional")})` : text}</label>
        {input(q.field, q.field, q.optional || unused, undefined, hint ? `${q.field}-hint` : undefined)}
        {hint && <p className="hint" id={`${q.field}-hint`}>{hint}</p>}
      </div>
    );
  };
  const grid = (section: Section) => shown.filter((q) => !q.repeatable && q.field !== "refinance_and_hold" && sectionOf(q.field) === section);
  const block = (section: Section, title: string, note?: ReactNode) => {
    const qs = grid(section);
    if (qs.length === 0) return null;
    return (
      <section className="section">
        <h3 className="h2">{title}</h3>
        {note}
        <div className="grid2 qs-grid">{qs.map(question)}</div>
      </section>
    );
  };
  const totalLine = total === undefined
    ? t("quickstart.totalNone", { min: tpl.minUnits, max: tpl.maxUnits })
    : t("quickstart.total", { n: f.value(total, FIELD_BY_KEY.get("unit_count")!.unit), min: tpl.minUnits, max: tpl.maxUnits });
  const priceField = tpl.sells ? "unit_sale_price" : "unit_rent_monthly";

  return (
    <div className="with-aside">
      <form ref={formRef} className="stack" onSubmit={submit} onChange={(e) => { if (!save.isPending) save.reset(); setTotal(countUnits(e.currentTarget)); }}>
        <div>
          <h2 className="h1">{t("qs.title")}</h2>
          <p className="lead qs-lead">{t("qs.intro")}</p>
        </div>
        <section className="section">
          <ChoiceCards name="template" legend={<span className="h2">{t("qs.template")}</span>} value={key}
            onChange={(v) => { setKey(v as typeof key); setAmortUnused(false); setSaleNoLoan(false); }}
            options={TEMPLATES.map((x) => ({ value: x.key, title: t(`quickstart.kind.${x.key}`), description: t("quickstart.range", { min: x.minUnits, max: x.maxUnits }) }))} />
          {tpl.sells && <p className="small muted">{t("qs.saleLine")}</p>}
        </section>
        <div className="stack" key={key}>
          {ask && <section className="section">
            <ChoiceCards name="refinance_and_hold" legend={<span className="h2">{t("quickstart.andThen")}</span>} value={held ? "1" : ""}
              onChange={(v) => { setHeld(v === "1"); if (formRef.current) updateAmortUnused(formRef.current); }}
              options={[
                { value: "1", title: t("qs.keep"), description: t("quickstart.keepNote") },
                { value: "", title: t("qs.sell"), description: t("quickstart.sellNote") },
              ]} />
          </section>}
          <section className="section">
            <h3 className="h2">{t("quickstart.units")}</h3>
            {repeat ? <>
              {tpl.sells && <p className="hint">{L.help("unit_sale_price", FIELD_BY_KEY.get("unit_sale_price")!.help ?? null)}</p>}
              <div className="card scroll">
                <table className="table qs-units">
                  <thead><tr>
                    <th scope="col">{t("quickstart.unitTypeHead")}</th>
                    <th scope="col" className="r">{t("qs.unitCount")}</th>
                    <th scope="col" className="r">{t(tpl.sells ? "qs.unitSalePrice" : "qs.unitRent")}</th>
                    <th scope="col"><span className="sr-only">{t("quickstart.actions")}</span></th>
                  </tr></thead>
                  <tbody>
                    {types.map((n) => (
                      <tr key={n}>
                        <td><input className="input" id={`name-${n}`} name={`name-${n}`} maxLength={60} autoComplete="off" aria-label={t("qs.unitType")} /></td>
                        <td>{input(`unit_count-${n}`, "unit_count", false, t("qs.unitCount"))}</td>
                        <td>{input(`${priceField}-${n}`, priceField, false, t(tpl.sells ? "qs.unitSalePrice" : "qs.unitRent"))}</td>
                        <td className="acts">{types.length > 1 && <button className="btn ghost sm" type="button" aria-label={t("qs.removeType")} onClick={() => setTypes(types.filter((x) => x !== n))}>{t("quickstart.remove")}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="card-foot row between">
                  <button className="btn quiet sm" type="button" onClick={() => { setTypes([...types, next]); setNext(next + 1); }}>{t("qs.addType")}</button>
                  <span className="small muted" aria-live="polite">{totalLine}</span>
                </div>
              </div>
            </> : <>
              <div className="grid2 qs-grid">{grid("units").map(question)}</div>
              <p className="small muted" aria-live="polite">{totalLine}</p>
            </>}
          </section>
          {block("costs", t("quickstart.costs"))}
          {block("income", t(tpl.sells ? "quickstart.sales" : "quickstart.income"))}
          {block("loans", t("quickstart.loans"))}
          {block("partners", t("quickstart.partners"), <p className="hint">{t("quickstart.partnersHint")}</p>)}
        </div>
        {(tpl.defaults.length > 0 || hidden.length > 0) && <section className="card">
          <div className="card-head">
            <h3 className="h2">{t(tpl.defaults.length > 0 ? "qs.defaultsTitle" : "quickstart.notAsked")}</h3>
            {tpl.defaults.length > 0 && <span className="small muted">{t("quickstart.defaultsCount", { n: tpl.defaults.length })}</span>}
          </div>
          <div className="card-pad stack tight">
            {tpl.defaults.length > 0 && <>
              <p className="muted">{t("qs.defaultsBody")}</p>
              <dl className="kv">
                {tpl.defaults.map((d) => <Fragment key={d}><dt>{L.field(d)}</dt><dd>{f.value(FIELD_BY_KEY.get(d)!.default!, FIELD_BY_KEY.get(d)!.unit)}</dd></Fragment>)}
              </dl>
            </>}
            {hidden.length > 0 && <ul className="small muted qs-absent">{hidden.map((d) => <li key={d.key}>{t("qs.hiddenLine", { label: L.field(d.key), means: L.absent(d.key) })}</li>)}</ul>}
            {tpl.defaults.length > 0 && <label className="check"><input type="checkbox" name="accept" /><span>{t("qs.accept")}</span></label>}
          </div>
        </section>}
        <section className="section">
          <div className="field">
            <label htmlFor="qs-reason">{t("qs.reason")}</label>
            <input className="input" id="qs-reason" name="reason" defaultValue={t("qs.reasonDefault")} minLength={10} required aria-describedby="qs-reason-hint" />
            <p className="hint" id="qs-reason-hint">{t("quickstart.reasonHint")}</p>
          </div>
          <ErrorText error={formError ?? save.error} />
          <WindowConfirmation error={save.error} busy={save.isPending} onConfirm={() => {
            if (save.variables && save.error instanceof ApiError) save.mutate({...save.variables, confirmOutsideWindow: save.error.detail.entryKey});
          }} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={save.isPending}>{save.isPending ? t("qs.working") : t("qs.submit")}</button>
            <span className="small muted">{t("quickstart.thenNote")}</span>
          </div>
        </section>
      </form>
      <aside className="stack qs-notes" aria-label={t("quickstart.notesLabel")}>
        <Notice>{t("quickstart.noteStated")}</Notice>
        <Notice>{t("quickstart.noteNotAsked")}</Notice>
      </aside>
    </div>
  );
}
