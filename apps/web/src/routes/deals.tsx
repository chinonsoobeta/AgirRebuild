import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type DealOverview } from "../api";
import { canEdit, dealFacts, useSession } from "../components/ui";
import { Tag } from "../components/kit";
import { dealStatus, useI18n } from "../i18n";

const STEPS = ["documents", "review", "run", "decision", "reports"] as const;
const stale = (d: DealOverview) => !!d.run && !d.run.fresh;
/** A date without the time of day, as the reviewer-access page shows one. */
const day = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { year: "numeric", month: "long", day: "numeric" });
const FILTERS = [
  { key: "all", test: () => true },
  { key: "blocked", test: (d: DealOverview) => d.step === "review" },
  { key: "decide", test: (d: DealOverview) => d.step === "decision" },
  { key: "progress", test: (d: DealOverview) => d.step === "documents" || d.step === "run" },
  { key: "decided", test: (d: DealOverview) => d.step === "reports" },
  { key: "stale", test: stale },
] as const;

/** The short state a deal's tag shows; the sentence beside it says the rest. */
const tagKey = (d: DealOverview) => (d.step === "review" ? "blocked" : stale(d) ? "stale" : d.step === "decision" ? "decide" : d.step === "reports" ? "decided" : "progress");

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

export function Deals() {
  const i = useI18n();
  const { t, L, lang } = i;
  const { me, workspaceId, role, solo } = useSession();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const deals = useQuery({
    queryKey: ["deals", workspaceId],
    queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`),
    refetchInterval: (query) => (query.state.data?.some((d) => d.documents.processing > 0) ? 2000 : false),
  });
  const all = deals.data ?? [];
  if (deals.isLoading) return <p className="muted">{t("common.loading")}</p>;
  if (all.length === 0) return <FirstVisit name={me.user.name.trim().split(/\s+/)[0] ?? ""} editor={canEdit(role)} />;

  const count = (k: (typeof FILTERS)[number]["key"]) => all.filter(FILTERS.find((f) => f.key === k)!.test).length;
  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = all.filter(active.test).filter((d) => d.deal.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="h1">{t("deals.title")}</h1>
          <p className="lead deals-lead">{t("deals.lead", { blocked: count("blocked"), ready: count("decide"), progress: count("progress"), decided: count("decided"), solo })}</p>
        </div>
        <div className="row">
          <label className="search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input className="input" type="search" placeholder={t("deals.search")} aria-label={t("deals.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {canEdit(role) && <Link to="/deals/new" className="btn primary">{t("deals.new")}</Link>}
        </div>
      </div>
      <div className="chips" role="group" aria-label={t("deals.filter")}>
        {FILTERS.map((f) => (f.key === "stale" && count("stale") === 0 ? null : (
          <button key={f.key} type="button" aria-pressed={filter === f.key} className={filter === f.key ? "chip on" : "chip"} onClick={() => setFilter(f.key)}>
            {t(`deals.f.${f.key}`)} <span className="chip-n">{count(f.key)}</span>
          </button>
        )))}
      </div>
      <div className="deals deals-list">
        {shown.map((d) => {
          const st = dealStatus(i, d, solo);
          const n = STEPS.indexOf(d.step) + 1;
          const waiting = d.documents.processing > 0 && !d.documents.failed;
          // The tag says the state once; the sentence beside it adds what the tag does not.
          const key = tagKey(d);
          const tag = key === "decided" && d.decision ? L.decision(d.decision.decision) : t(`deals.tag.${key}`);
          const said = key === "decided" && d.decision && d.run ? t("deals.decidedOn", { date: day(d.decision.created_at, lang), n: d.run.number })
            : key === "stale" && d.run ? t("deals.changedAfter", { n: d.run.number })
            : st.blockedParts.length ? st.blockedParts.join(", ") : st.text;
          return (
            <article className="deal" key={d.deal.id}>
              <div>
                <Link to={`/deals/$dealId/${d.step}`} params={{ dealId: d.deal.id }} className="deal-name sm">{d.deal.name}</Link>
                <p className="small muted deal-meta">
                  {/* The board drops the asset type once the units and the exit say what the deal is. */}
                  {[L.place(d.deal.location, d.deal.province), d.units != null && d.exit != null ? "" : L.asset(d.deal.asset_type), dealFacts(i, d.units, d.exit),
                    d.documents.total ? t("deals.docs", { n: d.documents.total }) : ""].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="where">
                <div className="row deal-state"><Tag tone={st.tone}>{tag}</Tag><span>{said}</span></div>
                <div className="dots" role="img" aria-label={t("deals.atStep", { n, step: t(`step.${d.step}`) })}>
                  {STEPS.map((s, k) => <i key={s} className={k + 1 < n ? "done" : k + 1 === n ? "now" : undefined} />)}
                  <span aria-hidden="true">{t(`step.${d.step}`)}</span>
                </div>
              </div>
              {waiting ? (
                <span className="muted deal-next">{st.next}</span>
              ) : (
                <Link to={`/deals/$dealId/${d.step}`} params={{ dealId: d.deal.id }} className="btn quiet">{st.next} <Arrow /></Link>
              )}
            </article>
          );
        })}
        {shown.length === 0 && <p className="muted">{t("deals.noMatch")}</p>}
      </div>
      <p className="small muted deals-foot">{t("deals.evidence")}</p>
    </>
  );
}

function FirstVisit({ name, editor }: { name: string; editor: boolean }) {
  const { t } = useI18n();
  if (!editor) {
    return (
      <div className="page-head">
        <div>
          <h1 className="h1">{t("deals.title")}</h1>
          <p className="lead deals-lead">{t("deals.emptyViewer")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <h1 className="h1 empty-title">{t("deals.welcome", { name })}</h1>
      <p className="lead empty-lead">{t("deals.welcomeLead")}</p>
      <div className="ways">
        <Link to="/deals/new" className="way">
          <span className="h3">{t("deals.way.docs")}</span>
          <p>{t("deals.way.docsBody")}</p>
          <span className="go">{t("deals.new")} <Arrow /></span>
        </Link>
        <Link to="/deals/new" className="way">
          <span className="h3">{t("deals.way.qs")}</span>
          <p>{t("deals.way.qsBody")}</p>
          <span className="go">{t("deals.way.qsGo")} <Arrow /></span>
        </Link>
      </div>
      <p className="small muted empty-lead"><Link to="/legal" hash="privacy">{t("deals.privacy")}</Link></p>
    </div>
  );
}
