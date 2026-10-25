// Light and dark themes. The preference is kept on this device under "agir.theme";
// "system" follows the operating system's colour scheme, live. index.html applies the
// stored preference before first paint with the same rules, so a page never flashes.
import { useCallback, useEffect, useState } from "react";

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

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(pref));
  useEffect(() => {
    setTheme(resolveTheme(pref));
    return pref === "system" ? watchSystem(setTheme) : undefined;
  }, [pref]);
  useEffect(() => applyTheme(theme), [theme]);
  const setPref = useCallback((p: ThemePref) => {
    writePref(p);
    setPrefState(p);
  }, []);
  return { pref, theme, setPref };
}
