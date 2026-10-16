import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorText, LanguageSwitch } from "../components/ui";
import { useI18n } from "../i18n";

function AuthFrame({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <div className="auth-left">
        <div className="spread">
          <div className="brand"><i /><b>agir</b></div>
          <LanguageSwitch />
        </div>
        <h1 className="h-display" style={{ fontSize: 60, maxWidth: 620 }}>{t("auth.pitch")}</h1>
        <p className="muted" style={{ maxWidth: 520 }}>{t("auth.pitchBody")}</p>
      </div>
      <div className="auth-right">{children}</div>
    </div>
  );
}

function DemoSignIn() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const demo = useQuery({ queryKey: ["demo"], queryFn: () => api.get<{ available: boolean }>("/auth/demo") });
  if (!demo.data?.available) return null;
  const go = async (who: "analyst" | "reviewer") => {
    await api.post("/auth/demo", { who });
    await qc.invalidateQueries();
    void navigate({ to: "/deals" });
  };
  return (
    <div className="stack" style={{ maxWidth: 420, marginTop: 32, paddingTop: 20, borderTop: "1px solid var(--rule)", gap: 10 }}>
      <span className="label">{t("auth.demo")}</span>
      <div className="row">
        <button className="btn" type="button" onClick={() => go("analyst")}>{t("auth.demoAnalyst")}</button>
        <button className="btn quiet" type="button" onClick={() => go("reviewer")}>{t("auth.demoReviewer")}</button>
      </div>
      <span className="help">{t("auth.demoHelp")}</span>
    </div>
  );
}

export function Login() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { email: f.get("email"), password: f.get("password"), reviewMode: f.get("reviewMode") });
      await qc.invalidateQueries();
      void navigate({ to: "/deals" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame>
      <form onSubmit={submit} noValidate>
        <h2 className="h-title" style={{ fontSize: 34 }}>{t("auth.signIn")}</h2>
        <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="current-password" required /></div>
        <ErrorText error={error} />
        <div className="row"><button className="btn primary" type="submit" disabled={busy}>{busy ? t("auth.signingIn") : t("auth.signIn")}</button><Link to="/signup">{t("auth.createAccount")}</Link></div>
      </form>
      <DemoSignIn />
    </AuthFrame>
  );
}

export function Signup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      await api.post("/auth/signup", { name: f.get("name"), email: f.get("email"), password: f.get("password") });
      await qc.invalidateQueries();
      void navigate({ to: "/deals" });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <AuthFrame>
      <form onSubmit={submit} noValidate>
        <h2 className="h-title" style={{ fontSize: 34 }}>{t("auth.createAccount")}</h2>
        <div className="field"><label htmlFor="name">{t("auth.name")}</label><input className="input" id="name" name="name" autoComplete="name" required /></div>
        <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /><span className="help">{t("auth.passwordHelp")}</span></div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>{t("auth.reviewMode")}</legend>
          {(["solo", "team"] as const).map((m) => <label key={m} className="choice"><input type="radio" name="reviewMode" value={m} defaultChecked={m === "solo"} /><span>{t(`auth.mode.${m}`)}</span></label>)}
        </fieldset>
        <ErrorText error={error} />
        <div className="row"><button className="btn primary" type="submit">{t("auth.create")}</button><Link to="/login">{t("auth.haveAccount")}</Link></div>
      </form>
    </AuthFrame>
  );
}
