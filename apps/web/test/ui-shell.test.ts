import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../src/i18n.tsx";
import { THEME_KEY, applyTheme, readPref, resolveTheme, useTheme, watchSystem, writePref } from "../src/theme.ts";
import { ChoiceCards, Figure, Figures, Notice, Seg, Switch, Tag, ThemeToggle } from "../src/components/kit.tsx";
import { Banner, StatusTag, VerdictBadge } from "../src/components/ui.tsx";

// ---- Fakes for the browser pieces the theme reads -------------------------------------------
let store: Map<string, string>;
let storageThrows = false;
let systemDark = false;
let listeners: ((e: { matches: boolean }) => void)[] = [];
let root: { dataset: Record<string, string>; lang: string };

beforeEach(() => {
  store = new Map();
  storageThrows = false;
  systemDark = false;
  listeners = [];
  root = { dataset: {}, lang: "en" };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => { if (storageThrows) throw new Error("blocked"); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (storageThrows) throw new Error("blocked"); store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal("matchMedia", (q: string) => ({
    media: q,
    get matches() { return q.includes("dark") && systemDark; },
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => { listeners.push(l); },
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => { listeners = listeners.filter((x) => x !== l); },
  }));
  vi.stubGlobal("document", { documentElement: root });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the theme preference", () => {
  it("defaults to light, and to light again when storage holds nonsense or throws", () => {
    expect(readPref()).toBe("light");
    store.set(THEME_KEY, "purple");
    expect(readPref()).toBe("light");
    storageThrows = true;
    expect(readPref()).toBe("light");
    expect(() => writePref("dark")).not.toThrow();
  });

  it("is kept under agir.theme", () => {
    expect(THEME_KEY).toBe("agir.theme");
    writePref("dark");
    expect(store.get("agir.theme")).toBe("dark");
    expect(readPref()).toBe("dark");
    writePref("system");
    expect(readPref()).toBe("system");
  });

  it("resolves system from the colour-scheme media query", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("light");
    systemDark = true;
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("follows the system's changes live, until unsubscribed", () => {
    const seen: string[] = [];
    const stop = watchSystem((t) => seen.push(t));
    expect(listeners).toHaveLength(1);
    listeners[0]!({ matches: true });
    listeners[0]!({ matches: false });
    expect(seen).toEqual(["dark", "light"]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it("is applied to the root element's data-theme", () => {
    applyTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    applyTheme("light");
    expect(root.dataset.theme).toBe("light");
  });

  it("useTheme reports the stored preference and the theme it resolves to", () => {
    store.set(THEME_KEY, "system");
    systemDark = true;
    let got: ReturnType<typeof useTheme> | undefined;
    const Probe = () => { got = useTheme(); return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(got?.pref).toBe("system");
    expect(got?.theme).toBe("dark");
    expect(typeof got?.setPref).toBe("function");
  });
});

const html = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, null, node));

describe("the theme toggle", () => {
  it("offers dark mode with a moon while light", () => {
    const out = html(createElement(ThemeToggle));
    expect(out).toContain('class="iconbtn"');
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Switch to dark mode"');
    expect(out).toContain('data-icon="moon"');
  });
  it("offers light mode with a sun while dark", () => {
    store.set(THEME_KEY, "dark");
    const out = html(createElement(ThemeToggle));
    expect(out).toContain('aria-label="Switch to light mode"');
    expect(out).toContain('data-icon="sun"');
  });
  it("speaks French when the interface does", () => {
    store.set("agir.lang", "fr");
    expect(html(createElement(ThemeToggle))).toContain('aria-label="Passer au mode sombre"');
  });
});

describe("the kit", () => {
  it("Tag carries its tone as the design's class", () => {
    expect(renderToStaticMarkup(createElement(Tag, { tone: "pass" }, "Ready"))).toBe('<span class="tag pass">Ready</span>');
    expect(renderToStaticMarkup(createElement(Tag, { tone: "stop" }, "Blocked"))).toBe('<span class="tag stop">Blocked</span>');
    expect(renderToStaticMarkup(createElement(Tag, { tone: "neutral" }, "Draft"))).toBe('<span class="tag">Draft</span>');
    expect(renderToStaticMarkup(createElement(Tag, { tone: "plain" }, "3 files"))).toBe('<span class="tag plain">3 files</span>');
  });

  it("Notice shows a tone, an optional title and its text", () => {
    const out = renderToStaticMarkup(createElement(Notice, { tone: "review", title: "Two values disagree" }, "Pick one."));
    expect(out).toMatch(/^<div class="notice review"><svg[^>]*aria-hidden="true"/);
    expect(out).toContain("<strong>Two values disagree</strong>");
    expect(out).toContain("Pick one.");
    expect(renderToStaticMarkup(createElement(Notice, { tone: "accent" }, "Just so you know."))).not.toContain("<strong>");
  });

  it("Figures is a description list of figures", () => {
    const out = renderToStaticMarkup(createElement(Figures, null, createElement(Figure, { k: "Yield on cost", v: "6.85%", s: "gate: 6.00% or more" }), createElement(Figure, { k: "Units", v: "12" })));
    expect(out).toBe('<dl class="figs"><div class="fig"><dt class="k">Yield on cost</dt><dd class="v">6.85%</dd><dd class="s">gate: 6.00% or more</dd></div><div class="fig"><dt class="k">Units</dt><dd class="v">12</dd></div></dl>');
  });

  it("Seg is a labelled group of pressed-state buttons", () => {
    const out = renderToStaticMarkup(createElement(Seg, { label: "Days of access", value: "14", onChange: () => {}, options: [{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }] }));
    expect(out).toBe('<div class="seg" role="group" aria-label="Days of access"><button type="button" aria-pressed="false">7 days</button><button type="button" class="on" aria-pressed="true">14 days</button></div>');
  });

  it("Switch is a native button with the switch role", () => {
    expect(renderToStaticMarkup(createElement(Switch, { label: "Let Claude suggest", checked: true, onChange: () => {} })))
      .toBe('<button type="button" role="switch" aria-checked="true" aria-label="Let Claude suggest" class="switch on"></button>');
    expect(renderToStaticMarkup(createElement(Switch, { label: "Let Claude suggest", checked: false, onChange: () => {}, disabled: true })))
      .toBe('<button type="button" role="switch" aria-checked="false" aria-label="Let Claude suggest" class="switch" disabled=""></button>');
  });

  it("ChoiceCards are native radios or checkboxes inside labelled cards", () => {
    const options = [{ value: "approve", title: "Approve", description: "Go ahead as the run stands." }, { value: "reject", title: "Reject" }];
    const radio = renderToStaticMarkup(createElement(ChoiceCards, { name: "d", legend: "Your decision", value: "approve", onChange: () => {}, options }));
    expect(radio).toContain("<fieldset");
    expect(radio).toContain('<legend class="label">Your decision</legend>');
    expect(radio).toContain('<div class="choices">');
    expect(radio).toContain('<label class="choice on"><input type="radio" name="d" value="approve" checked=""/><span><span class="t">Approve</span><span class="d">Go ahead as the run stands.</span></span></label>');
    expect(radio).toContain('<label class="choice"><input type="radio" name="d" value="reject"/><span><span class="t">Reject</span></span></label>');
    const boxes = renderToStaticMarkup(createElement(ChoiceCards, { name: "k", legend: "Keep", multiple: true, value: ["reject"], onChange: () => {}, options }));
    expect(boxes).toContain('<label class="choice"><input type="checkbox" name="k" value="approve"/>');
    expect(boxes).toContain('<label class="choice on"><input type="checkbox" name="k" value="reject" checked=""/>');
  });
});

describe("the shared status pieces, in the design's look", () => {
  it("StatusTag is a tag with a dot, keeping its text", () => {
    expect(renderToStaticMarkup(createElement(StatusTag, { tone: "review" }, "Needs review"))).toBe('<span class="tag review">Needs review</span>');
    expect(renderToStaticMarkup(createElement(StatusTag, { tone: "neutral" }, "Reading"))).toBe('<span class="tag">Reading</span>');
  });
  it("VerdictBadge is a toned tag in sentence case", () => {
    const badge = (code: string) => html(createElement(VerdictBadge, { code }));
    expect(badge("APPROVE")).toMatch(/^<span class="tag pass">[^<]+<\/span>$/);
    expect(badge("APPROVE_WITH_CONDITIONS")).toMatch(/^<span class="tag review">/);
    expect(badge("REJECT")).toMatch(/^<span class="tag stop">/);
    expect(badge("NOT_EVALUATED")).toMatch(/^<span class="tag">/);
  });
  it("Banner is a notice that keeps its role, title and text", () => {
    const out = renderToStaticMarkup(createElement(Banner, { tone: "stop", title: "Blocked" }, "Two documents disagree."));
    expect(out).toMatch(/^<div class="notice stop" role="status">/);
    expect(out).toContain("<strong>Blocked</strong>");
    expect(out).toContain("Two documents disagree.");
    expect(renderToStaticMarkup(createElement(Banner, { tone: "neutral", title: "Note" }))).toMatch(/^<div class="notice" role="status">/);
  });
});
