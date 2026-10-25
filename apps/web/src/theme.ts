// Light and dark themes. The preference is kept on this device under "agir.theme";
// "system" follows the operating system's colour scheme, live. index.html applies the
// stored preference before first paint with the same rules, so a page never flashes.
import { useEffect, useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";
export const THEME_KEY = "agir.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function readPref(): ThemePref {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable: use the default */
  }
  return "light";
}

export function writePref(pref: ThemePref): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, pref);
  } catch {
    /* private window: the choice lasts for this tab */
  }
}

const media = (): MediaQueryList | undefined => (typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(DARK_QUERY) : undefined);

export function resolveTheme(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return media()?.matches ? "dark" : "light";
}

/** Calls back with the system's theme each time it changes; returns the unsubscribe. */
export function watchSystem(cb: (theme: Theme) => void): () => void {
  const m = media();
  if (!m) return () => {};
  const on = (e: { matches: boolean }) => cb(e.matches ? "dark" : "light");
  m.addEventListener("change", on);
  return () => m.removeEventListener("change", on);
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
}

// One store for the whole page, so every toggle and the Settings control agree. Storage is
// the source of truth when it works; a blocked storage keeps the choice in memory for this tab.
let tabPref: ThemePref | null = null;
let last: { pref: ThemePref; theme: Theme } = { pref: "light", theme: "light" };
const listeners = new Set<() => void>();
let stopSystem: (() => void) | null = null;

function storedPref(): ThemePref | null {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return null;
}

const emit = () => listeners.forEach((l) => l());

export const themeStore = {
  getSnapshot(): { pref: ThemePref; theme: Theme } {
    const pref = storedPref() ?? tabPref ?? readPref();
    const theme = resolveTheme(pref);
    if (last.pref !== pref || last.theme !== theme) last = { pref, theme };
    return last;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!stopSystem) stopSystem = watchSystem(emit);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && stopSystem) {
        stopSystem();
        stopSystem = null;
      }
    };
  },
  setPref(p: ThemePref): void {
    writePref(p);
    tabPref = p;
    emit();
  },
};

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const { pref, theme } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
  useEffect(() => applyTheme(theme), [theme]);
  return { pref, theme, setPref: themeStore.setPref };
}
