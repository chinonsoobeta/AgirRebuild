// Small building blocks of the design system (styles/base.css). Native elements only, so
// each works with the keyboard and a screen reader without extra script.
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import * as I from "./icons";

export type TagTone = "pass" | "review" | "stop" | "neutral" | "plain";

/** A status word with a coloured dot; "neutral" is the grey tag, "plain" has no dot. */
export function Tag({ tone = "neutral", children }: { tone?: TagTone; children?: ReactNode }) {
  return <span className={tone === "neutral" ? "tag" : `tag ${tone}`}>{children}</span>;
}

export type NoticeTone = "accent" | "pass" | "review" | "stop";
const NOTICE_GLYPH: Record<NoticeTone | "none", (p: { size?: number }) => React.JSX.Element> = { accent: I.Info, pass: I.Check, review: I.Warning, stop: I.Warning, none: I.Info };

/** A tinted box that says something about the page; no tone is the quiet grey one. */
export function Notice({ tone, title, role, children }: { tone?: NoticeTone; title?: ReactNode; role?: "status" | "alert"; children?: ReactNode }) {
  const G = NOTICE_GLYPH[tone ?? "none"];
  return (
    <div className={tone ? `notice ${tone}` : "notice"} role={role}>
      <G size={16} />
      <div>
        {title && <strong>{title}</strong>}
        {title && children ? " " : null}
        {children}
      </div>
    </div>
  );
}

/** Key figures in a row of cards: a description list. */
export function Figures({ children }: { children?: ReactNode }) {
  return <dl className="figs">{children}</dl>;
}

export function Figure({ k, v, s }: { k: ReactNode; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="fig">
      <dt className="k">{k}</dt>
      <dd className="v">{v}</dd>
      {s !== undefined && s !== null && <dd className="s">{s}</dd>}
    </div>
  );
}

/** A segmented control: one pressed button out of a labelled group. */
export function Seg<V extends string>({ label, options, value, onChange }: { label: string; options: { value: V; label: ReactNode }[]; value: V; onChange: (v: V) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : undefined} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** An on/off switch: a native button with the switch role. */
export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? "switch on" : "switch"} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export type ChoiceOption = { value: string; title: ReactNode; description?: ReactNode; disabled?: boolean };
type ChoiceCardsProps = { name: string; legend: ReactNode; options: ChoiceOption[]; disabled?: boolean } & (
  | { multiple?: false; value: string | null; onChange: (v: string) => void }
  | { multiple: true; value: string[]; onChange: (v: string[]) => void }
);

/** Radio (one) or checkbox (several) choices as cards, each with a title and a description. */
export function ChoiceCards(props: ChoiceCardsProps) {
  const { name, legend, options, disabled } = props;
  const on = (v: string) => (props.multiple ? props.value.includes(v) : props.value === v);
  const pick = (v: string) => {
    if (props.multiple) props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    else props.onChange(v);
  };
  return (
    <fieldset className="stack tight">
      <legend className="label">{legend}</legend>
      <div className="choices">
        {options.map((o) => (
          <label key={o.value} className={on(o.value) ? "choice on" : "choice"}>
            <input type={props.multiple ? "checkbox" : "radio"} name={name} value={o.value} checked={on(o.value)} disabled={disabled || o.disabled} onChange={() => pick(o.value)} />
            <span>
              <span className="t">{o.title}</span>
              {o.description !== undefined && <span className="d">{o.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Switches between light and dark: a moon while light, a sun while dark. */
export function ThemeToggle() {
  const { theme, setPref } = useTheme();
  const { t } = useI18n();
  const dark = theme === "dark";
  return (
    <button type="button" className="iconbtn" aria-label={t(dark ? "shell.toLight" : "shell.toDark")} data-icon={dark ? "sun" : "moon"} onClick={() => setPref(dark ? "light" : "dark")}>
      {dark ? <I.Sun size={18} /> : <I.Moon size={18} />}
    </button>
  );
}
