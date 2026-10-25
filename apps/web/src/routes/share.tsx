import { useQuery } from "@tanstack/react-query";
import { api, type SharedReport } from "../api";
import * as I from "../components/icons";
import { Tag } from "../components/kit";
import { useI18n } from "../i18n";
import { SignedOutPage } from "./auth";

/** The page a shared link opens: no session, read-only, one report and its run's audit package (card 86). */
export function Share({ secret }: { secret: string }) {
  const { t, f, err, lang } = useI18n();
  const shared = useQuery({ queryKey: ["share", secret], queryFn: () => api.get<SharedReport>(`/share/${secret}`) });
  const base = `/api/share/${secret}`;
  // Only the API's sentence, as the page's heading: a link that does not open says nothing more.
  if (shared.error) return <SignedOutPage><h1 className="h2">{err(shared.error)}</h1></SignedOutPage>;
  if (!shared.data) return <SignedOutPage><p className="muted">{t("common.loading")}</p></SignedOutPage>;
  const s = shared.data;
  const kind = s.kind === "ic_memo" ? t("reports.memo") : s.kind === "lender_package" ? t("reports.lender") : s.kind === "build_decision" ? t("reports.buildDecision") : s.kind === "partner_memo" ? t("reports.partnerMemo") : t("reports.modelExport");
  const format = s.format === "pdf" ? "PDF" : s.format === "docx" ? t("reports.word") : t("reports.excel");
  const failures = s.standardFailures?.[lang] ?? [];
  return (
    <SignedOutPage tag={<Tag tone="plain">{t("share.readOnly")}</Tag>}>
      <div className="stack">
        <div>
          <h1 className="deal-name">{s.deal}</h1>
          <p className="meta">{kind} · {t("common.run", { n: s.runNumber })}</p>
        </div>
        {failures.length > 0 && (
          <section className="card" aria-labelledby="share-failures">
            <div className="card-head"><h2 className="h2" id="share-failures">{t("threshold.citedFailures")}</h2></div>
            <ul className="card-pad">{failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>
          </section>
        )}
        <section className="card" aria-labelledby="share-files">
          <div className="card-head"><h2 className="h2" id="share-files">{t("auth.share.files")}</h2></div>
          <div className="card-pad auth-file">
            <div>{kind}<span className="sub">{format} · {t("common.run", { n: s.runNumber })}</span></div>
            <div className="acts">
              {s.format === "pdf" && <a className="btn quiet sm" href={`${base}/file?inline=1`} target="_blank" rel="noreferrer">{t("common.open")}</a>}
              <a className="btn quiet sm" href={`${base}/file`}><I.Download />{t("common.download")}</a>
            </div>
          </div>
          <div className="card-foot row between">
            <a href={`${base}/audit-package`}>{t("share.package")}</a>
            <span className="small muted">{t("auth.share.packageHint")}</span>
          </div>
        </section>
        <p className="small muted">{s.expiresAt ? t("share.expiry", { date: f.date(s.expiresAt) }) : t("share.noExpiry")} {t("auth.share.recorded")}</p>
      </div>
    </SignedOutPage>
  );
}
