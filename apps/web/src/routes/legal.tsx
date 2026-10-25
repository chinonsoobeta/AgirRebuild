// The terms and privacy page (card W4), from the Legal board. It is a draft: the notice at the
// top says so in both languages, and anything not decided yet is written as to be settled.
import { EN, FR, useI18n } from "../i18n";
import { Notice, Seg } from "../components/kit";
import * as I from "../components/icons";
import { LandingBar, LandingFooter } from "./landing";

type Part = { id: string; title: string; sections: { id: string; title: string; notice?: string; body: string[] }[] };
const PARTS: Part[] = [
  {
    id: "terms",
    title: "landing.legal.terms",
    sections: [
      { id: "what", title: "landing.legal.what", notice: "landing.legal.whatNotice", body: ["landing.legal.what1", "landing.legal.what2"] },
      { id: "yours", title: "landing.legal.yours", body: ["landing.legal.yours1", "landing.legal.yours2"] },
      { id: "share", title: "landing.legal.share", body: ["landing.legal.share1", "landing.legal.share2"] },
      { id: "pay", title: "landing.legal.pay", body: ["landing.legal.pay1"] },
      { id: "end", title: "landing.legal.end", body: ["landing.legal.end1"] },
      { id: "law", title: "landing.legal.law", body: ["landing.legal.law1"] },
    ],
  },
  {
    id: "privacy",
    title: "landing.legal.privacy",
    sections: [
      { id: "data", title: "landing.legal.data", body: ["landing.legal.data1", "landing.legal.data2", "landing.legal.data3"] },
      { id: "ai", title: "landing.legal.ai", body: ["landing.legal.ai1", "landing.legal.ai2", "landing.legal.ai3"] },
    ],
  },
];

export function Legal() {
  const { t, lang, setLang } = useI18n();
  const tt = (k: string) => t(k as keyof typeof EN) as string;
  // The draft notice is shown in both languages, the reader's own first.
  const notices = (lang === "fr" ? (["fr", "en"] as const) : (["en", "fr"] as const)).map((l) => ({ l, text: (l === "fr" ? FR : EN)["landing.legal.draft"] as string }));
  return (
    <div className="landing">
      <LandingBar here="/legal" />
      <main className="page">
        <div className="page-head">
          <div>
            <h1 className="h1">{t("landing.legal.title")}</h1>
            <p className="lead">{t("landing.legal.lead")}</p>
          </div>
          <Seg label={t("landing.language")} value={lang} onChange={setLang} options={[{ value: "en", label: <span lang="en">{t("landing.english")}</span> }, { value: "fr", label: <span lang="fr">{t("landing.french")}</span> }]} />
        </div>
        <div className="notice review legal-draft" role="note">
          <I.Warning size={16} />
          <div>
            {notices.map(({ l, text }) => <p key={l} lang={l === "fr" ? "fr-CA" : "en"}><strong>{text}</strong></p>)}
          </div>
        </div>
        <div className="set">
          <nav className="toc" aria-label={t("landing.legal.toc")}>
            {PARTS.map((part) => (
              <div key={part.id} className="legal-toc-part">
                <a href={`#${part.id}`} className="legal-toc-head">{tt(part.title)}</a>
                {part.sections.map((s) => <a key={s.id} href={`#${s.id}`}>{tt(s.title)}</a>)}
              </div>
            ))}
          </nav>
          <div className="card card-pad prose legal">
            {PARTS.map((part) => (
              <section key={part.id} id={part.id} aria-labelledby={`${part.id}-title`}>
                <h2 id={`${part.id}-title`}>{tt(part.title)}</h2>
                {part.sections.map((s) => (
                  <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`}>
                    <h3 id={`${s.id}-title`}>{tt(s.title)}</h3>
                    {s.notice && <Notice tone="accent">{tt(s.notice)}</Notice>}
                    {s.body.map((k) => <p key={k}>{tt(k)}</p>)}
                  </section>
                ))}
              </section>
            ))}
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
