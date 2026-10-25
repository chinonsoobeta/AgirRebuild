import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { AuthFrame, FormError } from "./auth";
import { takeToken } from "./verify";

/**
 * The two pages the change-of-address emails link to (card R6), outside the session gate: they may be opened signed out,
 * on any device. Each takes the token from the address once and posts it exactly once, as Verify does.
 */
function EmailLink({ kind }: { kind: "confirm" | "undo" }) {
  const { t } = useI18n();
  const [token] = useState(takeToken);
  const [result, setResult] = useState<{ email: string } | { error: unknown } | null>(null);
  const posted = useRef(false);
  useEffect(() => {
    // The link works once: post it exactly once, even when the effect runs twice.
    if (!token || posted.current) return;
    posted.current = true;
    api.post<{ email: string }>(`/auth/email/${kind}`, { token }).then(
      (r) => setResult({ email: r.email }),
      (e: unknown) => setResult({ error: e }),
    );
  }, [token, kind]);

  const backToSignIn = <p><Link className="btn primary" to="/login">{t("auth.reset.back")}</Link></p>;
  let body;
  if (token && !result) {
    body = <p className="muted" role="status">{t(kind === "confirm" ? "auth.email.confirming" : "auth.email.undoing")}</p>;
  } else if (result && "email" in result) {
    body = kind === "confirm" ? (
      <>
        <h1 className="h1">{t("auth.email.confirmed", { email: result.email })}</h1>
        <p><Link className="btn primary" to="/deals">{t("auth.verify.toDeals")}</Link></p>
      </>
    ) : (
      <>
        <h1 className="h1">{t("auth.email.undone", { email: result.email })}</h1>
        <p className="muted">{t("auth.email.undoneBody", { email: result.email })}</p>
        {backToSignIn}
      </>
    );
  } else {
    // A used or expired link, or none at all.
    body = (
      <>
        <h1 className="h1">{t("auth.email.failed")}</h1>
        <FormError error={result && "error" in result ? result.error : null} />
        {backToSignIn}
      </>
    );
  }

  return (
    <AuthFrame pitch={t(kind === "confirm" ? "auth.verify.pitch" : "auth.reset.pitch")} foot={t("auth.pitchFoot")}>
      <div className="card card-pad auth-card">{body}</div>
    </AuthFrame>
  );
}

export const EmailConfirm = () => <EmailLink kind="confirm" />;
export const EmailUndo = () => <EmailLink kind="undo" />;
