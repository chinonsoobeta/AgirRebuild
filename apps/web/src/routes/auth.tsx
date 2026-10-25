import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { ChoiceCards, Notice, ThemeToggle } from "../components/kit";
import { useI18n } from "../i18n";

/** The product's mark and name, as on the boards. Not a link: every signed-out screen is its own destination. */
export function Brand({ large }: { large?: boolean }) {
  return (
    <span className={large ? "brand auth-brand-lg" : "brand"}>
      <span className="brand-mark" aria-hidden="true">
        <svg width={large ? 14 : 12} height={large ? 14 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18L12 5l8 13" /><path d="M8 18h8" /></svg>
      </span>
      Agir
    </span>
  );
}

/** The language switch and the theme toggle, reachable on every signed-out screen. */
export function SignedOutControls() {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="topbar-right">
      <button type="button" className="toplink auth-lang" lang={lang === "en" ? "fr" : "en"} onClick={() => setLang(lang === "en" ? "fr" : "en")}>{t("nav.language")}</button>
      <ThemeToggle />
    </div>
  );
}

/** A signed-out page with a top bar: the invitation and the shared link. */
export function SignedOutPage({ tag, children }: { tag?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Brand />
        {tag}
        <SignedOutControls />
      </header>
      <main className="page narrow auth-page">{children}</main>
    </>
  );
}

/** A form error: the API's sentence, announced. */
export function FormError({ error }: { error: unknown }) {
  const { err } = useI18n();
  if (!error) return null;
  return <Notice tone="stop" role="alert">{err(error)}</Notice>;
}

/** The split layout of the signed-out forms: the pitch on the left, the form on the right. `heading` replaces the pitch's
 * usual first line. */
export function AuthFrame({ heading, pitch, foot, children }: { heading?: string; pitch: string; foot?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="split">
      <section className="pitch">
        <div className="auth-pitch-top">
          <div className="row between"><Brand large /><SignedOutControls /></div>
          <p className="pitch-h">{heading ?? t("auth.pitch")}</p>
          <p className="lead auth-pitch-lead">{pitch}</p>
        </div>
        {foot && <p className="small muted">{foot}</p>}
      </section>
      <main className="auth-side">{children}</main>
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
    <section className="card card-pad auth-card auth-demo" aria-labelledby="auth-demo">
      <h2 className="h2" id="auth-demo">{t("auth.demo")}</h2>
      <div className="row">
        <button className="btn quiet" type="button" onClick={() => go("analyst")}>{t("auth.demoAnalyst")}</button>
        <button className="btn quiet" type="button" onClick={() => go("reviewer")}>{t("auth.demoReviewer")}</button>
      </div>
      <p className="hint">{t("auth.demoHelp")}</p>
    </section>
  );
}

const value = (e: FormEvent<HTMLFormElement>, k: string) => (e.currentTarget.elements.namedItem(k) as HTMLInputElement).value;

export function Login() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { email: value(e, "email"), password: value(e, "password") };
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", body);
      await qc.invalidateQueries();
      void navigate({ to: "/deals" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame pitch={t("auth.pitchBody")} foot={t("auth.pitchFoot")}>
      <div className="auth-column">
        <form className="card card-pad auth-card" onSubmit={submit} noValidate>
          <div>
            <h1 className="h1">{t("auth.signIn")}</h1>
            <p className="muted auth-sub">{t("auth.welcome")}</p>
          </div>
          <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
          <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="current-password" required /><p className="small auth-forgot"><Link to="/reset">{t("auth.reset.title")}</Link></p></div>
          <FormError error={error} />
          <button className="btn primary auth-wide" type="submit" disabled={busy}>{busy ? t("auth.signingIn") : t("auth.signIn")}</button>
          <p className="small auth-alt"><Link to="/signup">{t("auth.createAccount")}</Link></p>
        </form>
        <DemoSignIn />
      </div>
    </AuthFrame>
  );
}

export function Signup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<string>("solo");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { name: value(e, "name"), email: value(e, "email"), password: value(e, "password"), reviewMode: mode };
    setError(null);
    try {
      await api.post("/auth/signup", body);
      await qc.invalidateQueries();
      // The API has sent a confirmation email: the next page asks for its code.
      void navigate({ to: "/verify" });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <AuthFrame pitch={t("auth.signupPitch")}>
      <form className="card card-pad auth-card auth-card-wide" onSubmit={submit} noValidate>
        <div>
          <h1 className="h1">{t("auth.createAccount")}</h1>
          <p className="muted auth-sub">{t("auth.signupLead")}</p>
        </div>
        <div className="field"><label htmlFor="name">{t("auth.name")}</label><input className="input" id="name" name="name" autoComplete="name" required aria-describedby="name-hint" /><p className="hint" id="name-hint">{t("auth.nameHint")}</p></div>
        <div className="field"><label htmlFor="email">{t("auth.email")}</label><input className="input" id="email" name="email" type="email" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="password">{t("auth.password")}</label><input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required aria-describedby="password-hint" /><p className="hint" id="password-hint">{t("auth.passwordHelp")}</p></div>
        <div className="stack tight">
          <ChoiceCards name="reviewMode" legend={t("auth.reviewMode")} value={mode} onChange={setMode}
            options={(["solo", "team"] as const).map((m) => ({ value: m, title: t(`auth.modeTitle.${m}`), description: t(`auth.modeDesc.${m}`) }))} />
          <p className="hint">{t("auth.modeHint")}</p>
        </div>
        <FormError error={error} />
        <button className="btn primary auth-wide" type="submit">{t("auth.create")}</button>
        <p className="small auth-alt"><Link to="/login">{t("auth.haveAccount")}</Link></p>
      </form>
    </AuthFrame>
  );
}
