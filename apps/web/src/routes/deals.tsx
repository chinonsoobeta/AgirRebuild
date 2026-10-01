import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, type DealOverview } from "../api";
import { canEdit, ErrorText, StatusTag, useSession } from "../components/ui";
import * as I from "../components/icons";
import { dealStatus, useI18n } from "../i18n";

const STEP_N: Record<string, string> = { documents: "01", review: "02", run: "03", decision: "04", reports: "05" };
const FILTERS = [
  { key: "all", test: () => true },
  { key: "blocked", test: (d: DealOverview) => d.step === "review" },
  { key: "decide", test: (d: DealOverview) => d.step === "decision" },
  { key: "progress", test: (d: DealOverview) => d.step === "documents" || d.step === "run" },
  { key: "decided", test: (d: DealOverview) => d.step === "reports" },
] as const;
const ASSET_TYPES = ["Multifamily", "Mixed-use", "Industrial", "Office", "Retail", "Hospitality", "Self storage", "Other"];

export function Deals() {
  const i = useI18n();
  const { t, L } = i;
  const { workspaceId, role } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const deals = useQuery({
    queryKey: ["deals", workspaceId],
    queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`),
    refetchInterval: (query) => (query.state.data?.some((d) => d.documents.processing > 0) ? 2000 : false),
  });
  const create = useMutation({
    mutationFn: (body: { name: string; assetType: string; location: string }) => api.post<{ id: string }>(`/workspaces/${workspaceId}/deals`, body),
    onSuccess: async (r) => {
      dialog.current?.close();
      await qc.invalidateQueries({ queryKey: ["deals"] });
      void navigate({ to: "/deals/$dealId/documents", params: { dealId: r.id } });
    },
  });
  const all = deals.data ?? [];
  const blocked = all.filter((d) => d.step === "review").length;
  const ready = all.filter((d) => d.step === "decision").length;
  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = all.filter(active.test).filter((d) => d.deal.name.toLowerCase().includes(q.toLowerCase()));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({ name: String(f.get("name")), assetType: String(f.get("assetType")), location: String(f.get("location") ?? "") });
  };
  return (
    <>
      <div className="spread" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h-title" style={{ fontSize: 44 }}>{t("deals.title")}</h1>
          <p className="muted">{all.length === 0 ? t("deals.none") : t("deals.summary", { blocked, ready })}</p>
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="deal-search">{t("deals.search")}</label>
          <div className="input-affix" style={{ width: 280 }}>
            <input id="deal-search" type="search" placeholder={t("deals.search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ fontFamily: "var(--sans)" }} />
          </div>
          {canEdit(role) && <button className="btn primary" type="button" onClick={() => dialog.current?.showModal()}>{t("deals.new")}</button>}
        </div>
      </div>
      <div className="row" role="group" aria-label={t("deals.filter")}>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} className={`btn small ${filter === f.key ? "primary" : ""}`} onClick={() => setFilter(f.key)}>
            {t(`deals.f.${f.key}`)} <span className="num" style={{ opacity: 0.75 }}>{all.filter(f.test).length}</span>
          </button>
        ))}
      </div>
      {deals.isLoading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th style={{ width: "34%" }}>{t("deals.col.deal")}</th><th style={{ width: "14%" }}>{t("deals.col.step")}</th><th style={{ width: "26%" }}>{t("deals.col.status")}</th><th>{t("deals.col.next")}</th></tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const st = dealStatus(i, d);
              return (
                <tr key={d.deal.id}>
                  <td>
                    <div className="stack" style={{ gap: 2 }}>
                      <Link to={`/deals/$dealId/${d.step}`} params={{ dealId: d.deal.id }} style={{ fontWeight: 600, textDecoration: "none" }}>{d.deal.name}</Link>
                      <span className="small faint">{[L.asset(d.deal.asset_type), d.deal.location].filter(Boolean).join(" · ")}{d.documents.total ? ` · ${t("deals.docs", { n: d.documents.total })}` : ""}</span>
                    </div>
                  </td>
                  <td className="muted"><span className="num faint" style={{ marginRight: 8 }}>{STEP_N[d.step]}</span>{t(`step.${d.step}`)}</td>
                  <td><StatusTag tone={st.tone}>{st.text}</StatusTag></td>
                  <td>
                    <Link to={`/deals/$dealId/${d.step}`} params={{ dealId: d.deal.id }} className="row" style={{ gap: 6, fontWeight: 500 }}>
                      {st.next}<I.Chevron />
                    </Link>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={4} className="muted">{all.length === 0 ? t("deals.empty") : t("deals.noMatch")}</td></tr>}
          </tbody>
        </table>
      )}
      <p className="small faint">{t("deals.evidence")}</p>
      <dialog ref={dialog} aria-labelledby="new-deal-title">
        <form onSubmit={submit}>
          <h2 id="new-deal-title" className="h-section">{t("deals.new")}</h2>
          <div className="field"><label htmlFor="nd-name">{t("deals.name")}</label><input className="input" id="nd-name" name="name" required maxLength={160} /></div>
          <div className="field"><label htmlFor="nd-type">{t("deals.assetType")}</label><select className="select" id="nd-type" name="assetType">{ASSET_TYPES.map((a) => <option key={a} value={a}>{L.asset(a)}</option>)}</select></div>
          <div className="field"><label htmlFor="nd-loc">{t("deals.location")}</label><input className="input" id="nd-loc" name="location" maxLength={160} placeholder={t("deals.locationHint")} /></div>
          <ErrorText error={create.error} />
          <div className="row"><button className="btn primary" type="submit" disabled={create.isPending}>{t("deals.create")}</button><button className="btn quiet" type="button" onClick={() => dialog.current?.close()}>{t("common.cancel")}</button></div>
        </form>
      </dialog>
    </>
  );
}
