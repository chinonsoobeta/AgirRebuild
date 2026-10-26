import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Notice } from "../components/kit";
import { useI18n } from "../i18n";
import "../strings/auth";
import { AuthFrame, FormError } from "./auth";
import { takeToken } from "./verify";

const value = (e: FormEvent<HTMLFormElement>, k: string) => (e.currentTarget.elements.namedItem(k) as HTMLInputElement).value;

/** Forgot your password: ask for a link (no token), or choose a new password from the link (with `?token=`). Outside the
 * session gate. The answer to asking never says whether an account uses the address. */
export function Reset() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState(takeToken);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [unsent, setUnsent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const ask = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = value(e, "email").trim();
    setSentTo(null);
    return run(async () => {
      const r = await api.post<{ sent?: false }>("/auth/reset/send", { email });
      // sent: false means this server has no mail provider (card B), never whether the account exists.
      setUnsent(r.sent === false);
      setSentTo(email);
    });
  };
  const choose = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = value(e, "password");
    const same = password === value(e, "password2");
    setMismatch(!same);
    if (!same) return;
    return run(async () => {
      await api.post("/auth/reset", { token, password, signOutOthers: others });
      await qc.invalidateQueries();
      void navigate({ to: "/deals" });
    });
  };
  const restart = () => {
    setToken(null);
    setError(null);
    setMismatch(false);
  };

  return (
    <AuthFrame heading={t("auth.reset.pitchH")} pitch={t("auth.reset.pitch")} foot={t("auth.pitchFoot")}>
      {token ? (
        <form className="card card-pad auth-card" onSubmit={choose}>
          <h1 className="h1">{t("auth.reset.choose")}</h1>
          <div className="field"><label htmlFor="password">{t("auth.reset.new")}</label>
            <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={200} required aria-describedby="password-hint" />
            <p className="hint" id="password-hint">{t("auth.passwordHelp")}</p></div>
          <div className="field"><label htmlFor="password2">{t("auth.reset.again")}</label>
            <input className="input" id="password2" name="password2" type="password" autoComplete="new-password" minLength={10} maxLength={200} required aria-invalid={mismatch || undefined} /></div>
          {mismatch && <Notice tone="stop" role="alert">{t("auth.reset.mismatch")}</Notice>}
          <label className="check" htmlFor="others"><input type="checkbox" id="others" name="others" checked={others} onChange={(e) => setOthers(e.target.checked)} />{t("auth.reset.others")}</label>
          <FormError error={error} />
          {error instanceof ApiError && error.status === 400 && <p className="small"><Link to="/reset" onClick={restart}>{t("auth.reset.askNew")}</Link></p>}
          <button className="btn primary auth-wide" type="submit" disabled={busy}>{t("auth.reset.save")}</button>
        </form>
      ) : (
        <form className="card card-pad auth-card" onSubmit={ask}>
          <div>
            <h1 className="h1">{t("auth.reset.title")}</h1>
            <p className="muted auth-sub">{t("auth.reset.lead")}</p>
          </div>
          <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
          {sentTo !== null && (unsent ? <Notice tone="review" role="status">{t("auth.noMail")}</Notice>
            : <Notice tone="pass" role="status">{t("auth.reset.sent", { email: sentTo })}</Notice>)}
          <FormError error={error} />
          <button className="btn primary auth-wide" type="submit" disabled={busy}>{t("auth.reset.send")}</button>
          <p className="small muted auth-alt">{sentTo === null && <>{t("auth.reset.works")} </>}<Link to="/login">{t("auth.reset.back")}</Link></p>
        </form>
      )}
    </AuthFrame>
  );
}
