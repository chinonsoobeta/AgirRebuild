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

/** "Send it again": a fresh link and code; earlier ones stop working. Shows that it was sent, or the API's sentence. */
function useResend() {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setSent(false);
    setError(null);
    try {
      await api.post("/auth/verify/send", {});
      setSent(true);
    } catch (e) {
      setError(e);
    }
  };
  const status = (
    <>
      {sent && <Notice tone="pass" role="status">{t("auth.verify.againSent")}</Notice>}
      <FormError error={error} />
    </>
  );
  return { send, status };
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
  const loading = !me.data && !me.error;
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
          {loading ? null : signedIn ? (
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
