// The signed-out home (card W4): what Agir does, from the Landing board, with every claim
// true of the code today. No price, no hosting claim and no sample deal's figures.
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { api, ApiError, type Me } from "../api";
import { useI18n } from "../i18n";
import "../strings/landing";
import { ThemeToggle } from "../components/kit";
import * as I from "../components/icons";

/** What "/" shows: the deals when signed in, the landing page on a 401, nothing while the session loads. */
export function homeDecision(me: { isLoading: boolean; data?: unknown; error?: unknown }): "wait" | "deals" | "landing" {
  if (me.isLoading) return "wait";
  if (me.error instanceof ApiError && me.error.status === 401) return "landing";
  // Signed in, or an error other than a 401: the app's own gate shows the deals or the error, as before.
  return "deals";
}

export function Home() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), retry: false });
  // Refetching a signed-out session (say, when the window regains focus) puts it back to loading. The page keeps
  // what it last showed until the new answer arrives, instead of going blank and jumping back to the top.
  const shown = useRef<"deals" | "landing" | null>(null);
  const decided = homeDecision(me);
  if (decided !== "wait") shown.current = decided;
  const next = decided === "wait" ? shown.current : decided;
  if (!next) return null;
  if (next === "deals") return <Navigate to="/deals" />;
  return <Landing />;
}

const Mark = () => (
  <span className="brand-mark">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18L12 5l8 13" /><path d="M8 18h8" /></svg>
  </span>
);

/** The language switch: names the other language, in that language. */
function LanguageLink() {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className="toplink ld-lang" lang={lang === "en" ? "fr" : "en"} onClick={() => setLang(lang === "en" ? "fr" : "en")}>
      {t("nav.language")}
    </button>
  );
}

/** The signed-out top bar, shared by the landing page and the terms. `here` is "/" on the landing page. */
export function LandingBar({ here }: { here: "/" | "/legal" }) {
  const { t } = useI18n();
  const section = (id: string) => (here === "/" ? `#${id}` : `/#${id}`);
  return (
    <header className="topbar">
      <div className="ld-bar ld-bar-full">
        <Link to="/" className="brand" aria-label={t("landing.brandHome")}><Mark />Agir</Link>
        <nav className="nav" aria-label={t("landing.siteNav")}>
          <a href={section("how")}>{t("landing.navHow")}</a>
          <a href={section("get")}>{t("landing.navGet")}</a>
          <a href={section("canada")}>{t("landing.navCanada")}</a>
          <a href={section("questions")}>{t("landing.navQuestions")}</a>
        </nav>
        <div className="topbar-right">
          <LanguageLink />
          <ThemeToggle />
          <Link to="/login" className="toplink">{t("landing.signIn")}</Link>
          <Link to="/signup" className="btn primary">{t("landing.start")}</Link>
        </div>
      </div>
    </header>
  );
}

export function LandingFooter() {
  const { t } = useI18n();
  return (
    <footer className="ld-wrap">
      <div className="ld-foot">
        <p>{t("landing.footNote")}</p>
        <nav aria-label={t("landing.footLinks")}>
          <Link to="/legal" hash="terms">{t("landing.terms")}</Link>
          <Link to="/legal" hash="privacy">{t("landing.privacy")}</Link>
          <LanguageLink />
        </nav>
      </div>
    </footer>
  );
}

const STEPS = ["documents", "review", "run", "decision", "reports"] as const;

export function Landing() {
  const { t } = useI18n();
  const tick = <span className="marker"><I.Check size={10} /></span>;
  return (
    <div className="landing">
      <LandingBar here="/" />
      <main>
        <div className="ld-wrap">
          <section className="ld-hero">
            <div>
              <h1 className="ld-h1">{t("landing.heroTitle")}</h1>
              <p className="ld-sub">{t("landing.heroLead")}</p>
              <div className="row">
                <Link to="/signup" className="btn primary">{t("landing.start")} <I.Chevron size={16} /></Link>
                <a className="btn quiet" href="#how">{t("landing.heroHow")}</a>
              </div>
              <p className="small muted ld-for">{t("landing.heroFor")}</p>
            </div>
            <div className="ld-glimpse">
              <div className="card card-pad">
                <h2 className="h3">{t("landing.glimpseTitle")}</h2>
                <p className="muted ld-glimpse-lead">{t("landing.glimpseLead")}</p>
                <ol className="path ld-path" aria-label={t("landing.glimpseSteps")}>
                  {STEPS.map((s) => (
                    <li key={s} className="step">
                      <span className="marker" />
                      <span className="step-name">{t(`step.${s}`)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          <section className="ld-sec" id="how" aria-labelledby="ld-how">
            <h2 className="h1" id="ld-how">{t("landing.stepsTitle")}</h2>
            <p className="lead">{t("landing.stepsLead")}</p>
            <ol className="ld-steps">
              {STEPS.map((s, i) => (
                <li key={s} className="ld-step">
                  <span className="n" aria-hidden="true">{i + 1}</span>
                  <h3>{t(`step.${s}`)}</h3>
                  <p>{t(`landing.step${(i + 1) as 1 | 2 | 3 | 4 | 5}Body`)}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="ld-sec" id="get" aria-labelledby="ld-get">
            <h2 className="h1" id="ld-get">{t("landing.getTitle")}</h2>
            <div className="ld-three">
              {(["buildDecision", "lenderPackage", "partnerMemo"] as const).map((k) => (
                <div key={k} className="card card-pad">
                  <h3 className="h3">{t(`landing.${k}`)}</h3>
                  <p className="muted ld-body">{t(`landing.${k}Body`)}</p>
                </div>
              ))}
            </div>
            <p className="small muted ld-note">{t("landing.getNote")}</p>
          </section>

          <section className="ld-sec" id="canada" aria-labelledby="ld-canada">
            <h2 className="h1" id="ld-canada">{t("landing.canadaTitle")}</h2>
            <p className="lead">{t("landing.canadaLead")}</p>
            <ul className="ld-rules">
              {(["canadaMli", "canadaTax", "canadaCharges", "canadaExits", "canadaUnits", "canadaTeam"] as const).map((k) => (
                <li key={k}>{tick}<span>{t(`landing.${k}`)}</span></li>
              ))}
            </ul>
          </section>

          <section className="ld-sec" id="engine" aria-labelledby="ld-engine">
            <h2 className="h1" id="ld-engine">{t("landing.engineTitle")}</h2>
            <div className="ld-three">
              {(["guessed", "source", "replay"] as const).map((k) => (
                <div key={k}>
                  <h3 className="h3">{t(`landing.${k}`)}</h3>
                  <p className="muted ld-body">{t(`landing.${k}Body`)}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="ld-sec" id="questions" aria-labelledby="ld-questions">
            <h2 className="h1" id="ld-questions">{t("landing.questionsTitle")}</h2>
            <div className="ld-faq">
              {(["Advice", "Scans", "Share", "Ai"] as const).map((k) => (
                <div key={k}>
                  <h3>{t(`landing.q${k}`)}</h3>
                  <p>{t(`landing.a${k}`)}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
