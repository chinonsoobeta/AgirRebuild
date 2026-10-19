import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type ClientInvite, type DealClient, type DealOverview } from "../api";
import { ErrorText, useSession } from "../components/ui";
import { useI18n } from "../i18n";

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
        <table className="tbl">
          <tbody>
            {(clients.data ?? []).map((c) => (
              <tr key={c.id}><td>{c.name}</td><td className="muted">{c.email}</td>
                <td className="r"><button className="btn quiet small" type="button" onClick={() => { if (window.confirm(t("clients.removeConfirm"))) remove.mutate(c.id); }}>{t("clients.remove")}</button></td>
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
          <div className="field grow"><label htmlFor="c-email">{t("clients.add")}</label><input className="input" id="c-email" name="email" type="email" required /></div>
          <button className="btn" type="submit">{t("settings.addBtn")}</button>
        </div>
      </form>
      <ErrorText error={add.error ?? remove.error} />
      <p className="small muted">{t("clients.inviteBody")}</p>
      <div><button className="btn" type="button" disabled={invite.isPending} onClick={() => { setMade(null); invite.mutate(); }}>{t("clients.invite")}</button></div>
      {made && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <input className="input" aria-label={t("clients.link")} readOnly value={made} style={{ flex: 1 }} />
            <button className="btn small" type="button" onClick={() => navigator.clipboard.writeText(made)}>{t("share.copy")}</button>
          </div>
          <span className="small muted">{t("share.once")}</span>
        </div>
      )}
      <ErrorText error={invite.error ?? revoke.error} />
      {(invites.data ?? []).length > 0 && (
        <>
          <strong>{t("clients.invites")}</strong>
          <table className="tbl small">
            <thead><tr><th>{t("share.by")}</th><th>{t("share.on")}</th><th>{t("share.expires")}</th><th>{t("reports.col.status")}</th><th className="r"><span className="sr-only">{t("share.revoke")}</span></th></tr></thead>
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.created_by}</td><td className="muted">{f.date(i.created_at)}</td><td className="muted">{f.date(i.expires_at)}</td>
                  <td>{status(i) ?? t("clients.open")}</td>
                  <td className="r">{!status(i) && <button className="btn quiet small" type="button" onClick={() => { if (window.confirm(t("clients.revokeConfirm"))) revoke.mutate(i.id); }}>{t("share.revoke")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Choose a deal, then manage its clients. */
function Clients() {
  const { t } = useI18n();
  const { workspaceId } = useSession();
  const deals = useQuery({ queryKey: ["deals", workspaceId], queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`) });
  const [dealId, setDealId] = useState<string | null>(null);
  const list = deals.data ?? [];
  const chosen = list.find((d) => d.deal.id === dealId)?.deal.id ?? list[0]?.deal.id;
  return (
    <section className="panel stack">
      <h2 className="h-section">{t("clients.title")}</h2>
      <p className="small muted">{t("clients.body")}</p>
      {list.length === 0 ? <p className="small muted">{t("clients.noDeals")}</p> : (
        <>
          <div className="field"><label htmlFor="c-deal">{t("clients.deal")}</label>
            <select className="select" id="c-deal" value={chosen} onChange={(e) => setDealId(e.target.value)}>{list.map((d) => <option key={d.deal.id} value={d.deal.id}>{d.deal.name}</option>)}</select>
          </div>
          {chosen && <ClientsPanel key={chosen} dealId={chosen} />}
        </>
      )}
    </section>
  );
}

export function Settings() {
  const { t, f, L, lang, setLang } = useI18n();
  const { me, workspaceId, role } = useSession();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", workspaceId], queryFn: () => api.get<{ id: string; name: string; email: string; role: string; expires_at: string | null }[]>(`/workspaces/${workspaceId}/members`) });
  const add = useMutation({ mutationFn: (b: { email: string; role: string }) => api.post(`/workspaces/${workspaceId}/members`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const grant = useMutation({ mutationFn: (b: { email: string; days: number }) => api.post(`/workspaces/${workspaceId}/review-grant`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const mode = useMutation({ mutationFn: (m: "team" | "solo") => api.post(`/workspaces/${workspaceId}/review-mode`, { mode: m }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const suggest = useMutation({ mutationFn: (on: boolean) => api.post(`/workspaces/${workspaceId}/label-suggestions`, { on }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const create = useMutation({ mutationFn: (b: { name: string; reviewMode: string }) => api.post(`/workspaces`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  return (
    <>
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="h-title" style={{ fontSize: 44 }}>{t("settings.title")}</h1>
        <p className="muted">{t("settings.role", { ws: ws?.name, role: L.role(role) })}</p>
      </div>
      <div className="two-col">
        <div className="stack" style={{ gap: 16 }}>
          <h2 className="h-section">{t("settings.people")}</h2>
          <table className="tbl">
            <thead><tr><th>{t("settings.col.name")}</th><th>{t("settings.col.email")}</th><th>{t("settings.col.role")}</th></tr></thead>
            <tbody>{(members.data ?? []).map((m) => <tr key={m.id}><td>{m.name}</td><td className="muted">{m.email}</td><td>{L.role(m.role)}{m.expires_at && <span className="small muted"> · {new Date(m.expires_at) > new Date() ? t("settings.expires", { date: f.date(m.expires_at) }) : t("settings.expired")}</span>}</td></tr>)}</tbody>
          </table>
          {(role === "owner" || role === "admin") && (
            <form
              className="panel stack"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                add.mutate({ email: String(fd.get("email")), role: String(fd.get("role")) });
                e.currentTarget.reset();
              }}
            >
              <strong>{t("settings.add")}</strong>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field grow"><label htmlFor="m-email">{t("settings.col.email")}</label><input className="input" id="m-email" name="email" type="email" required /></div>
                <div className="field"><label htmlFor="m-role">{t("settings.col.role")}</label>
                  <select className="select" id="m-role" name="role">{["analyst", "admin", "viewer"].map((r) => <option key={r} value={r}>{L.role(r)}</option>)}</select>
                </div>
                <button className="btn" type="submit">{t("settings.addBtn")}</button>
              </div>
              <ErrorText error={add.error} />
            </form>
          )}
          {(role === "owner" || role === "admin") && <Clients />}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <fieldset className="panel stack" style={{ margin: 0 }} disabled={role !== "owner"}>
            <legend className="h-section" style={{ padding: "0 4px" }}>{t("settings.reviewMode")}</legend>
            {(["team", "solo"] as const).map((m) => (
              <label key={m} className="choice"><input type="radio" name="review-mode" checked={ws?.review_mode === m} onChange={() => mode.mutate(m)} />
                <span><strong>{t(`settings.mode.${m}`)}</strong><span className="small muted" style={{ display: "block" }}>{t(`settings.mode.${m}Body`)}</span></span>
              </label>
            ))}
            <ErrorText error={mode.error} />
          </fieldset>
          <fieldset className="panel stack" style={{ margin: 0 }} disabled={role !== "owner"}>
            <legend className="h-section" style={{ padding: "0 4px" }}>{t("settings.suggest")}</legend>
            <label className="choice"><input type="checkbox" checked={ws?.label_suggestions ?? false} onChange={(e) => suggest.mutate(e.target.checked)} />
              <span><strong>{t("settings.suggestOn")}</strong><span className="small muted" style={{ display: "block" }}>{t("settings.suggestNotice")}</span></span>
            </label>
            <ErrorText error={suggest.error} />
          </fieldset>
          {role === "owner" && (
            <form
              className="panel stack"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                grant.mutate({ email: String(fd.get("email")), days: Number(fd.get("days")) });
                e.currentTarget.reset();
              }}
            >
              <strong>{t("settings.review")}</strong>
              <p className="small muted">{t("settings.reviewBody")}</p>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field grow"><label htmlFor="r-email">{t("settings.col.email")}</label><input className="input" id="r-email" name="email" type="email" required /></div>
                <div className="field"><label htmlFor="r-days">{t("settings.reviewDays")}</label><input className="input" id="r-days" name="days" type="number" min={1} max={90} step={1} defaultValue={14} required /></div>
                <button className="btn" type="submit">{t("settings.reviewBtn")}</button>
              </div>
              <ErrorText error={grant.error} />
            </form>
          )}
          <fieldset className="panel stack" style={{ margin: 0 }}>
            <legend className="h-section" style={{ padding: "0 4px" }}>{t("settings.language")}</legend>
            <p className="small muted">{t("settings.languageBody")}</p>
            <div className="row">
              <label className="choice" style={{ flex: 1 }}><input type="radio" name="lang" checked={lang === "en"} onChange={() => setLang("en")} /><span lang="en">English</span></label>
              <label className="choice" style={{ flex: 1 }}><input type="radio" name="lang" checked={lang === "fr"} onChange={() => setLang("fr")} /><span lang="fr">Français (Canada)</span></label>
            </div>
          </fieldset>
          <h2 className="h-section">{t("settings.roles")}</h2>
          <table className="tbl small">
            <tbody>
              {(["client", "viewer", "reviewer", "analyst", "admin", "owner"] as const).map((r) => <tr key={r}><th scope="row">{L.role(r)}</th><td className="muted">{t(`settings.r.${r}`)}</td></tr>)}
            </tbody>
          </table>
          <form
            className="panel stack"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              create.mutate({ name: String(fd.get("name")), reviewMode: String(fd.get("reviewMode")) });
              e.currentTarget.reset();
            }}
          >
            <strong>{t("settings.newWs")}</strong>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field grow"><label htmlFor="w-name">{t("settings.col.name")}</label><input className="input" id="w-name" name="name" required /></div>
              <button className="btn" type="submit">{t("settings.create")}</button>
            </div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>{t("auth.reviewMode")}</legend>
              {(["solo", "team"] as const).map((m) => <label key={m} className="choice"><input type="radio" name="reviewMode" value={m} defaultChecked={m === "solo"} /><span>{t(`auth.mode.${m}`)}</span></label>)}
            </fieldset>
            <ErrorText error={create.error} />
          </form>
        </div>
      </div>
    </>
  );
}
