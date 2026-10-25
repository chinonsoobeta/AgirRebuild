import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, type DealOverview, type InvitePeek, type Me } from "../api";
import { useI18n } from "../i18n";
import { FormError, SignedOutPage } from "./auth";

/** The page an invitation link opens (card 89): outside the session gate. Signed out, it signs the person up as a client
 * of one deal; signed in, it joins them. A used, revoked or expired link shows the API's one sentence. */
export function Invite({ secret }: { secret: string }) {
  const { t, err } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ["invite", secret], queryFn: () => api.get<InvitePeek>(`/invite/${secret}`), retry: false });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), retry: false });
  // Refetching a signed-out session puts it back to loading; once answered, the page stays, with what was typed.
  const answered = useRef(false);
  if (me.data || me.error) answered.current = true;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (invite.error) return <SignedOutPage><p className="lead">{err(invite.error)}</p></SignedOutPage>;
  if (!invite.data || (!me.data && !me.error && !answered.current)) return <SignedOutPage><p className="muted">{t("common.loading")}</p></SignedOutPage>;
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
  const ws = invite.data.workspace;
  return (
    <SignedOutPage>
      <div className="card auth-invite">
        <div>
          <p className="muted auth-from">{t("auth.invite.from", { ws })}</p>
          <h1 className="h1">{t("auth.invite.title", { deal: invite.data.deal })}</h1>
          <p className="lead auth-invite-body">{t("invite.body")}</p>
        </div>
        {me.data ? (
          <div className="stack tight">
            <div><button className="btn primary" type="button" disabled={busy} onClick={join}>{t("invite.join")}</button></div>
            <FormError error={error} />
          </div>
        ) : (
          <form onSubmit={signup} noValidate>
            <div className="grid2">
              <div className="field"><label htmlFor="name">{t("auth.name")}</label><input className="input" id="name" name="name" autoComplete="name" required /></div>
              <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
            </div>
            <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required aria-describedby="password-hint" /><p className="hint" id="password-hint">{t("auth.passwordHelp")}</p></div>
            <FormError error={error} />
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>{t("invite.create")}</button>
              <span className="small muted">{t("auth.invite.already")} <Link to="/login">{t("auth.invite.signIn")}</Link>{t("auth.invite.thenOpen")}</span>
            </div>
          </form>
        )}
        <p className="small muted">{t("auth.invite.once", { ws })}</p>
      </div>
    </SignedOutPage>
  );
}
