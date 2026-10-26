import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { api, type ClientInvite, type DealClient, type DealOverview } from "../api";
import { ErrorText, useSession } from "../components/ui";
import { ChangeEmail } from "./verify";
import { Thresholds } from "../components/thresholds";
import { useI18n } from "../i18n";
import { useTheme, type ThemePref } from "../theme";
import { TermsSeg } from "../components/terms-seg";
import { Figure, Figures, Notice, Seg, Switch, Tag } from "../components/kit";

/** A deal's clients and its invitation links (card 89). Admins and owners only; an invitation link is shown once. */
export function ClientsPanel({ dealId }: { dealId: string }) {
  const { t, f } = useI18n();
  const qc = useQueryClient();
  const [made, setMade] = useState<string | null>(null);
  const clients = useQuery({ queryKey: ["deal-clients", dealId], queryFn: () => api.get<DealClient[]>(`/deals/${dealId}/clients`) });
  const invites = useQuery({ queryKey: ["invites", dealId], queryFn: () => api.get<ClientInvite[]>(`/deals/${dealId}/invites`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["deal-clients", dealId] }), qc.invalidateQueries({ queryKey: ["invites", dealId] })]);
  const add = useMutation({ mutationFn: (email: string) => api.post(`/deals/${dealId}/clients`, { email }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/deals/${dealId}/clients/${id}`, {}), onSuccess: refresh });
  const invite = useMutation({
    mutationFn: () => api.post<{ id: string; url: string }>(`/deals/${dealId}/invites`),
    onSuccess: (r) => { setMade(window.location.origin + r.url); return refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/invites/${id}/revoke`), onSuccess: refresh });
  const status = (i: ClientInvite) => i.revoked_at ? t("clients.revoked") : i.used_at ? t("clients.used", { who: i.used_by }) : new Date(i.expires_at) <= new Date() ? t("clients.expired") : null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <strong>{t("clients.ofDeal")}</strong>
      {(clients.data ?? []).length === 0 ? <p className="small muted">{t("clients.none")}</p> : (
        <table className="table">
          <tbody>
            {(clients.data ?? []).map((c) => (
              <tr key={c.id}><td>{c.name}</td><td className="muted">{c.email}</td>
                <td className="acts"><button className="btn ghost sm" type="button" onClick={() => { if (window.confirm(t("clients.removeConfirm"))) remove.mutate(c.id); }}>{t("clients.remove")}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="stack"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          add.mutate((e.currentTarget.elements.namedItem("email") as HTMLInputElement).value);
          e.currentTarget.reset();
        }}
      >
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 260px" }}><label htmlFor="c-email">{t("clients.add")}</label><input className="input" id="c-email" name="email" type="email" required /></div>
          <button className="btn primary" type="submit">{t("settings.addBtn")}</button>
        </div>
      </form>
      <ErrorText error={add.error ?? remove.error} />
      <p className="small muted">{t("clients.inviteBody")}</p>
      <div><button className="btn quiet" type="button" disabled={invite.isPending} onClick={() => { setMade(null); invite.mutate(); }}>{t("clients.invite")}</button></div>
      {made && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <input className="input" aria-label={t("clients.link")} readOnly value={made} style={{ flex: 1 }} />
            <button className="btn quiet sm" type="button" onClick={() => navigator.clipboard.writeText(made)}>{t("share.copy")}</button>
          </div>
          <span className="small muted">{t("share.once")}</span>
        </div>
      )}
      <ErrorText error={invite.error ?? revoke.error} />
      {(invites.data ?? []).length > 0 && (
        <>
          <strong>{t("clients.invites")}</strong>
          <table className="table">
            <thead><tr><th>{t("share.by")}</th><th>{t("share.on")}</th><th>{t("share.expires")}</th><th>{t("reports.col.status")}</th><th className="r"><span className="set-vh">{t("share.revoke")}</span></th></tr></thead>
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.created_by}</td><td className="muted">{f.date(i.created_at)}</td><td className="muted">{f.date(i.expires_at)}</td>
                  <td>{status(i) ?? t("clients.open")}</td>
                  <td className="r">{!status(i) && <button className="btn ghost sm" type="button" onClick={() => { if (window.confirm(t("clients.revokeConfirm"))) revoke.mutate(i.id); }}>{t("share.revoke")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** The owner's logo for the lender package (card 89d): upload, preview, remove. */
export function LogoPanel({ workspaceId, hasLogo }: { workspaceId: string; hasLogo: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  const done = () => { setVersion(version + 1); return qc.invalidateQueries({ queryKey: ["me"] }); };
  const upload = useMutation({ mutationFn: (file: File) => api.upload(`/workspaces/${workspaceId}/logo`, file, "POST"), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.del(`/workspaces/${workspaceId}/logo`, {}), onSuccess: done });
  return (
    <section className="card card-pad section" id="logo">
      <h2 className="h2">{t("logo.title")}</h2>
      <p className="muted">{t("logo.body")}</p>
      {hasLogo && (
        <div className="row" style={{ alignItems: "center" }}>
          <img src={`/api/workspaces/${workspaceId}/logo?v=${version}`} alt={t("logo.title")} style={{ maxHeight: 48, maxWidth: 240 }} />
          <button className="btn ghost sm" type="button" onClick={() => { if (window.confirm(t("logo.removeConfirm"))) remove.mutate(); }}>{t("clients.remove")}</button>
        </div>
      )}
      <div className="field">
        <label htmlFor="logo-file">{hasLogo ? t("logo.replace") : t("logo.choose")}</label>
        <input id="logo-file" type="file" accept="image/png,image/jpeg"
          onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) upload.mutate(file); }} />
      </div>
      <ErrorText error={upload.error ?? remove.error} />
    </section>
  );
}

/** Production counts per deal (card 155): counts and durations only, for the owner. */
type DealCounts = { deal_id?: string; name?: string; docs_pdf: number; docs_xlsx: number; docs_csv: number; docs_docx: number; docs_txt: number; docs_no_candidates: number;
  figures_read: number; figures_confirmed_from_suggestion: number; figures_typed: number; actions_until_runnable: number; minutes_upload_to_run?: number | null };
export function CountsPanel({ workspaceId }: { workspaceId: string }) {
  const { t, lang } = useI18n();
  // The plain totals (card X2) only count and add up records: deals, runs, report files, documents.
  const list = useQuery({ queryKey: ["deals", workspaceId], queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`) });
  const sum = (n: (d: DealOverview) => number) => (list.data ?? []).reduce((total, d) => total + n(d), 0);
  const q = useQuery({ queryKey: ["deal-metrics", workspaceId], queryFn: () => api.get<{ deals: DealCounts[]; totals: DealCounts & { deals: number; archived_deals?: number;
    runs?: number; first_run_at?: string | null; reports?: number; reports_shared?: number } }>(`/workspaces/${workspaceId}/deal-metrics`) });
  const cells = (r: DealCounts) => [
    [r.docs_pdf, r.docs_xlsx, r.docs_csv, r.docs_docx, r.docs_txt].join(" / "), r.docs_no_candidates, r.figures_read,
    r.figures_confirmed_from_suggestion, r.figures_typed, r.actions_until_runnable,
  ];
  const deals = q.data?.deals ?? [];
  const archived = q.data?.totals.archived_deals ?? 0;
  // Runs and report files are counted by the server for the deals that are not archived (card R4).
  const totals = q.data?.totals;
  const runs = typeof totals?.runs === "number" ? totals.runs : null;
  const reports = typeof totals?.reports === "number" ? totals.reports : null;
  return (
    <section className="card card-pad section" id="counts">
      <h2 className="h2">{t("counts.title")}</h2>
      <p className="muted">{t("counts.body")}</p>
      {list.data && (
        <Figures>
          {/* The list leaves archived deals out; the counts say how many there are (card Z1). */}
          <Figure k={t("settings.ct.deals")} v={list.data.length} s={archived > 0 ? t("settings.ct.archived", { n: archived }) : undefined} />
          <Figure k={t("settings.ct.runs")} v={runs ?? "—"} s={runs !== null && runs > 0 && totals?.first_run_at ? t("settings.ct.since", { date: sinceDay(totals.first_run_at, lang) }) : undefined} />
          <Figure k={t("settings.ct.reports")} v={reports ?? "—"} s={totals?.reports_shared ? t("settings.ct.shared", { n: totals.reports_shared }) : undefined} />
          <Figure k={t("settings.ct.docs")} v={sum((d) => d.documents.total)} s={q.data ? t("settings.ct.typing", { n: q.data.totals.docs_no_candidates }) : undefined} />
        </Figures>
      )}
      <ErrorText error={list.error} />
      <details className="set-each">
        <summary>{t("settings.ct.each")}</summary>
      {q.data && deals.length === 0 ? <p className="small muted">{t("counts.none")}</p> : deals.length > 0 && (
        <div className="scroll">
          <table className="table counts">
            <thead><tr><th>{t("counts.deal")}</th><th>{t("counts.docs")}</th><th className="r">{t("counts.noCandidates")}</th><th className="r">{t("counts.read")}</th>
              <th className="r">{t("counts.suggested")}</th><th className="r">{t("counts.typed")}</th><th className="r">{t("counts.actions")}</th><th className="r">{t("counts.minutes")}</th></tr></thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.deal_id}><td>{d.name}</td>{cells(d).map((v, i) => <td key={i} className={i ? "r" : undefined}>{v}</td>)}<td className="r">{d.minutes_upload_to_run ?? "—"}</td></tr>
              ))}
            </tbody>
            {q.data && <tfoot><tr><th scope="row">{t("counts.total")}</th>{cells(q.data.totals).map((v, i) => <td key={i} className={i ? "r" : undefined}>{v}</td>)}<td /></tr></tfoot>}
          </table>
        </div>
      )}
      </details>
      <ErrorText error={q.error} />
    </section>
  );
}

const day = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { year: "numeric", month: "long", day: "numeric" });
/** A short day, as the board's "18 Oct"; the year only when it is not this year. */
const shortDay = (iso: string, lang: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

/** The day runs began, as the board's "1 Oct 2026": always with its year. */
const sinceDay = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", year: "numeric" });

/** A signed-in session as the server lists it (card R4); `device` is null for one made before devices were kept. */
type SignedIn = { device: string | null; signedInAt: string; current: boolean };
const DEVICE_SLUG: Record<string, "mac" | "iphone" | "ipad" | "androidPhone" | "androidTablet" | "windows" | "linux" | "chromebook"> = {
  Mac: "mac", iPhone: "iphone", iPad: "ipad", "Android phone": "androidPhone", "Android tablet": "androidTablet", "Windows PC": "windows", "Linux computer": "linux", Chromebook: "chromebook",
};
const deviceSlug = (device: string | null) => (device && DEVICE_SLUG[device]) || "unknown";

/** Every deal's clients and open invitations in one table, and the form that invites a client to a deal (card X2). */
function Clients() {
  const { t, lang } = useI18n();
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const deals = useQuery({ queryKey: ["deals", workspaceId], queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`) });
  const list = deals.data ?? [];
  const clients = useQueries({ queries: list.map((d) => ({ queryKey: ["deal-clients", d.deal.id], queryFn: () => api.get<DealClient[]>(`/deals/${d.deal.id}/clients`) })) });
  const invites = useQueries({ queries: list.map((d) => ({ queryKey: ["invites", d.deal.id], queryFn: () => api.get<ClientInvite[]>(`/deals/${d.deal.id}/invites`) })) });
  const [dealId, setDealId] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  // Focus moves to the link box only after "Make a new link", whose button sits far from the box.
  const [focusMade, setFocusMade] = useState(false);
  const chosen = list.find((d) => d.deal.id === dealId)?.deal.id ?? list[0]?.deal.id;
  const refresh = (id: string) => Promise.all([qc.invalidateQueries({ queryKey: ["deal-clients", id] }), qc.invalidateQueries({ queryKey: ["invites", id] })]);
  const add = useMutation({ mutationFn: (b: { dealId: string; email: string }) => api.post(`/deals/${b.dealId}/clients`, { email: b.email }), onSuccess: (_r, b) => refresh(b.dealId) });
  const remove = useMutation({ mutationFn: (b: { dealId: string; id: string }) => api.del(`/deals/${b.dealId}/clients/${b.id}`, {}), onSuccess: (_r, b) => refresh(b.dealId) });
  const withdraw = useMutation({ mutationFn: (b: { dealId: string; id: string }) => api.post(`/invites/${b.id}/revoke`), onSuccess: (_r, b) => refresh(b.dealId) });
  const invite = useMutation({
    mutationFn: (id: string) => api.post<{ id: string; url: string }>(`/deals/${id}/invites`),
    onSuccess: (r, id) => { setMade(window.location.origin + r.url); return refresh(id); },
  });
  // Card R5: a link is shown only once, so the server withdraws the old invitation and makes a new one for the same deal.
  const replace = useMutation({
    mutationFn: (b: { dealId: string; id: string }) => api.post<{ id: string; url: string }>(`/invites/${b.id}/replace`),
    onSuccess: (r, b) => { setDealId(b.dealId); setMade(window.location.origin + r.url); setFocusMade(true); return refresh(b.dealId); },
  });
  const now = new Date();
  // Used, revoked and expired invitations stay out: only a link that can still be used is listed.
  const openInvites = list.map((_d, i) => (invites[i]?.data ?? []).filter((v) => !v.used_at && !v.revoked_at && new Date(v.expires_at) > now));
  const rows = list.flatMap((d, i) => [
    ...(clients[i]?.data ?? []).map((c) => (
      <tr key={`c-${d.deal.id}-${c.id}`}>
        <td>{d.deal.name}</td>
        <td>{c.name}<span className="sub">{c.email}</span></td>
        {/* The server counts only confirmations that still stand. */}
        <td>{c.confirmed > 0 ? t("settings.cl.confirmed", { n: c.confirmed, date: c.last_confirmed_at ? shortDay(c.last_confirmed_at, lang) : "" })
          : t("settings.cl.nothingYet", { date: day(c.assigned_at, lang) })}{" "}
          <button className="btn ghost sm" type="button" aria-label={t("settings.cl.removeOf", { name: c.name, deal: d.deal.name })} onClick={() => window.confirm(t("clients.removeConfirm")) && remove.mutate({ dealId: d.deal.id, id: c.id })}>{t("clients.remove")}</button></td>
      </tr>
    )),
    ...openInvites[i]!.map((v) => (
      <tr key={`i-${v.id}`}>
        <td>{d.deal.name}</td>
        <td className="muted">{t("clients.link")}</td>
        <td>{t("settings.cl.invited", { date: day(v.created_at, lang), expires: day(v.expires_at, lang) })}{" "}
          <button className="btn ghost sm" type="button" aria-label={t("settings.cl.newLinkOf", { deal: d.deal.name })} onClick={() => { if (!window.confirm(t("settings.cl.newLinkConfirm"))) return; setMade(null); return replace.mutate({ dealId: d.deal.id, id: v.id }); }}>{t("settings.cl.newLink")}</button>{" "}
          <button className="btn ghost sm" type="button" aria-label={t("settings.cl.withdrawOf", { deal: d.deal.name })} onClick={() => window.confirm(t("settings.cl.withdrawConfirm")) && withdraw.mutate({ dealId: d.deal.id, id: v.id })}>{t("settings.cl.withdraw")}</button></td>
      </tr>
    )),
  ]);
  const waiting = [...clients, ...invites].some((q) => !q.data && !q.error);
  const failed = [...clients, ...invites].find((q) => q.error)?.error ?? null;
  if (!deals.data) return deals.error ? <ErrorText error={deals.error} /> : <p className="muted">{t("common.loading")}</p>;
  if (list.length === 0) return <p className="muted">{t("clients.noDeals")}</p>;
  return (
    <>
      {rows.length > 0 ? (
        <div className="scroll">
          <table className="table">
            <thead><tr><th scope="col">{t("clients.deal")}</th><th scope="col">{t("settings.cl.client")}</th><th scope="col">{t("settings.cl.status")}</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      ) : <p className="small muted">{waiting ? t("common.loading") : t("settings.cl.none")}</p>}
      {openInvites.some((v) => v.length > 0) && <p className="small muted">{t("settings.cl.onceNote")}</p>}
      <ErrorText error={failed ?? remove.error ?? withdraw.error ?? replace.error} />
      <form
        className="stack tight set-sub"
        aria-labelledby="c-invite-h"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const email = (e.currentTarget.elements.namedItem("email") as HTMLInputElement).value;
          e.currentTarget.reset();
          return chosen && add.mutate({ dealId: chosen, email });
        }}
      >
        <div><h3 className="h3" id="c-invite-h">{t("settings.cl.inviteTitle")}</h3><p className="hint">{t("settings.cl.inviteBody")}</p></div>
        <div className="field" style={{ maxWidth: 360 }}><label htmlFor="c-deal">{t("clients.deal")}</label>
          <select className="select" id="c-deal" value={chosen} onChange={(e) => { setDealId(e.target.value); setMade(null); }}>{list.map((d) => <option key={d.deal.id} value={d.deal.id}>{d.deal.name}</option>)}</select>
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 260px" }}><label htmlFor="c-email">{t("clients.add")}</label><input className="input" id="c-email" name="email" type="email" required /></div>
          <button className="btn primary" type="submit">{t("settings.addBtn")}</button>
        </div>
        <ErrorText error={add.error} />
        <div><button className="btn quiet" type="button" disabled={invite.isPending} onClick={() => { setMade(null); setFocusMade(false); return chosen && invite.mutate(chosen); }}>{t("clients.invite")}</button></div>
        {made && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <input key={made} className="input" aria-label={t("clients.link")} readOnly value={made} autoFocus={focusMade} style={{ flex: 1 }} />
              <button className="btn quiet sm" type="button" onClick={() => navigator.clipboard.writeText(made)}>{t("share.copy")}</button>
            </div>
            <span className="small muted">{t("share.once")}</span>
          </div>
        )}
        <ErrorText error={invite.error} />
      </form>
    </>
  );
}

const ROLE_ORDER = ["viewer", "reviewer", "analyst", "admin", "owner", "client"] as const;
/** The roles the members route can set; owner, reviewer and client rows are never changed here. */
const CHANGEABLE = ["admin", "analyst", "viewer"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Section({ id, title, body, children }: { id: string; title: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card card-pad section" id={id} aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="h2" id={`${id}-h`}>{title}</h2>
        {body && <p className="muted set-body">{body}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ title, body, children }: { title: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div><div className="t">{title}</div>{body && <div className="d">{body}</div>}</div>
      {children}
    </div>
  );
}

/** The address is not confirmed yet (card W12): send a new link, or enter the code on /verify. */
function ConfirmEmail() {
  const { t } = useI18n();
  const send = useMutation({ mutationFn: () => api.post("/auth/verify/send", {}) });
  return (
    <div className="stack tight">
      <Notice tone="review">{t("auth.verify.notYet")}</Notice>
      <div className="row">
        <button className="btn quiet sm" type="button" disabled={send.isPending} onClick={() => send.mutate()}>{t("auth.verify.newLink")}</button>
        <Link to="/verify">{t("auth.verify.enterCode")}</Link>
      </div>
      {send.isSuccess && <p className="small muted" role="status">{t("auth.verify.againSent")}</p>}
      <ErrorText error={send.error} />
    </div>
  );
}

/** Card R6: a reset link to the person's own address, so a signed-in person can set a new password. */
function PasswordRow({ email }: { email: string }) {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setSent(false);
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/reset/send", { email });
      setSent(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Row title={t("settings.ac.password")} body={t("settings.ac.passwordBody")}>
        <button className="btn quiet sm" type="button" disabled={busy} onClick={send}>{t("auth.reset.send")}</button>
      </Row>
      {sent && <p className="small" role="status">{t("settings.ac.passwordSent", { email })}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function Settings() {
  const { t, f, L, lang, setLang } = useI18n();
  const { me, workspaceId, role, setWorkspace } = useSession();
  const { pref, setPref } = useTheme();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", workspaceId], queryFn: () => api.get<{ id: string; name: string; email: string; role: string; expires_at: string | null }[]>(`/workspaces/${workspaceId}/members`) });
  const add = useMutation({ mutationFn: (b: { email: string; role: string }) => api.post(`/workspaces/${workspaceId}/members`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const mode = useMutation({ mutationFn: (m: "team" | "solo") => api.post(`/workspaces/${workspaceId}/review-mode`, { mode: m }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const aiReading = useMutation({ mutationFn: (on: boolean) => api.put(`/workspaces/${workspaceId}/ai-reading`, { on }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const suggest = useMutation({ mutationFn: (on: boolean) => api.post(`/workspaces/${workspaceId}/label-suggestions`, { on }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const setRole = useMutation({ mutationFn: (b: { email: string; role: string }) => api.post(`/workspaces/${workspaceId}/members`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  // The new workspace becomes the current one once the session knows it.
  const create = useMutation({
    mutationFn: (b: { name: string; reviewMode: string }) => api.post<{ id: string }>(`/workspaces`, b),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ["me"] }); setWorkspace(r.id); },
  });
  // Card Z1: the workspace name, removing someone, your own name and the browsers you are signed in on.
  // Which name was just saved, so its form can say so until it is edited again.
  const [saved, setSaved] = useState<"ws" | "me" | null>(null);
  const rename = useMutation({ mutationFn: (name: string) => api.post(`/workspaces/${workspaceId}/name`, { name }), onSuccess: () => { setSaved("ws"); return qc.invalidateQueries({ queryKey: ["me"] }); } });
  const removeMember = useMutation({ mutationFn: (id: string) => api.del(`/workspaces/${workspaceId}/members/${id}`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const myName = useMutation({ mutationFn: (name: string) => api.post(`/me/name`, { name }), onSuccess: () => { setSaved("me"); return qc.invalidateQueries({ queryKey: ["me"] }); } });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<{ count: number; devices: SignedIn[] }>(`/me/sessions`) });
  const [ended, setEnded] = useState<number | null>(null);
  const [changingEmail, setChangingEmail] = useState(false);
  const endOthers = useMutation({
    mutationFn: () => api.post<{ ended: number }>(`/me/sessions/end-others`),
    onSuccess: (r: { ended: number }) => { setEnded(r.ended); return qc.invalidateQueries({ queryKey: ["sessions"] }); },
  });
  const count = typeof sessions.data?.count === "number" ? sessions.data.count : null;
  const nameField = (which: "ws" | "me", id: string, label: string, value: string | undefined, save: (name: string) => unknown, pending: boolean) => (
    <form
      className="row"
      style={{ alignItems: "flex-end" }}
      aria-label={label}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        return save((e.currentTarget.elements.namedItem("name") as HTMLInputElement).value);
      }}
    >
      <div className="field" style={{ flex: "1 1 260px", maxWidth: 360 }}><label htmlFor={id}>{label}</label>
        <input className="input" id={id} name="name" required maxLength={120} key={value} defaultValue={value} onChange={() => saved === which && setSaved(null)} /></div>
      <button className="btn quiet" type="submit" disabled={pending}>{t("common.save")}</button>
      {/* 42 px: the height of the field and the button, so the note sits on their middle in this bottom-aligned row. */}
      {saved === which && <span className="small muted" role="status" style={{ lineHeight: "42px" }}>{t("settings.saved")}</span>}
    </form>
  );
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  const others = me.workspaces.filter((w) => w.id !== workspaceId);
  const owner = role === "owner";
  const staffAdmin = role === "owner" || role === "admin";
  // A client sees only its own deals, not the workspace: not its people, nor two settings only the owner reads and changes.
  const member = role !== "client";

  const sections: { id: string; nav: string; show: boolean; node: ReactNode }[] = [
    { id: "workspace", nav: t("settings.nav.workspace"), show: true, node: (
      <Section id="workspace" title={t("settings.nav.workspace")} body={t("settings.ws.body")}>
        {owner && nameField("ws", "ws-name", t("settings.ws.name"), ws?.name, (name) => rename.mutate(name), rename.isPending)}
        <ErrorText error={rename.error} />
        <div>
          {!owner && <Row title={t("settings.ws.name")} body={ws?.name} />}
          <Row title={t("settings.ws.role")} body={t(`settings.you.${role}`)} />
          <Row title={t("settings.ws.others")} body={others.length === 0 ? t("settings.ws.noOthers") : undefined} />
          {others.length > 0 && (
            <ul className="set-list">
              {others.map((w) => (
                <li key={w.id}><span>{t("settings.ws.other", { name: w.name, role: L.role(w.role) })}</span>
                  <button className="btn quiet sm" type="button" onClick={() => setWorkspace(w.id)}>{t("settings.ws.switch")}</button></li>
              ))}
            </ul>
          )}
        </div>
        <form
          className="stack tight set-sub"
          aria-labelledby="ws-new-h"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            e.currentTarget.reset();
            return create.mutate({ name: String(fd.get("name")), reviewMode: String(fd.get("reviewMode")) });
          }}
        >
          <div><h3 className="h3" id="ws-new-h">{t("settings.newWs")}</h3><p className="hint">{t("settings.ws.newBody")}</p></div>
          <div className="field" style={{ maxWidth: 360 }}><label htmlFor="w-name">{t("settings.col.name")}</label><input className="input" id="w-name" name="name" required /></div>
          <fieldset className="stack tight">
            <legend className="label">{t("auth.reviewMode")}</legend>
            {(["solo", "team"] as const).map((m) => <label key={m} className="check"><input type="radio" name="reviewMode" value={m} defaultChecked={m === "solo"} /><span>{t(`auth.mode.${m}`)}</span></label>)}
          </fieldset>
          <div><button className="btn quiet" type="submit">{t("settings.ws.createBtn")}</button></div>
          <ErrorText error={create.error} />
        </form>
      </Section>
    ) },
    { id: "appearance", nav: t("settings.nav.appearance"), show: true, node: (
      <Section id="appearance" title={t("settings.nav.appearance")} body={t("settings.look.body")}>
        <div>
          <Row title={t("settings.theme")} body={t("settings.themeBody")}>
            <Seg<ThemePref> label={t("settings.theme")} value={pref} onChange={setPref}
              options={[{ value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }, { value: "system", label: t("settings.theme.system") }]} />
          </Row>
          <Row title={t("settings.language")} body={t("settings.languageBody")}>
            <Seg<"en" | "fr"> label={t("settings.language")} value={lang} onChange={setLang}
              options={[{ value: "en", label: t("settings.lang.en") }, { value: "fr", label: t("settings.lang.fr") }]} />
          </Row>
          <Row title={t("terms.title")} body={t("terms.body")}>
            <TermsSeg />
          </Row>
        </div>
      </Section>
    ) },
    { id: "review", nav: t("settings.nav.review"), show: member, node: (
      <Section id="review" title={t("settings.nav.review")} body={t("settings.rv.body")}>
        <div className="choices" role="radiogroup" aria-labelledby="review-h">
          {(["team", "solo"] as const).map((m) => (
            <label key={m} className={ws?.review_mode === m ? "choice on" : "choice"}>
              <input type="radio" name="review-mode" checked={ws?.review_mode === m} disabled={!owner} onChange={() => mode.mutate(m)} />
              <span><span className="t">{t(`settings.rv.${m}`)}</span><span className="d">{t(`settings.mode.${m}Body`)}</span></span>
            </label>
          ))}
        </div>
        {!owner && <p className="hint">{t("settings.rv.locked")}</p>}
        <ErrorText error={mode.error} />
        {owner && (
          <Notice tone="accent" title={t("settings.eyes.title")}>
            {t("settings.eyes.body")} <Link to="/settings/review-access">{t("settings.eyes.link")}</Link>
          </Notice>
        )}
      </Section>
    ) },
    { id: "thresholds", nav: t("settings.nav.thresholds"), show: true, node: (
      <Section id="thresholds" title={t("settings.nav.thresholds")} body={t("settings.th.body")}>
        <Thresholds scope="workspaces" id={workspaceId} summary={t("thresholds.show")} />
      </Section>
    ) },
    { id: "people", nav: t("settings.nav.people"), show: member, node: (
      <Section id="people" title={t("settings.nav.people")} body={t("settings.pp.body")}>
        <div className="scroll">
          <table className="table">
            <thead><tr><th>{t("settings.col.name")}</th><th>{t("settings.col.email")}</th><th>{t("settings.col.role")}</th></tr></thead>
            <tbody>{(members.data ?? []).map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.user.id && <span className="sub">{t("settings.pp.you")}</span>}</td>
                <td>{m.email}</td>
                <td>{staffAdmin && m.id !== me.user.id && CHANGEABLE.includes(m.role) ? (
                  <div className="row" style={{ gap: 8 }}>
                    <select className="select" aria-label={t("settings.pp.roleOf", { name: m.name })} value={m.role}
                      onChange={(e) => e.target.value !== m.role && window.confirm(t("settings.pp.roleConfirm", { name: m.name, role: L.role(e.target.value) })) && setRole.mutate({ email: m.email, role: e.target.value })}>
                      {CHANGEABLE.map((r) => <option key={r} value={r}>{cap(L.role(r))}</option>)}
                    </select>
                    <button className="btn ghost sm" type="button" aria-label={t("settings.pp.removeOf", { name: m.name })}
                      onClick={() => window.confirm(t("settings.pp.removeConfirm", { name: m.name })) && removeMember.mutate(m.id)}>{t("clients.remove")}</button>
                  </div>
                ) : cap(L.role(m.role))}{m.expires_at && <span className="sub">{new Date(m.expires_at) > new Date() ? t("settings.expires", { date: f.date(m.expires_at) }) : t("settings.expired")}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <ErrorText error={setRole.error ?? removeMember.error} />
        {staffAdmin && <p className="hint">{t("settings.pp.rolesHint")}</p>}
        {staffAdmin && (
          <form
            className="stack tight"
            aria-label={t("settings.pp.addForm")}
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              add.mutate({ email: String(fd.get("email")), role: String(fd.get("role")) });
              e.currentTarget.reset();
            }}
          >
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field" style={{ flex: "1 1 260px" }}><label htmlFor="m-email">{t("settings.pp.add")}</label><input className="input" id="m-email" name="email" type="email" required /></div>
              <div className="field"><label htmlFor="m-role">{t("settings.pp.as")}</label>
                <select className="select" id="m-role" name="role">{["analyst", "admin", "viewer"].map((r) => <option key={r} value={r}>{cap(L.role(r))}</option>)}</select>
              </div>
              <button className="btn primary" type="submit">{t("settings.addBtn")}</button>
            </div>
            <p className="hint">{t("settings.pp.hint")}</p>
            <ErrorText error={add.error} />
          </form>
        )}
      </Section>
    ) },
    { id: "roles", nav: t("settings.roles"), show: true, node: (
      <Section id="roles" title={t("settings.roles")} body={t("settings.rl.body")}>
        <div className="scroll">
          <table className="table">
            <thead><tr><th scope="col">{t("settings.rl.role")}</th><th scope="col">{t("settings.rl.can")}</th><th scope="col">{t("settings.rl.cannot")}</th></tr></thead>
            <tbody>{ROLE_ORDER.map((r) => <tr key={r}><th scope="row">{cap(L.role(r))}</th><td>{t(`settings.can.${r}`)}</td><td>{t(`settings.cannot.${r}`)}</td></tr>)}</tbody>
          </table>
        </div>
      </Section>
    ) },
    { id: "clients", nav: t("settings.nav.clients"), show: staffAdmin, node: (
      <Section id="clients" title={t("clients.title")} body={t("clients.body")}><Clients /></Section>
    ) },
    { id: "reading", nav: t("settings.nav.reading"), show: member, node: (
      <Section id="reading" title={t("settings.nav.reading")} body={t("settings.rd.body")}>
        <div>
          <Row title={t("settings.aiOn")} body={t("settings.aiNotice")}>
            <Switch label={t("settings.aiOn")} checked={ws?.ai_reading ?? false} disabled={!owner} onChange={(on) => aiReading.mutate(on)} />
          </Row>
          <Row title={t("settings.suggestOn")} body={t("settings.suggestNotice")}>
            <Switch label={t("settings.suggestOn")} checked={ws?.label_suggestions ?? false} disabled={!owner} onChange={(on) => suggest.mutate(on)} />
          </Row>
        </div>
        {!owner && <p className="hint">{t("settings.rd.locked")}</p>}
        <ErrorText error={aiReading.error ?? suggest.error} />
      </Section>
    ) },
    { id: "logo", nav: t("logo.title"), show: owner, node: <LogoPanel workspaceId={workspaceId} hasLogo={ws?.has_logo ?? false} /> },
    { id: "counts", nav: t("settings.nav.counts"), show: owner, node: <CountsPanel workspaceId={workspaceId} /> },
    { id: "account", nav: t("settings.nav.account"), show: true, node: (
      <Section id="account" title={t("settings.nav.account")} body={t("settings.ac.body")}>
        {nameField("me", "ac-name", t("settings.ac.name"), me.user.name, (name) => myName.mutate(name), myName.isPending)}
        <ErrorText error={myName.error} />
        <div>
          <Row title={t("settings.ac.email")} body={<>{me.user.email}{me.user.email_verified && <> <Tag tone="pass">{t("auth.verify.confirmed")}</Tag></>}</>}>
            <button className="btn quiet sm" type="button" aria-expanded={changingEmail} onClick={() => setChangingEmail(!changingEmail)}>{t("settings.ac.change")}</button>
          </Row>
        </div>
        {changingEmail && <ChangeEmail current={me.user.email} verified={me.user.email_verified} onCancel={() => setChangingEmail(false)} />}
        {me.user.email_verified === false && <ConfirmEmail />}
        <PasswordRow email={me.user.email} />
        {/* Each live session by the kind of device it signed in from, this one first (card R4). */}
        <div>
          <Row title={t("settings.ac.devices")}
            body={!sessions.data?.devices ? (sessions.error ? undefined : t("common.loading")) : (
              <ul className="set-list">
                {sessions.data.devices.map((d, i) => (
                  <li key={i}>{d.current ? t(`settings.ac.this.${deviceSlug(d.device)}`)
                    : t("settings.ac.signedIn", { device: t(`settings.ac.a.${deviceSlug(d.device)}`), date: shortDay(d.signedInAt, lang) })}</li>
                ))}
              </ul>
            )}>
            {count !== null && count > 1 && (
              <button className="btn quiet sm" type="button" disabled={endOthers.isPending}
                onClick={() => { setEnded(null); return window.confirm(t("settings.ac.signOutConfirm")) && endOthers.mutate(undefined); }}>{t("settings.ac.signOutOthers")}</button>
            )}
          </Row>
        </div>
        {ended !== null && <p className="small" role="status">{t("settings.ac.ended", { n: ended })}</p>}
        <ErrorText error={sessions.error ?? endOthers.error} />
      </Section>
    ) },
  ];
  const shown = sections.filter((s) => s.show);
  return (
    <>
      <div className="page-head"><div><h1 className="h1">{t("settings.title")}</h1><p className="lead set-lead">{t("settings.lead")}</p></div></div>
      <div className="set">
        <nav className="set-nav" aria-label={t("settings.nav")}>
          {shown.map((s) => <a key={s.id} href={`#${s.id}`}>{s.nav}</a>)}
        </nav>
        <div className="stack">{shown.map((s) => <Fragment key={s.id}>{s.node}</Fragment>)}</div>
      </div>
    </>
  );
}
