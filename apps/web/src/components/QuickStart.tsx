import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { FIELDS, FIELD_BY_KEY, TEMPLATES, heldSeniorAmortUnused } from "@agir/contracts";
import { api, ApiError, type Review } from "../api";
import { Banner, ErrorText } from "./ui";
import { useI18n } from "../i18n";

type Entry = { fieldKey: string; itemKey: string | null; value: number };
const KEPT = ["approved", "default_accepted", "awaiting_second_approval"];

export function QuickStart({ dealId }: { dealId: string }) {
  const { t, f, L } = useI18n();
  const qc = useQueryClient();
  const [key, setKey] = useState(TEMPLATES[0]!.key);
  const [held, setHeld] = useState(false);
  const [amortUnused, setAmortUnused] = useState(false);
  const [types, setTypes] = useState([0]);
  const [next, setNext] = useState(1);
  const [formError, setFormError] = useState<unknown>(null);
  const tpl = TEMPLATES.find((x) => x.key === key)!;
  const reviewQ = ["review", dealId];
  const review = useQuery({ queryKey: reviewQ, queryFn: () => api.get<Review>(`/deals/${dealId}/review`) });
  const save = useMutation({
    mutationFn: async ({ entries, reason }: { entries: Entry[]; reason: string }) => {
      // Posting is not atomic: read what is already entered, and treat a 409 as done, so a retry resumes.
      const now = await qc.fetchQuery({ queryKey: reviewQ, queryFn: () => api.get<Review>(`/deals/${dealId}/review`), staleTime: 0 });
      const have = new Set(now.assumptions.filter((a) => KEPT.includes(a.status)).map((a) => `${a.fieldKey}|${a.itemKey ?? ""}`));
      for (const e of entries) {
        if (have.has(`${e.fieldKey}|${e.itemKey ?? ""}`)) continue;
        try {
          await api.post(`/deals/${dealId}/values`, { ...e, reason });
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) throw err;
        }
      }
      await api.post(`/deals/${dealId}/defaults`, { fields: tpl.defaults });
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
      if (!fd.get("accept")) throw new Error(t("qs.errAccept"));
      const names = types.map((n) => String(fd.get(`name-${n}`) ?? "").trim());
      if (key === "apartment") {
        if (names.some((n) => !n)) throw new Error(t("qs.errName"));
        if (names.some((n) => n.includes("|"))) throw new Error(t("qs.errPipe"));
        if (new Set(names).size !== names.length) throw new Error(t("qs.errDup"));
      }
      if (held && Boolean(String(fd.get("refinance_amount") ?? "").trim()) === Boolean(String(fd.get("refinance_ltv_pct") ?? "").trim())) {
        throw new Error(t("qs.errRefinance"));
      }
      const skipAmort = unusedSeniorAmort(fd);
      const entries: Entry[] = [];
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

  if (save.isSuccess) return <Banner tone="neutral" title={t("qs.done")}><Link className="btn primary small" to="/deals/$dealId/review" params={{ dealId }}>{t("qs.next")}</Link></Banner>;
  if (!review.data || (review.data.assumptions.length > 0 && !save.isPending && !save.isError)) return null;

  const hidden = FIELDS.filter((d) => d.required === false && d.absentMeans && !tpl.questions.some((q) => q.field === d.key && (!q.heldOnly || held)));
  const input = (name: string, field: string, optional?: boolean) => {
    const unit = FIELD_BY_KEY.get(field)!.unit;
    return (
      <div className="input-affix" style={{ maxWidth: 320 }}>
        {unit === "$" && <span>$</span>}
        <input id={name} name={name} inputMode="decimal" autoComplete="off" required={!optional}
          onChange={field === "senior_io_months" || field === "refinance_month" ? (e) => updateAmortUnused(e.currentTarget.form!) : undefined} />
        {unit !== "$" && f.suffix(unit) && <span>{f.suffix(unit)}</span>}
      </div>
    );
  };

  return (
    <form className="panel stack" style={{ gap: 16 }} onSubmit={submit}>
      <h2 className="h-section">{t("qs.title")}</h2>
      <p className="small muted">{t("qs.intro")}</p>
      <div className="field">
        <label htmlFor="qs-template">{t("qs.template")}</label>
        <select id="qs-template" className="input" value={key} onChange={(e) => { setKey(e.target.value as typeof key); setAmortUnused(false); }}>
          {TEMPLATES.map((x) => <option key={x.key} value={x.key}>{t(`qs.t.${x.key}`)}</option>)}
        </select>
      </div>
      <div className="stack" style={{ gap: 14 }} key={key}>
        {tpl.questions.filter((q) => !q.heldOnly || held).map((q) => {
          if (q.field === "refinance_and_hold") return (
            <div key={q.field} className="field">
              <label htmlFor={q.field} style={{ fontWeight: 600 }}>{L.ask(q.field)[0]}</label>
              <select id={q.field} name={q.field} className="input" value={held ? "1" : ""} onChange={(e) => { setHeld(e.target.value === "1"); updateAmortUnused(e.currentTarget.form!); }}>
                <option value="">{t("qs.sell")}</option>
                <option value="1">{t("qs.keep")}</option>
              </select>
            </div>
          );
          if (q.repeatable) {
            return q.field === "unit_count" ? (
              <div key={q.field} className="stack" style={{ gap: 12 }}>
                {types.map((n) => (
                  <div key={n} className="row" style={{ alignItems: "flex-end", gap: 12 }}>
                    <div className="field"><label htmlFor={`name-${n}`}>{t("qs.unitType")}</label><input className="input" id={`name-${n}`} name={`name-${n}`} maxLength={60} autoComplete="off" /></div>
                    <div className="field"><label htmlFor={`unit_count-${n}`}>{t("qs.unitCount")}</label>{input(`unit_count-${n}`, "unit_count")}</div>
                    <div className="field"><label htmlFor={`unit_rent_monthly-${n}`}>{t("qs.unitRent")}</label>{input(`unit_rent_monthly-${n}`, "unit_rent_monthly")}</div>
                    {types.length > 1 && <button className="btn quiet small" type="button" onClick={() => setTypes(types.filter((x) => x !== n))}>{t("qs.removeType")}</button>}
                  </div>
                ))}
                <button className="btn small" type="button" style={{ alignSelf: "flex-start" }} onClick={() => { setTypes([...types, next]); setNext(next + 1); }}>{t("qs.addType")}</button>
              </div>
            ) : null;
          }
          const [label, hint] = L.ask(q.field);
          const unused = q.field === "senior_amort_years" && amortUnused;
          return (
            <div key={q.field} className="field">
              <label htmlFor={q.field} style={{ fontWeight: 600 }}>{unused ? `${label} (${t("qs.amortUnused")})` : q.optional ? `${label} (${t("qs.optional")})` : label}</label>
              {hint && <span className="help">{hint}</span>}
              {input(q.field, q.field, q.optional || unused)}
            </div>
          );
        })}
      </div>
      <div className="field">
        <label htmlFor="qs-reason">{t("qs.reason")}</label>
        <input className="input" id="qs-reason" name="reason" defaultValue={t("qs.reasonDefault")} minLength={10} required />
      </div>
      <div className="panel stack" style={{ gap: 8 }}>
        <strong>{t("qs.defaultsTitle")}</strong>
        <p className="small muted">{t("qs.defaultsBody")}</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
          {tpl.defaults.map((d) => <li key={d}>{t("qs.defaultLine", { label: L.field(d), value: f.value(FIELD_BY_KEY.get(d)!.default!, FIELD_BY_KEY.get(d)!.unit) })}</li>)}
        </ul>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" name="accept" />{t("qs.accept")}</label>
      </div>
      <details>
        <summary>{t("qs.hidden")}</summary>
        <ul className="small muted" style={{ paddingLeft: 20 }}>{hidden.map((d) => <li key={d.key}>{t("qs.hiddenLine", { label: L.field(d.key), means: L.absent(d.key) })}</li>)}</ul>
      </details>
      <ErrorText error={formError ?? save.error} />
      <div><button className="btn primary" type="submit" disabled={save.isPending}>{save.isPending ? t("qs.working") : t("qs.submit")}</button></div>
    </form>
  );
}
