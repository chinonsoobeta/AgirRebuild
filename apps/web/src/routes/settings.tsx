import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { api, type ClientInvite, type DealClient, type DealOverview } from "../api";
import { ErrorText, useSession } from "../components/ui";
import { Thresholds } from "../components/thresholds";
import { useI18n } from "../i18n";
import { useTheme, type ThemePref } from "../theme";
import { Notice, Seg, Switch } from "../components/kit";

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
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["deal-metrics", workspaceId], queryFn: () => api.get<{ deals: DealCounts[]; totals: DealCounts & { deals: number } }>(`/workspaces/${workspaceId}/deal-metrics`) });
  const cells = (r: DealCounts) => [
    [r.docs_pdf, r.docs_xlsx, r.docs_csv, r.docs_docx, r.docs_txt].join(" / "), r.docs_no_candidates, r.figures_read,
    r.figures_confirmed_from_suggestion, r.figures_typed, r.actions_until_runnable,
  ];
  const deals = q.data?.deals ?? [];
  return (
    <section className="card card-pad section" id="counts">
      <h2 className="h2">{t("counts.title")}</h2>
      <p className="muted">{t("counts.body")}</p>
      {q.data && deals.length === 0 ? <p className="small muted">{t("counts.none")}</p> : deals.length > 0 && (
        <div className="scroll">
          <table className="table">
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
      <ErrorText error={q.error} />
    </section>
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
    <>
      {!deals.data ? <p className="muted">{t("common.loading")}</p> : list.length === 0 ? <p className="muted">{t("clients.noDeals")}</p> : (
        <>
          <div className="field" style={{ maxWidth: 360 }}><label htmlFor="c-deal">{t("clients.deal")}</label>
            <select className="select" id="c-deal" value={chosen} onChange={(e) => setDealId(e.target.value)}>{list.map((d) => <option key={d.deal.id} value={d.deal.id}>{d.deal.name}</option>)}</select>
          </div>
          {chosen && <ClientsPanel key={chosen} dealId={chosen} />}
        </>
      )}
    </>
  );
}

const ROLE_ORDER = ["viewer", "reviewer", "analyst", "admin", "owner", "client"] as const;
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

export function Settings() {
  const { t, f, L, lang, setLang } = useI18n();
  const { me, workspaceId, role, setWorkspace } = useSession();
  const { pref, setPref } = useTheme();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", workspaceId], queryFn: () => api.get<{ id: string; name: string; email: string; role: string; expires_at: string | null }[]>(`/workspaces/${workspaceId}/members`) });
  const add = useMutation({ mutationFn: (b: { email: string; role: string }) => api.post(`/workspaces/${workspaceId}/members`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const mode = useMutation({ mutationFn: (m: "team" | "solo") => api.post(`/workspaces/${workspaceId}/review-mode`, { mode: m }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const suggest = useMutation({ mutationFn: (on: boolean) => api.post(`/workspaces/${workspaceId}/label-suggestions`, { on }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const create = useMutation({ mutationFn: (b: { name: string; reviewMode: string }) => api.post(`/workspaces`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  const others = me.workspaces.filter((w) => w.id !== workspaceId);
  const owner = role === "owner";
  const staffAdmin = role === "owner" || role === "admin";

  const sections: { id: string; nav: string; show: boolean; node: ReactNode }[] = [
    { id: "workspace", nav: t("settings.nav.workspace"), show: true, node: (
      <Section id="workspace" title={t("settings.nav.workspace")} body={t("settings.ws.body")}>
        <div>
          <Row title={t("settings.ws.name")} body={ws?.name} />
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
            create.mutate({ name: String(fd.get("name")), reviewMode: String(fd.get("reviewMode")) });
            e.currentTarget.reset();
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
        </div>
      </Section>
    ) },
    { id: "review", nav: t("settings.nav.review"), show: true, node: (
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
    { id: "people", nav: t("settings.nav.people"), show: true, node: (
      <Section id="people" title={t("settings.nav.people")} body={t("settings.pp.body")}>
        <div className="scroll">
          <table className="table">
            <thead><tr><th>{t("settings.col.name")}</th><th>{t("settings.col.email")}</th><th>{t("settings.col.role")}</th></tr></thead>
            <tbody>{(members.data ?? []).map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.user.id && <span className="sub">{t("settings.pp.you")}</span>}</td>
                <td>{m.email}</td>
                <td>{cap(L.role(m.role))}{m.expires_at && <span className="sub">{new Date(m.expires_at) > new Date() ? t("settings.expires", { date: f.date(m.expires_at) }) : t("settings.expired")}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
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
    { id: "reading", nav: t("settings.nav.reading"), show: true, node: (
      <Section id="reading" title={t("settings.nav.reading")} body={t("settings.rd.body")}>
        <div>
          <Row title={t("settings.suggestOn")} body={t("settings.suggestNotice")}>
            <Switch label={t("settings.suggestOn")} checked={ws?.label_suggestions ?? false} disabled={!owner} onChange={(on) => suggest.mutate(on)} />
          </Row>
        </div>
        {!owner && <p className="hint">{t("settings.rd.locked")}</p>}
        <ErrorText error={suggest.error} />
      </Section>
    ) },
    { id: "logo", nav: t("logo.title"), show: owner, node: <LogoPanel workspaceId={workspaceId} hasLogo={ws?.has_logo ?? false} /> },
    { id: "counts", nav: t("settings.nav.counts"), show: owner, node: <CountsPanel workspaceId={workspaceId} /> },
    { id: "account", nav: t("settings.nav.account"), show: true, node: (
      <Section id="account" title={t("settings.nav.account")} body={t("settings.ac.body")}>
        <dl className="grid2 set-dl">
          <div><dt className="label">{t("settings.ac.name")}</dt><dd>{me.user.name}</dd></div>
          <div><dt className="label">{t("settings.ac.email")}</dt><dd>{me.user.email}</dd></div>
        </dl>
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
