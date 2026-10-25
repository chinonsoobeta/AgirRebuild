import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type DealOverview, type Me, type Tone } from "../api";
import { dealStatus, useI18n, type I18n } from "../i18n";
import * as I from "./icons";
import { Notice, Tag, ThemeToggle, type TagTone } from "./kit";

// ---- Session and workspace -----------------------------------------------------------

type Session = { me: Me; workspaceId: string; role: Me["workspaces"][number]["role"]; solo: boolean; setWorkspace: (id: string) => void };
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
  return <SessionCtx.Provider value={{ me: me.data, workspaceId: workspace.id, role: workspace.role, solo: workspace.review_mode === "solo", setWorkspace }}>{children}</SessionCtx.Provider>;
}

export const canEdit = (role: string) => role !== "viewer" && role !== "reviewer" && role !== "client";
export const canDecide = (role: string) => role === "owner" || role === "admin";

// ---- Shell ----------------------------------------------------------------------------

export function LanguageSwitch({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className={className ?? "btn quiet small"} style={className ? undefined : { alignSelf: "flex-start", paddingLeft: 0 }} lang={lang === "en" ? "fr" : "en"} onClick={() => setLang(lang === "en" ? "fr" : "en")}>
      {t("nav.language")}
    </button>
  );
}

const initials = (name: string, email: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? email).slice(0, 2);
  return letters.toUpperCase();
};

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
  const onDeals = path.startsWith("/deals") || path === "/";
  const onSettings = path.startsWith("/settings");
  return (
    <>
      <header className="topbar">
        <Link to="/deals" className="brand">
          <span className="brand-mark">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18L12 5l8 13" /><path d="M8 18h8" /></svg>
          </span>
          {t("shell.brand")}
        </Link>
        <nav className="nav" aria-label={t("shell.mainNav")}>
          <Link to="/deals" className={onDeals ? "current" : undefined} aria-current={onDeals ? "page" : undefined}>{t("nav.deals")}</Link>
          <Link to="/settings" className={onSettings ? "current" : undefined} aria-current={onSettings ? "page" : undefined}>{t("nav.settings")}</Link>
        </nav>
        <div className="topbar-right">
          {me.workspaces.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="ws-select">{t("common.workspace")}</label>
              <select id="ws-select" className="ws" value={workspaceId} onChange={(e) => setWorkspace(e.target.value)}>
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </>
          ) : (
            <span className="ws-name">{me.workspaces[0]?.name}</span>
          )}
          <LanguageSwitch className="toplink" />
          <ThemeToggle />
          <span className="avatar" aria-hidden="true">{initials(me.user.name, me.user.email)}</span>
          <span className="who">{me.user.name} · {L.role(role)}</span>
          <button type="button" className="toplink" onClick={signOut}>{t("nav.signOut")}</button>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

// ---- Status -------------------------------------------------------------------------------

/** A status as the design's tag: a dot and a word. A glyph, when one is given, stands in for the dot. */
export function StatusTag({ tone, children, glyph }: { tone: Tone; children: ReactNode; glyph?: (p: { size?: number }) => React.JSX.Element }) {
  const cls = tone === "neutral" ? "tag" : `tag ${tone}`;
  if (!glyph) return <span className={cls}>{children}</span>;
  const G = glyph;
  return <span className={`${cls} plain`}><G size={14} />{children}</span>;
}

const VERDICT_TONE: Record<string, TagTone> = { APPROVE: "pass", APPROVE_WITH_CONDITIONS: "review", REJECT: "stop" };
export function VerdictBadge({ code }: { code: string }) {
  const { L } = useI18n();
  return <Tag tone={VERDICT_TONE[code] ?? "neutral"}>{L.verdict(code)}</Tag>;
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
  return <Notice tone={tone === "neutral" ? undefined : tone} title={title} role="status">{children}</Notice>;
}

export function ErrorText({ error }: { error: unknown }) {
  const { err } = useI18n();
  if (!error) return null;
  return <p className="error-text" role="alert">{err(error)}</p>;
}

/** What the main figures mean, in a sentence each. Shown on the Run and Review pages. */
const GLOSSARY = ["dcr", "noi", "capRate", "yieldOnCost", "loanToCost", "equityIrr", "equityMultiple", "breakEven"] as const;
export function Glossary() {
  const { t } = useI18n();
  return (
    <details>
      <summary>{t("glossary.title")}</summary>
      <dl className="stack" style={{ gap: 10, marginTop: 12 }}>
        {GLOSSARY.map((k) => {
          const [term, meaning] = t(`glossary.${k}`);
          return <div key={k}><dt style={{ fontWeight: 600 }}>{term}</dt><dd className="muted">{meaning}</dd></div>;
        })}
      </dl>
    </details>
  );
}

// ---- Deal frame and path ----------------------------------------------------------------

const STEPS = ["documents", "review", "run", "decision", "reports"] as const;

/** Review waits on documents only when the deal has neither documents nor entered values, or documents are still being read. */
export function reviewWaiting(o: Pick<DealOverview, "documents" | "review">): boolean {
  const r = o.review;
  const hasValues = r.approved + r.needsReview + r.conflicting + r.awaitingSecond > 0;
  return o.documents.processing > 0 || (o.documents.total === 0 && !hasValues);
}

type StepKey = (typeof STEPS)[number];
export type PathState = { key: StepKey; text: string; tone: "done" | "stop" | "faint" | "normal" };

/** What each of the five steps says about a deal, and in which tone. */
export function pathStates(o: DealOverview, i: I18n, solo: boolean): PathState[] {
  const { t, L } = i;
  const status = dealStatus(i, o, solo);
  const order: string[] = [...STEPS];
  const state = (key: StepKey): Omit<PathState, "key"> => {
    const past = order.indexOf(key) < order.indexOf(o.step);
    switch (key) {
      case "documents":
        if (o.documents.total === 0) return { text: t("step.noDocs"), tone: "faint" };
        if (o.documents.processing) return { text: t("step.reading", { n: o.documents.processing }), tone: "normal" };
        return { text: t("step.read", { n: o.documents.total, failed: o.documents.failed }), tone: o.documents.failed ? "stop" : "done" };
      case "review":
        if (reviewWaiting(o)) return { text: t("step.waitingDocs"), tone: "faint" };
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
  return STEPS.map((key) => ({ key, ...state(key) }));
}

/** The five steps across the top of a deal: done, where the deal is (now), and the page being viewed (here). */
export function DealPath({ o, active }: { o: DealOverview; active: string }) {
  const i = useI18n();
  const { solo } = useSession();
  return (
    <ol className="path" aria-label={i.t("step.steps")}>
      {pathStates(o, i, solo).map((st) => {
        const cls = ["step", st.tone === "done" && "done", o.step === st.key && "now", active === st.key && "here"].filter(Boolean).join(" ");
        return (
          <li key={st.key}>
            <Link to={`/deals/$dealId/${st.key}`} params={{ dealId: o.deal.id }} className={cls} aria-current={active === st.key ? "step" : undefined}>
              <span className="marker">{st.tone === "done" && <I.Check size={9} />}</span>
              <span className="step-name">{i.t(`step.${st.key}`)}</span>
              <span className={st.tone === "stop" ? "step-state stop" : st.tone === "faint" ? "step-state faint" : "step-state"}>
                {st.tone === "stop" && <I.Stop size={12} />}
                {st.text}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/** The head of every deal page: back to the deals, the name and its facts, the actions, and the path. */
export function DealFrame({ o, active }: { o: DealOverview; active: string }) {
  const { t, L } = useI18n();
  const { role } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const copy = useMutation({
    mutationFn: (name: string) => api.post<{ id: string }>(`/deals/${o.deal.id}/copy`, { name }),
    onSuccess: async (r) => {
      dialog.current?.close();
      await qc.invalidateQueries({ queryKey: ["deals"] });
      void navigate({ to: "/deals/$dealId/review", params: { dealId: r.id } });
    },
  });
  const defaultName = `${o.deal.name}${t("copy.suffix")}`.slice(0, 160);
  return (
    <>
      <div className="deal-head">
        <div>
          <Link to="/deals" className="back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
            {t("shell.allDeals")}
          </Link>
          <h1 className="deal-name">{o.deal.name}</h1>
          <p className="meta">{[L.asset(o.deal.asset_type), L.place(o.deal.location, o.deal.province), L.currency(o.deal.currency)].filter(Boolean).join(" · ")}</p>
          {o.copiedFrom && (
            <p className="small muted variant-of">{t("copy.variantOf")} <Link to="/deals/$dealId/review" params={{ dealId: o.copiedFrom.id }}>{o.copiedFrom.name}</Link></p>
          )}
        </div>
        <div className="actions">
          {o.run && <Link to="/deals/$dealId/explore" params={{ dealId: o.deal.id }} className="btn quiet sm">{t("explore.title")}</Link>}
          <Link to="/deals/$dealId/audit" params={{ dealId: o.deal.id }} className="btn quiet sm">{t("step.audit")}</Link>
          {canEdit(role) && (
            <button
              className="btn quiet sm"
              type="button"
              onClick={() => {
                // Each opening starts from this deal's name in the current language, with no earlier error.
                const field = dialog.current?.querySelector<HTMLInputElement>("#cd-name");
                if (field) field.value = defaultName;
                copy.reset();
                dialog.current?.showModal();
              }}
            >
              {t("copy.button")}
            </button>
          )}
        </div>
      </div>
      <dialog ref={dialog} aria-labelledby="copy-deal-title">
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            copy.mutate(String(new FormData(e.currentTarget).get("name")));
          }}
        >
          <h2 id="copy-deal-title" className="h2">{t("copy.title")}</h2>
          <p className="muted">{t("copy.intro")}</p>
          <div className="field"><label htmlFor="cd-name">{t("copy.name")}</label><input className="input" id="cd-name" name="name" required maxLength={160} defaultValue={defaultName} /></div>
          <ErrorText error={copy.error} />
          <div className="row"><button className="btn primary" type="submit" disabled={copy.isPending}>{t("copy.create")}</button><button className="btn quiet" type="button" onClick={() => dialog.current?.close()}>{t("common.cancel")}</button></div>
        </form>
      </dialog>
      <DealPath o={o} active={active} />
    </>
  );
}

export function useDeal(dealId: string, poll = false) {
  const {workspaceId,setWorkspace}=useSession();
  const query=useQuery({
    queryKey: ["deal", dealId],
    queryFn: () => api.get<DealOverview>(`/deals/${dealId}`),
    refetchInterval: (q) => (poll || (q.state.data?.documents.processing ?? 0) > 0 || q.state.data?.updating ? 1500 : false),
  });
  const dealWorkspace=query.data?.deal.workspace_id;
  useEffect(()=>{
    if (dealWorkspace && dealWorkspace !== workspaceId) setWorkspace(dealWorkspace);
  },[dealWorkspace,workspaceId,setWorkspace]);
  return query;
}

/** Retry the exact rejected payload only after the person confirms the window warning. */
export function WindowConfirmation({ error, busy, onConfirm }: { error: unknown; busy: boolean; onConfirm: () => void }) {
  const { t } = useI18n();
  if (!(error instanceof ApiError && error.status === 422 && error.detail?.code === "outside_window")) return null;
  return <button className="btn small" type="button" disabled={busy} onClick={onConfirm}>{t("review.useOutsideWindow")}</button>;
}
