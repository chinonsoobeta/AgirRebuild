import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";
import { Notice } from "../components/kit";
import { useI18n } from "../i18n";
import { AuthFrame, FormError } from "./auth";

/** Takes the `token` from the address once and removes the query from the address bar, keeping the path, so the link's
 * secret does not stay in the history or reach a screenshot. Null when there is no token. */
export function takeToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname);
  return token;
}

/** "Send it again": a fresh link and code; earlier ones stop working. Shows that it was sent, that this server cannot send
 * email (card B: the answer says sent: false), or the API's sentence. */
function useResend() {
  const { t } = useI18n();
  const [sent, setSent] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setSent(null);
    setError(null);
    try {
      const r = await api.post<{ sent?: false }>("/auth/verify/send", {});
      setSent(r.sent !== false);
    } catch (e) {
      setError(e);
    }
  };
  const status = (
    <>
      {sent === true && <Notice tone="pass" role="status">{t("auth.verify.againSent")}</Notice>}
      {sent === false && <Notice tone="review" role="status">{t("auth.noMail")}</Notice>}
      <FormError error={error} />
    </>
  );
  return { send, status };
}

/**
 * Changing the email address (card R6), on Settings and on this page. The server asks for the current password. An
 * unconfirmed address changes at once ({ changed }); a confirmed one changes only when the link sent to the new address is
 * opened ({ pending }). Shows the result sentence in place of the form; `onChanged` runs after `me` is refreshed.
 */
export function ChangeEmail({ current, verified, onCancel, onChanged }: { current: string; verified: boolean; onCancel: () => void; onChanged?: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [done, setDone] = useState<{ pending: boolean; email: string; old: string; sent: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const field = (k: string) => (e.currentTarget.elements.namedItem(k) as HTMLInputElement).value;
    const email = field("email").trim();
    const password = field("password");
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ pending?: true; changed?: true; sent?: false }>("/me/email", { email, password });
      setDone({ pending: Boolean(r.pending), email, old: current, sent: r.sent !== false });
      if (r.changed) {
        await qc.invalidateQueries({ queryKey: ["me"] });
        onChanged?.();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  // With no mail provider (card B), nothing claims a send: a pending change cannot complete, and a done one is only said.
  if (done && !done.sent) return <p className="small" role="status">{!done.pending && <>{t("auth.email.confirmed", { email: done.email })} </>}{t("auth.noMail")}</p>;
  if (done) return <p className="small" role="status">{done.pending ? t("auth.email.pending", { email: done.email, old: done.old }) : t("auth.email.changed", { email: done.email })}</p>;
  return (
    <form id="change-email" className="stack tight" onSubmit={submit} noValidate>
      <div className="field"><label htmlFor="ce-email">{t("auth.email.new")}</label>
        <input className="input" id="ce-email" name="email" type="email" autoComplete="email" required /></div>
      <div className="field"><label htmlFor="ce-password">{t("auth.email.password")}</label>
        <input className="input" id="ce-password" name="password" type="password" autoComplete="current-password" required /></div>
      <FormError error={error} />
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>{t("auth.email.submit")}</button>
        <button className="btn quiet" type="button" onClick={onCancel}>{t("auth.email.cancel")}</button>
      </div>
      {verified && <p className="small muted">{t("auth.email.tell", { old: current })}</p>}
    </form>
  );
}

/** The page a confirmation email links to, and the page after signing up: outside the session gate. */
export function Verify() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token] = useState(takeToken);
  const [result, setResult] = useState<{ ok: true } | { error: unknown } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [badCode, setBadCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const resend = useResend();
  const [changing, setChanging] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), retry: false });
  const posted = useRef(false);
  useEffect(() => {
    // The link works once: post it exactly once, even when the effect runs twice.
    if (!token || posted.current) return;
    posted.current = true;
    api.post("/auth/verify", { token }).then(
      () => { setResult({ ok: true }); void qc.invalidateQueries({ queryKey: ["me"] }); },
      (e: unknown) => setResult({ error: e }),
    );
  }, [token, qc]);

  const signedIn = Boolean(me.data);
  // Refetching a signed-out session puts it back to loading; once answered, the page stays as it was.
  const answered = useRef(false);
  if (me.data || me.error) answered.current = true;
  const loading = !me.data && !me.error && !answered.current;
  const otherError = me.error && !(me.error instanceof ApiError && me.error.status === 401) ? me.error : null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = (e.currentTarget.elements.namedItem("code") as HTMLInputElement).value.replace(/\s/g, "");
    setError(null);
    setBadCode(!/^\d{6}$/.test(code));
    if (!/^\d{6}$/.test(code)) return;
    setBusy(true);
    try {
      await api.post("/auth/verify", { code });
      await qc.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/deals" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmed = (
    <>
      <h1 className="h1">{t("auth.verify.done")}</h1>
      {signedIn ? <p><Link className="btn primary" to="/deals">{t("auth.verify.toDeals")}</Link></p>
        : <p><Link className="btn primary" to="/login">{t("auth.signIn")}</Link></p>}
    </>
  );

  let body;
  if (token) {
    body = !result ? <p className="muted" role="status">{t("auth.verify.checking")}</p>
      : "ok" in result ? confirmed
      : (
        <>
          <h1 className="h1">{t("auth.verify.failed")}</h1>
          <FormError error={result.error} />
          {loading ? null : me.data?.mail === false ? <Notice tone="review">{t("auth.noMail")}</Notice> : signedIn ? (
            <div className="stack tight">
              <div><button className="btn primary" type="button" onClick={resend.send}>{t("auth.verify.newLink")}</button></div>
              {resend.status}
            </div>
          ) : <p><Link to="/login">{t("auth.signIn")}</Link></p>}
        </>
      );
  } else if (loading) {
    body = <p className="muted">{t("common.loading")}</p>;
  } else if (me.data?.user.email_verified) {
    body = confirmed;
  } else if (me.data?.mail === false) {
    // Card B: this server cannot send email, so there is no link or code to wait for.
    body = (
      <>
        <h1 className="h1">{t("auth.verify.title")}</h1>
        <Notice tone="review">{t("auth.noMail")}</Notice>
        <p className="small"><Link to="/deals">{t("auth.verify.skip")}</Link></p>
      </>
    );
  } else if (me.data) {
    body = (
      <>
        <div>
          <h1 className="h1">{t("auth.verify.check")}</h1>
          <p className="muted auth-sub">{t("auth.verify.sent", { email: me.data.user.email })}</p>
        </div>
        <form className="stack tight" onSubmit={submit} noValidate>
          <div className="field"><label htmlFor="code">{t("auth.verify.code")}</label>
            <input className="input num auth-code" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required aria-invalid={badCode || undefined} /></div>
          {badCode && <Notice tone="stop" role="alert">{t("auth.verify.codeBad")}</Notice>}
          <FormError error={error} />
          <button className="btn primary auth-wide" type="submit" disabled={busy}>{t("auth.verify.continue")}</button>
        </form>
        <p className="small muted">{t("auth.verify.nothing")} <button type="button" className="auth-linkbtn" onClick={resend.send}>{t("auth.verify.again")}</button>.</p>
        {resend.status}
        <p className="small muted">{t("auth.email.wrong")} <button type="button" className="auth-linkbtn" onClick={() => setChanging(true)}>{t("auth.email.different")}</button>.</p>
        {/* Once changed, the form closes and the sentence above names the new address from the refreshed `me`. */}
        {changing && <ChangeEmail current={me.data.user.email} verified={false} onCancel={() => setChanging(false)} onChanged={() => setChanging(false)} />}
        <p className="small"><Link to="/deals">{t("auth.verify.skip")}</Link></p>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="h1">{t("auth.verify.title")}</h1>
        <FormError error={otherError} />
        <p className="muted">{t("auth.verify.signedOut")}</p>
        <p><Link className="btn primary" to="/login">{t("auth.signIn")}</Link></p>
      </>
    );
  }

  return (
    <AuthFrame heading={t("auth.verify.pitchH")} pitch={t("auth.verify.pitch")} foot={t("auth.pitchFoot")}>
      <div className="card card-pad auth-card">{body}</div>
    </AuthFrame>
  );
}
