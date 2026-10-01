import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent } from "react";
import { api } from "../api";
import { ErrorText, useSession } from "../components/ui";
import { useI18n } from "../i18n";

export function Settings() {
  const { t, L, lang, setLang } = useI18n();
  const { me, workspaceId, role } = useSession();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", workspaceId], queryFn: () => api.get<{ id: string; name: string; email: string; role: string }[]>(`/workspaces/${workspaceId}/members`) });
  const add = useMutation({ mutationFn: (b: { email: string; role: string }) => api.post(`/workspaces/${workspaceId}/members`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }) });
  const create = useMutation({ mutationFn: (name: string) => api.post(`/workspaces`, { name }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
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
            <tbody>{(members.data ?? []).map((m) => <tr key={m.id}><td>{m.name}</td><td className="muted">{m.email}</td><td>{L.role(m.role)}</td></tr>)}</tbody>
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
        </div>
        <div className="stack" style={{ gap: 16 }}>
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
              {(["viewer", "analyst", "admin", "owner"] as const).map((r) => <tr key={r}><th scope="row">{L.role(r)}</th><td className="muted">{t(`settings.r.${r}`)}</td></tr>)}
            </tbody>
          </table>
          <form
            className="panel stack"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              create.mutate(String(new FormData(e.currentTarget).get("name")));
              e.currentTarget.reset();
            }}
          >
            <strong>{t("settings.newWs")}</strong>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field grow"><label htmlFor="w-name">{t("settings.col.name")}</label><input className="input" id="w-name" name="name" required /></div>
              <button className="btn" type="submit">{t("settings.create")}</button>
            </div>
            <ErrorText error={create.error} />
          </form>
        </div>
      </div>
    </>
  );
}
