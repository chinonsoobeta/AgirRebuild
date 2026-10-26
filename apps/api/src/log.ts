// Card B: one JSON line per event on stdout, and an optional alert hook. Callers pass event names, ids, counts and
// statuses; never document content, names, emails, links or secrets.

export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (event: string, fields?: LogFields) => void;

/** Writes `{ at, event, ...fields }` as one line on stdout. Through console.log, so the tests that read every console line
 * for a leaked secret also read these. */
export const log: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
};

const ALERT_TIMEOUT_MS = 5_000;

/**
 * An alert function that POSTs `{ at, event, ...fields }` to `url`, or does nothing without one. The request starts at
 * once; the promise it returns never rejects, and the API never awaits it in a request (fire and forget). Only a refused
 * start awaits it, so the alert leaves before the process exits. A failure (a network error, the timeout, or a status
 * that is not 2xx) is logged as one `alert.failed` line naming the alert's event, and is not retried.
 */
export function alerter(url: string | undefined, fetchImpl: typeof fetch = fetch, logFn: Logger = log): (event: string, fields?: LogFields) => Promise<void> {
  if (!url) return async () => {};
  return async (event, fields = {}) => {
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      if (!r.ok) logFn("alert.failed", { alert: event, status: r.status });
    } catch {
      logFn("alert.failed", { alert: event });
    }
  };
}
