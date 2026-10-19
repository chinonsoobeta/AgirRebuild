import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type DealOverview, type InvitePeek, type Me } from "../api";
import { ErrorText } from "../components/ui";
import { useI18n } from "../i18n";
import { AuthFrame } from "./auth";

/** The page an invitation link opens (card 89): outside the session gate. Signed out, it signs the person up as a client
 * of one deal; signed in, it joins them. A used, revoked or expired link shows the API's one sentence. */
export function Invite({ secret }: { secret: string }) {
  const { t, err } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ["invite", secret], queryFn: () => api.get<InvitePeek>(`/invite/${secret}`), retry: false });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), retry: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (invite.error) return <main className="stack" style={{ gap: 12, padding: 24 }}><p>{err(invite.error)}</p></main>;
  if (!invite.data || (!me.data && !me.error)) return <main style={{ padding: 24 }}><p className="muted">{t("common.loading")}</p></main>;
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const join = () => run(async () => {
    const { dealId } = await api.post<{ dealId: string }>(`/invite/${secret}/accept`);
    // Open the workspace the deal is in, which may not be this person's first.
    const o = await api.get<DealOverview>(`/deals/${dealId}`);
    try {
      localStorage.setItem("agir.workspace", o.deal.workspace_id);
    } catch {
      /* private window: the session picks the first workspace */
    }
    await qc.invalidateQueries();
    void navigate({ to: "/deals/$dealId/review", params: { dealId } });
  });
  const signup = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fields = e.currentTarget.elements;
    const v = (k: string) => (fields.namedItem(k) as HTMLInputElement).value;
    return run(async () => {
      await api.post("/auth/signup", { name: v("name"), email: v("email"), password: v("password"), invite: secret });
      await qc.invalidateQueries();
      void navigate({ to: "/deals" });
    });
  };
  return (
    <AuthFrame>
      <div className="stack" style={{ gap: 16, maxWidth: 420 }}>
        <h2 className="h-title" style={{ fontSize: 30 }}>{t("invite.title", { ws: invite.data.workspace, deal: invite.data.deal })}</h2>
        <p className="muted">{t("invite.body")}</p>
        {me.data ? (
          <div className="stack" style={{ gap: 8 }}>
            <div><button className="btn primary" type="button" disabled={busy} onClick={join}>{t("invite.join")}</button></div>
            <ErrorText error={error} />
          </div>
        ) : (
          <form onSubmit={signup} noValidate>
            <div className="field"><label htmlFor="name">{t("auth.name")}</label><input className="input" id="name" name="name" autoComplete="name" required /></div>
            <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
            <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /><span className="help">{t("auth.passwordHelp")}</span></div>
            <ErrorText error={error} />
            <div className="stack" style={{ gap: 8 }}>
              <div><button className="btn primary" type="submit" disabled={busy}>{t("invite.create")}</button></div>
              <span className="small muted">{t("invite.haveAccount")}</span>
            </div>
          </form>
        )}
      </div>
    </AuthFrame>
  );
}
