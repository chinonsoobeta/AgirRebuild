import { useQuery } from "@tanstack/react-query";
import { api, type SharedReport } from "../api";
import * as I from "../components/icons";
import { useI18n } from "../i18n";

/** The page a shared link opens: no session, read-only, one report and its run's audit package (card 86). */
export function Share({ secret }: { secret: string }) {
  const { t, f, err, lang } = useI18n();
  const shared = useQuery({ queryKey: ["share", secret], queryFn: () => api.get<SharedReport>(`/share/${secret}`) });
  const base = `/api/share/${secret}`;
  if (shared.error) return <main className="stack" style={{ gap: 12, padding: 24 }}><p>{err(shared.error)}</p></main>;
  if (!shared.data) return <main style={{ padding: 24 }}><p className="muted">{t("common.loading")}</p></main>;
  const s = shared.data;
  const kind = s.kind === "ic_memo" ? t("reports.memo") : s.kind === "lender_package" ? t("reports.lender") : s.kind === "build_decision" ? t("reports.buildDecision") : s.kind === "partner_memo" ? t("reports.partnerMemo") : t("reports.modelExport");
  const format = s.format === "pdf" ? "PDF" : s.format === "docx" ? t("reports.word") : t("reports.excel");
  return (
    <main className="stack" style={{ gap: 12, padding: 24, maxWidth: 720 }}>
      <h1 className="h-section">{s.deal}</h1>
      <p>{kind} <span className="faint">· {format}</span> · {t("common.run", { n: s.runNumber })}</p>
      <p className="small muted">{s.expiresAt ? t("share.expiry", { date: f.date(s.expiresAt) }) : t("share.noExpiry")}</p>
      {(s.standardFailures?.[lang].length ?? 0) > 0 && <section><h2 className="h-section">{t("threshold.citedFailures")}</h2><ul>{s.standardFailures![lang].map((failure,index) => <li key={index}>{failure}</li>)}</ul></section>}
      <div className="row">
        {s.format === "pdf" && <a className="btn quiet" href={`${base}/file?inline=1`} target="_blank" rel="noreferrer">{t("common.open")}</a>}
        <a className="btn" href={`${base}/file`}><I.Download />{t("common.download")}</a>
        <a className="btn quiet" href={`${base}/audit-package`}><I.Download />{t("share.package")}</a>
      </div>
      <p className="small faint">{t("share.readOnly")}</p>
    </main>
  );
}
