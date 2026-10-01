import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Banner, canDecide, DealHeader, ErrorText, useDeal, useSession, VerdictBadge } from "../components/ui";
import { useI18n, verdictText } from "../i18n";
import { useRun } from "./run";

const DECISIONS = ["approve", "approve_with_conditions", "reject", "return_to_underwriting"];

export function DecisionStep({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f, L } = i;
  const { role } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const run = useRun(deal.data?.run?.id);
  const [choice, setChoice] = useState<string>("");
  const record = useMutation({
    mutationFn: (b: object) => api.post(`/runs/${deal.data!.run!.id}/decision`, b),
    onSuccess: () => {
      setChoice("");
      (document.getElementById("decision-form") as HTMLFormElement | null)?.reset();
      return Promise.all([qc.invalidateQueries({ queryKey: ["deal", dealId] }), qc.invalidateQueries({ queryKey: ["run"] })]);
    },
  });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  if (!o.run || !run.data) {
    return (
      <>
        <DealHeader o={o} active="decision" />
        <Banner tone="neutral" title={t("decision.noRun")}>
          <span>{t("decision.noRunBody")} <Link to="/deals/$dealId/run" params={{ dealId }}>{t("decision.goRun")}</Link>.</span>
        </Banner>
      </>
    );
  }
  const v = run.data;
  const verdict = v.result.verdict.code;
  const vt = verdictText(i, v.result.verdict, v.result.checks);
  const against = (choice === "approve" || choice === "approve_with_conditions") && (verdict === "REJECT" || verdict === "NOT_EVALUATED");
  const blockedReason = !v.fresh ? t("decision.stale") : !canDecide(role) ? t("decision.role") : null;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    record.mutate({ decision: choice, rationale: fd.get("rationale"), conditions: fd.get("conditions") || null, overrideReason: fd.get("override") || null });
  };
  return (
    <>
      <DealHeader o={o} active="decision" />
      <div className="side">
        <div className="stack" style={{ gap: 24 }}>
          <section className="panel stack" style={{ gap: 10 }}>
            <div className="row"><VerdictBadge code={verdict} /><span className="label">{t("common.run", { n: v.number })} · {f.date(v.createdAt)}</span></div>
            <p className="serif" style={{ fontSize: 26, lineHeight: 1.25 }}>{vt.headline}</p>
            <p className="muted">{vt.explanation}</p>
          </section>

          {v.decisions.length > 0 && (
            <div className="stack">
              <h2 className="h-section">{t("decision.recorded")}</h2>
              {v.decisions.map((d) => (
                <div key={d.id} className="panel stack" style={{ gap: 6 }}>
                  <strong>{L.decision(d.decision)}</strong>
                  <p>{d.rationale}</p>
                  {d.conditions && <p className="muted">{t("decision.conditions", { c: d.conditions })}</p>}
                  {d.override_reason && <p className="muted">{t("decision.against", { v: L.verdict(verdict).toLowerCase(), r: d.override_reason })}</p>}
                  <span className="small faint">{d.decided_by} · {f.date(d.created_at)} · {t("decision.permanent")}</span>
                </div>
              ))}
            </div>
          )}

          {blockedReason ? (
            <Banner tone="review" title={t("decision.cannot")}>{blockedReason}</Banner>
          ) : (
            <form id="decision-form" className="panel stack" style={{ gap: 18 }} onSubmit={submit}>
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 10 }}>
                <legend className="h-section" style={{ marginBottom: 10 }}>{v.decisions.length ? t("decision.further") : t("decision.title")}</legend>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  {DECISIONS.map((k) => (
                    <label key={k} className="choice">
                      <input type="radio" name="decision" value={k} checked={choice === k} onChange={() => setChoice(k)} required />
                      <span>{L.decision(k)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field"><label htmlFor="rationale">{t("decision.reasoning")}</label><textarea className="textarea" id="rationale" name="rationale" minLength={10} required /></div>
              {choice === "approve_with_conditions" && (
                <div className="field"><label htmlFor="conditions">{t("decision.conditionsLabel")}</label><textarea className="textarea" id="conditions" name="conditions" required /></div>
              )}
              {against && (
                <div className="field">
                  <label htmlFor="override">{t("decision.overrideLabel", { v: L.verdict(verdict).toLowerCase() })}</label>
                  <textarea className="textarea" id="override" name="override" minLength={20} required />
                  <span className="help">{t("decision.overrideHelp")}</span>
                </div>
              )}
              <ErrorText error={record.error} />
              <div className="row"><button className="btn primary" type="submit" disabled={!choice || record.isPending}>{t("decision.record")}</button><span className="why">{t("decision.permanentNote")}</span></div>
            </form>
          )}
        </div>
        <aside className="panel stack small muted" style={{ gap: 10 }}>
          <span className="label">{t("decision.binds")}</span>
          <span>{t("decision.bindsBody", { n: v.number })}</span>
        </aside>
      </div>
    </>
  );
}
