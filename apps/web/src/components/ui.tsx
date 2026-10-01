import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type DealOverview, type Me, type Tone } from "../api";
import { dealStatus, useI18n } from "../i18n";
import * as I from "./icons";

// ---- Session and workspace -----------------------------------------------------------

type Session = { me: Me; workspaceId: string; role: Me["workspaces"][number]["role"]; setWorkspace: (id: string) => void };
const SessionCtx = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("No session");
  return s;
};

function storedWorkspace(): string | null {
  try {
    return localStorage.getItem("agir.workspace");
  } catch {
    return null;
  }
}

export function SessionGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), retry: false });
  const [ws, setWs] = useState<string | null>(storedWorkspace());
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) void navigate({ to: "/login" });
  }, [me.error, navigate]);
  if (me.isLoading) return <div style={{ padding: 56 }} aria-busy="true">{t("common.loading")}</div>;
  if (!me.data) return null;
  const workspace = me.data.workspaces.find((w) => w.id === ws) ?? me.data.workspaces[0];
  if (!workspace) return <div style={{ padding: 56 }}>—</div>;
  const setWorkspace = (id: string) => {
    setWs(id);
    try {
      localStorage.setItem("agir.workspace", id);
    } catch {
      /* private window: the choice lasts for this tab only */
    }
  };
  return <SessionCtx.Provider value={{ me: me.data, workspaceId: workspace.id, role: workspace.role, setWorkspace }}>{children}</SessionCtx.Provider>;
}

export const canEdit = (role: string) => role !== "viewer";
export const canDecide = (role: string) => role === "owner" || role === "admin";

// ---- Shell ----------------------------------------------------------------------------

export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className="btn quiet small" style={{ alignSelf: "flex-start", paddingLeft: 0 }} lang={lang === "en" ? "fr" : "en"} onClick={() => setLang(lang === "en" ? "fr" : "en")}>
      {t("nav.language")}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, workspaceId, setWorkspace, role } = useSession();
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const signOut = async () => {
    await api.post("/auth/logout");
    qc.clear();
    void navigate({ to: "/login" });
  };
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <Link to="/deals" className="brand" aria-label="Agir">
          <i />
          <b>agir</b>
        </Link>
        <div className="nav">
          <Link to="/deals" aria-current={path.startsWith("/deals") || path === "/" ? "page" : undefined}>{t("nav.deals")}</Link>
          <Link to="/settings" aria-current={path.startsWith("/settings") ? "page" : undefined}>{t("nav.settings")}</Link>
        </div>
        <div className="rail-foot">
          <div className="wide-only stack" style={{ gap: 8 }}>
            <label className="sr-only" htmlFor="ws-select">{t("common.workspace")}</label>
            {me.workspaces.length > 1 ? (
              <select id="ws-select" value={workspaceId} onChange={(e) => setWorkspace(e.target.value)}>
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            ) : (
              <span style={{ fontWeight: 600 }}>{me.workspaces[0]?.name}</span>
            )}
            <span className="faint">{me.user.name} · {L.role(role)}</span>
          </div>
          <LanguageSwitch />
          <button type="button" className="btn quiet small" style={{ alignSelf: "flex-start", paddingLeft: 0 }} onClick={signOut}>{t("nav.signOut")}</button>
        </div>
      </nav>
      <main className="page">{children}</main>
    </div>
  );
}

// ---- Status -------------------------------------------------------------------------------

const TONE_GLYPH: Record<Tone, (p: { size?: number }) => React.JSX.Element> = { pass: I.Check, review: I.Eye, stop: I.Stop, neutral: I.Spinner };

export function StatusTag({ tone, children, glyph }: { tone: Tone; children: ReactNode; glyph?: (p: { size?: number }) => React.JSX.Element }) {
  const G = glyph ?? TONE_GLYPH[tone];
  return <span className={`tag ${tone}`}><G size={14} />{children}</span>;
}

export function VerdictBadge({ code }: { code: string }) {
  const { L } = useI18n();
  const G = code === "APPROVE" ? I.Check : code === "APPROVE_WITH_CONDITIONS" ? I.Eye : code === "REJECT" ? I.Stop : I.Dashed;
  return <span className={`badge ${code}`}><G size={14} />{L.verdict(code)}</span>;
}

export function MetricValue({ value, unit, status, reason }: { value: number | null; unit: string; status: string; reason?: string | undefined }) {
  const { t, f, msg } = useI18n();
  if (status !== "VALID" || value === null) {
    return (
      <span className="not-meaningful" title={msg(reason)}>
        {status === "NOT_APPLICABLE" ? t("common.notApplicable") : t("common.notMeaningful")}
      </span>
    );
  }
  return <span className="num">{f.value(value, unit)}</span>;
}

export function Banner({ tone, title, children }: { tone: "stop" | "review" | "neutral"; title: string; children?: ReactNode }) {
  const G = tone === "stop" ? I.Stop : tone === "review" ? I.Eye : I.Dashed;
  return (
    <div className={`banner ${tone}`} role="status">
      <G size={18} />
      <div className="stack" style={{ gap: 4 }}>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { err } = useI18n();
  if (!error) return null;
  return <p className="error-text" role="alert">{err(error)}</p>;
}

// ---- Deal header and stepper ----------------------------------------------------------------

const STEPS = ["documents", "review", "run", "decision", "reports"] as const;

export function DealHeader({ o, active }: { o: DealOverview; active: string }) {
  const i = useI18n();
  const { t, L } = i;
  const status = dealStatus(i, o);
  const order: string[] = [...STEPS];
  const state = (key: string): { text: string; tone: "done" | "stop" | "faint" | "normal" } => {
    const past = order.indexOf(key) < order.indexOf(o.step);
    switch (key) {
      case "documents":
        if (o.documents.total === 0) return { text: t("step.noDocs"), tone: "faint" };
        if (o.documents.processing) return { text: t("step.reading", { n: o.documents.processing }), tone: "normal" };
        return { text: t("step.read", { n: o.documents.total, failed: o.documents.failed }), tone: o.documents.failed ? "stop" : "done" };
      case "review":
        if (o.documents.total === 0 || o.documents.processing) return { text: t("step.waitingDocs"), tone: "faint" };
        if (o.review.status === "ready") return { text: t("step.clear"), tone: "done" };
        return { text: status.text, tone: "stop" };
      case "run":
        if (!o.run) return { text: o.review.status === "ready" ? t("step.readyToRun") : t("step.locked"), tone: "faint" };
        return { text: t("step.runState", { n: o.run.number, state: o.run.fresh ? L.verdict(o.run.verdict) : t("step.outOfDate") }), tone: o.run.fresh ? (past ? "done" : "normal") : "stop" };
      case "decision":
        if (o.decision) return { text: L.decision(o.decision.decision), tone: "done" };
        return { text: o.run?.fresh ? t("step.notRecorded") : t("step.waiting"), tone: "faint" };
      default:
        return { text: o.reports ? t("step.ready", { n: o.reports }) : t("step.noneYet"), tone: o.reports ? "done" : "faint" };
    }
  };
  return (
    <>
      <div className="stack" style={{ gap: 10 }}>
        <Link to="/deals" className="small muted">{t("nav.deals")}</Link>
        <div className="spread" style={{ alignItems: "flex-end" }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="h-title">{o.deal.name}</h1>
            <span className="muted">{[L.asset(o.deal.asset_type), L.place(o.deal.location, o.deal.province), L.currency(o.deal.currency)].filter(Boolean).join(" · ")}</span>
          </div>
          <Link to="/deals/$dealId/audit" params={{ dealId: o.deal.id }} className="btn small">{t("step.audit")}</Link>
        </div>
      </div>
      <ol className="stepper" aria-label={t("step.steps")}>
        {STEPS.map((key, n) => {
          const st = state(key);
          return (
            <li key={key}>
              <Link to={`/deals/$dealId/${key}`} params={{ dealId: o.deal.id }} aria-current={active === key ? "step" : undefined}>
                <span className="step-name"><span className="num">0{n + 1}</span>{t(`step.${key}`)}</span>
                <span className={`step-state ${st.tone === "stop" ? "stop" : st.tone === "faint" ? "faint" : ""}`}>
                  {st.tone === "done" && <I.Check size={12} />}
                  {st.tone === "stop" && <I.Stop size={12} />}
                  {st.text}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function useDeal(dealId: string, poll = false) {
  return useQuery({
    queryKey: ["deal", dealId],
    queryFn: () => api.get<DealOverview>(`/deals/${dealId}`),
    refetchInterval: (q) => (poll || (q.state.data?.documents.processing ?? 0) > 0 ? 1500 : false),
  });
}
