import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";

/**
 * Disabled while submitting (QA card C4). `run` ignores a second call while the first is in flight: a double click lands
 * before React has drawn the button disabled, so `disabled` alone lets it through. `pending` disables the button meanwhile.
 */
export function useSubmitting() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, run };
}

/** The field a refused request names (the API's `detail.field`), or null. */
export const refusedField = (error: unknown): string | null =>
  error instanceof ApiError && typeof error.detail?.field === "string" ? error.detail.field : null;

/** A field's value as typed, and trimmed. */
export const fieldText = (e: FormEvent<HTMLFormElement>, name: string): string =>
  String((e.currentTarget.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "").trim();

/** A field's own error, under the field. */
export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return <p className="error-text" id={id} role="alert">{message}</p>;
}

/** The length of a text field against its maxLength, shown under it so a long paste is never cut silently. */
export function CharCount({ id, n, max }: { id: string; n: number; max: number }) {
  const { t, lang } = useI18n();
  const num = (x: number) => x.toLocaleString(lang === "fr" ? "fr-CA" : "en-CA");
  return <p className="hint" id={id}>{n >= max ? t("form.atLimit", { max: num(max) }) : t("form.count", { n: num(n), max: num(max) })}</p>;
}

/** The length of an uncontrolled field, for CharCount: pass `onInput` to the field. */
export function useLength() {
  const [n, setN] = useState(0);
  return { n, onInput: (e: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => setN(e.currentTarget.value.length), reset: () => setN(0) };
}
