import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Banner, canDecide, DealFrame, ErrorText, useDeal, useSession, VerdictBadge } from "../components/ui";
import { ChoiceCards, Notice, Tag, type TagTone } from "../components/kit";
import { useI18n, verdictText } from "../i18n";
import { useRun } from "./run";

const DECISIONS = ["approve", "approve_with_conditions", "reject", "return_to_underwriting"] as const;
const TONE: Record<string, TagTone> = { approve: "pass", approve_with_conditions: "pass", reject: "stop", return_to_underwriting: "review" };
/** The input hash, short: its first eight and last four characters. */
const shortHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)} … ${h.slice(-4)}` : h);

export function DecisionStep({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f, L } = i;
  const { role, solo } = useSession();
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
        <DealFrame o={o} active="decision" />
        <Banner tone="neutral" title={t("decision.noRun")}>
          <span>{t(solo ? "decision.noRunBodySolo" : "decision.noRunBody")} <Link to="/deals/$dealId/run" params={{ dealId }}>{t("decision.goRun")}</Link>.</span>
        </Banner>
      </>
    );
  }
  const v = run.data;
  const verdict = v.result.verdict.code;
  const vt = verdictText(i, v.result.verdict, v.result.checks, solo);
  const against = (choice === "approve" || choice === "approve_with_conditions") && (verdict === "REJECT" || verdict === "NOT_EVALUATED");
  const blockedReason = !v.fresh ? t("decision.stale") : !canDecide(role) ? t(solo ? "decision.roleSolo" : "decision.role") : null;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    record.mutate({ decision: choice, rationale: fd.get("rationale"), conditions: fd.get("conditions") || null, overrideReason: fd.get("override") || null });
  };
  return (
    <>
      <DealFrame o={o} active="decision" />
      <div className="with-aside">
        <div className="stack">
          <div>
            <h2 className="h1">{t(solo ? "decision.titleSolo" : "decision.title")}</h2>
            <p className="lead dec-lead">{t("decision.lead", { n: v.number, v: L.verdict(verdict).toLowerCase() })}</p>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="row dec-verdict"><VerdictBadge code={verdict} /><span>{vt.headline}</span></div>
              <span className="small muted">{t(v.fresh ? "decision.current" : "decision.outOfDate")}</span>
            </div>
            <div className="card-pad stack">
              <p className="muted">{vt.explanation}</p>
              {blockedReason ? (
                <Notice tone="review" title={t("decision.cannot")} role="status">{blockedReason}</Notice>
              ) : (
                <form id="decision-form" className="stack" onSubmit={submit}>
                  <ChoiceCards name="decision" legend={v.decisions.length ? t("decision.further") : t("decision.choose")} value={choice} onChange={setChoice}
                    options={DECISIONS.map((k) => ({ value: k, title: L.decision(k), description: t(`decision.d.${k}`) }))} />
                  <div className="field">
                    <label htmlFor="rationale">{t(solo ? "decision.reasoningSolo" : "decision.reasoning")}</label>
                    <textarea className="textarea" id="rationale" name="rationale" minLength={10} required placeholder={t("decision.reasoningHint")} />
                  </div>
                  {/* Conditions belong to "approve with conditions" only, so a permanent "approve" never carries any. */}
                  {choice === "approve_with_conditions" && (
                    <div className="field">
                      <label htmlFor="conditions">{t("decision.conditionsLabel")}</label>
                      <textarea className="textarea dec-short" id="conditions" name="conditions" minLength={5} required placeholder={t("decision.conditionsHint")} />
                    </div>
                  )}
                  {against && (
                    <div className="field">
                      <label htmlFor="override">{t("decision.overrideLabel", { v: L.verdict(verdict).toLowerCase() })}</label>
                      <textarea className="textarea" id="override" name="override" minLength={20} required aria-describedby="override-help" />
                      <span className="small muted" id="override-help">{t("decision.overrideHelp")}</span>
                    </div>
                  )}
                  <ErrorText error={record.error} />
                  <div className="row">
                    <button className="btn primary" type="submit" disabled={!choice || record.isPending}>{t("decision.record")}</button>
                    <span className="small muted">{t("decision.permanentNote")}</span>
                  </div>
                </form>
              )}
            </div>
          </div>

          <section className="section">
            <h2 className="h2">{t("decision.recorded")}</h2>
            {v.decisions.length === 0 ? (
              <div className="card card-pad muted">{t("decision.empty")}</div>
            ) : (
              <ul className="dec-list">
                {v.decisions.map((d) => (
                  <li key={d.id} className="card card-pad stack tight">
                    <div className="row"><Tag tone={TONE[d.decision] ?? "neutral"}>{L.decision(d.decision)}</Tag><span className="small muted">{t("decision.line", { n: v.number, who: d.decided_by, date: f.date(d.created_at) })}</span></div>
                    <p>{d.rationale}</p>
                    {d.conditions && <p className="muted">{t("decision.conditions", { c: d.conditions })}</p>}
                    {d.override_reason && <p className="muted">{t("decision.against", { v: L.verdict(verdict).toLowerCase(), r: d.override_reason })}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="stack dec-aside">
          <div className="card card-pad stack tight">
            <h3 className="h3">{t("decision.binds")}</h3>
            <p className="muted">{t("decision.bindsBody", { n: v.number })}</p>
            <dl className="kv dec-kv">
              <dt>{t("decision.kv.run")}</dt><dd>{t("decision.kv.runOn", { n: v.number, date: f.date(v.createdAt) })}</dd>
              {v.policyVersion && <><dt>{t("decision.kv.policy")}</dt><dd>{v.policyDraft ? t("decision.kv.draft", { p: v.policyVersion }) : v.policyVersion}</dd></>}
              {v.engineVersion && <><dt>{t("decision.kv.engine")}</dt><dd>{v.engineVersion}</dd></>}
              {v.inputHash && <><dt>{t("decision.kv.inputs")}</dt><dd className="hash">{shortHash(v.inputHash)}</dd></>}
            </dl>
          </div>
          <Notice>{t("decision.overrideNotice")}</Notice>
          {canDecide(role) && <Notice>{t("decision.whoDecides", { role: L.role(role) })}</Notice>}
        </aside>
      </div>
    </>
  );
}
