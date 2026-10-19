import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Artifact, type ShareLink, type ShareTerm } from "../api";
import { Banner, canEdit, DealHeader, ErrorText, StatusTag, useDeal, useSession } from "../components/ui";
import * as I from "../components/icons";
import { useRun } from "./run";
import { useI18n } from "../i18n";

const OPTIONS = [
  { kind: "ic_memo", format: "pdf" },
  { kind: "ic_memo", format: "docx" },
  { kind: "lender_package", format: "pdf" },
  { kind: "lender_package", format: "docx" },
  { kind: "build_decision", format: "pdf" },
  { kind: "build_decision", format: "docx" },
  { kind: "partner_memo", format: "pdf" },
  { kind: "partner_memo", format: "docx" },
  { kind: "model_export", format: "xlsx" },
] as const;
const TERMS: ShareTerm[] = ["24h", "7d", "30d", "none"];

export function Reports({ dealId }: { dealId: string }) {
  const { t, f } = useI18n();
  const { role } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const run = useRun(deal.data?.run?.id);
  const lp = run.data?.result.scenarios.find((s) => s.key === "base")?.metrics.find((m) => m.key === "lp_irr");
  // A held run with a split has a partner memo too (card 87); its partner returns are unrealized.
  const heldSplit = Boolean(run.data?.result.scenarios.find((s) => s.key === "base")?.metrics.some((m) => m.key === "unrealized_equity_irr")
    && run.data?.inputs?.some((i) => i.fieldKey === "lp_share_pct"));
  const partnerMemo = heldSplit || Boolean(lp && lp.status !== "NOT_APPLICABLE");
  const arts = useQuery({
    queryKey: ["artifacts", dealId],
    queryFn: () => api.get<Artifact[]>(`/deals/${dealId}/artifacts`),
    refetchInterval: (q) => (q.state.data?.some((a) => a.status === "queued") ? 1200 : false),
  });
  const links = useQuery({ queryKey: ["share-links", dealId], queryFn: () => api.get<ShareLink[]>(`/deals/${dealId}/share-links`) });
  // Sharing is open to every staff role (card 86): a link is read-only and shows no more than its maker can see.
  // A client (card 89) may not share.
  const [sharing, setSharing] = useState<string | null>(null);
  const [term, setTerm] = useState<ShareTerm>("7d");
  const [made, setMade] = useState<string | null>(null);
  const share = useMutation({
    mutationFn: (b: { artifact: string; term: ShareTerm }) => api.post<{ id: string; url: string; expiresAt: string | null }>(`/artifacts/${b.artifact}/share-links`, { term: b.term }),
    onSuccess: (r) => { setMade(window.location.origin + r.url); return qc.invalidateQueries({ queryKey: ["share-links", dealId] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/share-links/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["share-links", dealId] }),
  });
  const make = useMutation({
    mutationFn: (b: { kind: string; format: string }) => api.post(`/runs/${deal.data!.run!.id}/artifacts`, b),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["artifacts", dealId] }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]),
  });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const kind = (k: string) => (k === "ic_memo" ? t("reports.memo") : k === "lender_package" ? t("reports.lender") : k === "build_decision" ? t("reports.buildDecision") : k === "partner_memo" ? t("reports.partnerMemo") : t("reports.modelExport"));
  const fmtName = (x: string) => (x === "pdf" ? "PDF" : x === "docx" ? t("reports.word") : t("reports.excel"));
  return (
    <>
      <DealHeader o={o} active="reports" />
      {!o.run ? (
        <Banner tone="neutral" title={t("reports.needRun")}>{t("reports.needRunBody")}</Banner>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {!o.run.fresh && <Banner tone="review" title={t("reports.stale", { n: o.run.number })}>{t("reports.staleBody")}</Banner>}
          <h2 className="h-section">{t("reports.generate", { n: o.run.number })}</h2>
          <div className="row">
            {OPTIONS.filter((x) => x.kind !== "partner_memo" || partnerMemo).map((x) => (
              <button key={`${x.kind}-${x.format}`} className="btn" type="button" disabled={!canEdit(role) || make.isPending} onClick={() => make.mutate(x)}>
                {x.kind === "model_export" ? t("reports.model") : kind(x.kind)} <span className="faint">· {fmtName(x.format)}</span>
              </button>
            ))}
            <a className="btn quiet" href={`/api/runs/${o.run.id}/audit-package`}><I.Download />{t("reports.package")}</a>
          </div>
          <p className="small faint">{t("reports.note")}</p>
          <ErrorText error={make.error} />
        </div>
      )}
      <table className="tbl">
        <thead><tr><th>{t("reports.col.report")}</th><th>{t("step.run")}</th><th>{t("reports.col.status")}</th><th>{t("reports.col.created")}</th><th className="r"><span className="sr-only">{t("common.download")}</span></th></tr></thead>
        <tbody>
          {(arts.data ?? []).map((a) => (
            <Fragment key={a.id}>
            <tr>
              <td>{kind(a.kind)} <span className="faint">· {fmtName(a.format)}</span></td>
              <td className="num">{t("common.run", { n: a.run_number })}</td>
              <td>
                {a.status === "ready" && <StatusTag tone="pass">{t("reports.ready")}{a.provenance_entries ? t("reports.traced", { n: a.provenance_entries }) : ""}</StatusTag>}
                {a.status === "queued" && <StatusTag tone="neutral">{t("reports.rendering")}</StatusTag>}
                {(a.status === "blocked" || a.status === "failed") && (
                  <div className="stack" style={{ gap: 4 }}><StatusTag tone="stop">{a.status === "blocked" ? t("reports.blocked") : t("reports.failed")}</StatusTag><span className="small muted">{a.error}</span></div>
                )}
              </td>
              <td className="small muted">{f.date(a.created_at)}</td>
              <td className="r" style={{ whiteSpace: "nowrap" }}>
                {a.status === "ready" && a.format === "pdf" && <a className="btn quiet small" href={`/api/artifacts/${a.id}/file?inline=1`} target="_blank" rel="noreferrer">{t("common.open")}</a>}
                {a.status === "ready" && <a className="btn small" href={`/api/artifacts/${a.id}/file`}><I.Download />{t("common.download")}</a>}
                {a.status === "ready" && role !== "client" && <button className="btn quiet small" type="button" onClick={() => { setSharing(a.id); setMade(null); share.reset(); }}>{t("share.button")}</button>}
              </td>
            </tr>
            {sharing === a.id && (
              <tr>
                <td colSpan={5}>
                  {made ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="row">
                        <input className="input" aria-label={t("share.link")} readOnly value={made} style={{ flex: 1 }} />
                        <button className="btn small" type="button" onClick={() => navigator.clipboard.writeText(made)}>{t("share.copy")}</button>
                      </div>
                      <p className="small muted">{t("share.once")}</p>
                    </div>
                  ) : (
                    <div className="row">
                      <select className="input" aria-label={t("share.expires")} value={term} onChange={(e) => setTerm(e.target.value as ShareTerm)}>
                        {TERMS.map((x) => <option key={x} value={x}>{t(`share.term.${x}`)}</option>)}
                      </select>
                      <button className="btn small primary" type="button" disabled={share.isPending} onClick={() => share.mutate({ artifact: a.id, term })}>{t("share.make")}</button>
                      <ErrorText error={share.error} />
                    </div>
                  )}
                </td>
              </tr>
            )}
            </Fragment>
          ))}
          {arts.data?.length === 0 && <tr><td colSpan={5} className="muted">{t("reports.none")}</td></tr>}
        </tbody>
      </table>
      {(links.data ?? []).length > 0 && (
        <>
          <h2 className="h-section">{t("share.title")}</h2>
          <table className="tbl">
            <thead><tr><th>{t("reports.col.report")}</th><th>{t("step.run")}</th><th>{t("share.by")}</th><th>{t("share.on")}</th><th>{t("share.expires")}</th><th className="r">{t("share.openings")}</th><th>{t("share.lastOpened")}</th><th>{t("reports.col.status")}</th><th className="r"><span className="sr-only">{t("share.revoke")}</span></th></tr></thead>
            <tbody>
              {links.data!.map((l) => {
                const state = l.revoked_at ? "revoked" : l.expires_at && new Date(l.expires_at).getTime() <= Date.now() ? "expired" : "active";
                return (
                  <tr key={l.id}>
                    <td>{kind(l.kind)} <span className="faint">· {fmtName(l.format)}</span></td>
                    <td className="num">{t("common.run", { n: l.run_number })}</td>
                    <td className="small muted">{l.created_by}</td>
                    <td className="small muted">{f.date(l.created_at)}</td>
                    <td className="small muted">{l.expires_at ? f.date(l.expires_at) : t("share.term.none")}</td>
                    <td className="num">{l.openings}</td>
                    <td className="small muted">{l.last_opened_at ? f.date(l.last_opened_at) : "—"}</td>
                    <td><StatusTag tone={state === "active" ? "pass" : "neutral"}>{t(`share.${state}`)}</StatusTag></td>
                    <td className="r">{state === "active" && <button className="btn quiet small" type="button" disabled={revoke.isPending} onClick={() => { if (window.confirm(t("share.confirm"))) return revoke.mutate(l.id); }}>{t("share.revoke")}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ErrorText error={revoke.error} />
        </>
      )}
      <p className="small faint">{t("reports.memoLang")}</p>
    </>
  );
}
