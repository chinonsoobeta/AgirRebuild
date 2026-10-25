import { CURRENCY_NAMES, type Currency } from "@agir/contracts";
import { useQuery } from "@tanstack/react-query";
import { api, type SharedReport } from "../api";
import * as I from "../components/icons";
import { Figure, Figures, Tag } from "../components/kit";
import { dealFacts, MetricValue, VerdictBadge } from "../components/ui";
import { useI18n, verdictText, type I18n } from "../i18n";
import { SignedOutPage } from "./auth";

/** The four key figures the shared page shows, by how the deal ends, as the run's reports print them. */
const KEY_FIGURES = {
  refinance_hold: ["total_development_cost", "required_equity", "dcr_after_refinance", "development_spread"],
  sale: ["total_development_cost", "required_equity", "sizing_dscr", "development_spread"],
  for_sale: ["total_development_cost", "required_equity", "profit_on_cost_for_sale", "margin_on_revenue"],
} as const;

/** The verdict and key figures of the shared run, from what the API stored: nothing here is subtracted, divided or rounded into a new figure. */
function SharedRun({ s, i }: { s: SharedReport; i: I18n }) {
  const { t, f, L } = i;
  const figures = s.figures ?? [];
  const find = (k: string) => figures.find((m) => m.key === k);
  const exit = s.exit ?? (find("profit_on_cost_for_sale") ? "for_sale" : find("sizing_dscr") && !find("dcr_after_refinance") ? "sale" : "refinance_hold");
  const shown = KEY_FIGURES[exit].map(find).filter((m): m is NonNullable<typeof m> => m !== undefined);
  // A second line shows a recorded value as it is, and only when that value is valid; never 0 in its place.
  const valid = (k: string) => { const m = find(k); return m && m.status === "VALID" && m.value !== null ? f.value(m.value, m.unit) : undefined; };
  const so = (value: string | undefined, line: (v: string) => string) => (value === undefined ? undefined : line(value));
  const context: Record<string, () => string | undefined> = {
    total_development_cost: () => so(valid("cost_per_unit"), (v) => t("run.sub.perUnit", { v })),
    required_equity: () => so(valid("loan_to_cost"), (v) => t("run.sub.loanToCost", { v })),
    development_spread: () => so(valid("yield_on_cost"), (v) => t("auth.share.yield", { name: L.metric("yield_on_cost"), v, cap: s.exitCapPct === undefined ? "" : f.value(s.exitCapPct, "%") })),
  };
  const gateFor = (k: string) => s.verdict?.gates.find((g) => g.metricKey === k && g.scenario === "base");
  // verdictText reads the checks only to count those with severity "error"; the API sends that count, not the checks.
  const checks = Array.from({ length: s.errorChecks ?? 0 }, () => ({ key: "", kind: "", severity: "error", message: "" }));
  if (!s.verdict && shown.length === 0) return null;
  return (
    <section className="card" aria-label={t("auth.share.figures")}>
      <div className="card-head">
        {s.verdict && <div className="row"><VerdictBadge code={s.verdict.code} /><span>{verdictText(i, s.verdict, checks, false).headline}</span></div>}
        <span className="small muted">{[t("common.run", { n: s.runNumber }), s.runAt ? f.date(s.runAt) : ""].filter(Boolean).join(" · ")}</span>
      </div>
      {shown.length > 0 && (
        <div className="card-pad">
          <Figures>
            {shown.map((m) => {
              const g = gateFor(m.key);
              const sub = m.status !== "VALID" || m.value === null ? (m.reason ? i.msg(m.reason) : undefined)
                : context[m.key]?.() ?? (g ? t("run.gateNeeds", { v: f.value(g.threshold, g.unit) }) : undefined);
              return <Figure key={m.key} k={L.metric(m.key)} v={<MetricValue {...m} />} s={sub} />;
            })}
          </Figures>
        </div>
      )}
      <div className="card-foot small muted">{[s.policyDraft ? t("auth.share.draft") : "", t("auth.share.printed", { n: s.runNumber })].filter(Boolean).join(" ")}</div>
    </section>
  );
}

/** The page a shared link opens: no session, read-only, one report and its run's audit package (card 86). */
export function Share({ secret }: { secret: string }) {
  const i = useI18n();
  const { t, f, L, err, lang } = i;
  const shared = useQuery({ queryKey: ["share", secret], queryFn: () => api.get<SharedReport>(`/share/${secret}`) });
  const base = `/api/share/${secret}`;
  // Only the API's sentence, as the page's heading: a link that does not open says nothing more.
  if (shared.error) return <SignedOutPage><h1 className="h2">{err(shared.error)}</h1></SignedOutPage>;
  if (!shared.data) return <SignedOutPage><p className="muted">{t("common.loading")}</p></SignedOutPage>;
  const s = shared.data;
  const kind = s.kind === "ic_memo" ? t("reports.memo") : s.kind === "lender_package" ? t("reports.lender") : s.kind === "build_decision" ? t("reports.buildDecision") : s.kind === "partner_memo" ? t("reports.partnerMemo") : t("reports.modelExport");
  const format = s.format === "pdf" ? "PDF" : s.format === "docx" ? t("reports.word") : t("reports.excel");
  const failures = s.standardFailures?.[lang] ?? [];
  const currency = CURRENCY_NAMES[s.currency as Currency]?.[lang === "fr" ? 1 : 0];
  return (
    <SignedOutPage tag={<Tag tone="plain">{t("share.readOnly")}</Tag>}>
      <div className="stack">
        <div>
          {s.workspace && <p className="muted auth-from">{t("auth.share.from", { ws: s.workspace })}</p>}
          <h1 className="deal-name">{s.deal}</h1>
          {/* The place, the units and exit, and the currency in words; a link whose run cannot be read keeps the report and run instead. */}
          <p className="meta">{s.location ? [L.place(s.location, s.province ?? null), dealFacts(i, s.units, s.exit), currency ? t("deals.amountsIn", { c: currency }) : ""].filter(Boolean).join(" · ")
            : `${kind} · ${t("common.run", { n: s.runNumber })}`}</p>
        </div>
        <SharedRun s={s} i={i} />
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
