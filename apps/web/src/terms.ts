// Finance terms: plain words first, or finance terms first. The preference is kept on this
// device under "agir.terms" (default plain words). One store for the whole page, so every
// screen follows a change at once. Modelled on theme.ts.
import { useSyncExternalStore } from "react";

export type TermsPref = "plain" | "finance";
export const TERMS_KEY = "agir.terms";

function storedPref(): TermsPref | null {
  try {
    const v = globalThis.localStorage?.getItem(TERMS_KEY);
    if (v === "plain" || v === "finance") return v;
  } catch {
    /* storage unavailable: use the default */
  }
  return null;
}

function writePref(pref: TermsPref): void {
  try {
    globalThis.localStorage?.setItem(TERMS_KEY, pref);
  } catch {
    /* private window: the choice lasts for this tab */
  }
}

// A choice made in this tab is kept in memory and written to storage; at start the stored choice is used.
let tabPref: TermsPref | null = null;
const listeners = new Set<() => void>();

export const termsStore = {
  getSnapshot(): TermsPref {
    // This tab's own choice wins: a storage that refuses writes may still return an older value.
    return tabPref ?? storedPref() ?? "plain";
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setPref(p: TermsPref): void {
    writePref(p);
    tabPref = p;
    listeners.forEach((l) => l());
  },
  /** Forgets this tab's choice, so the stored one applies again. For tests. */
  reset(): void {
    tabPref = null;
  },
};

export function useTerms(): { terms: TermsPref; setTerms: (p: TermsPref) => void } {
  const terms = useSyncExternalStore(termsStore.subscribe, termsStore.getSnapshot, termsStore.getSnapshot);
  return { terms, setTerms: termsStore.setPref };
}
