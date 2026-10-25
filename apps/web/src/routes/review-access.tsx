import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "../api";
import { ErrorText, useSession } from "../components/ui";
import { Notice, Seg } from "../components/kit";
import { useI18n } from "../i18n";
import * as I from "../components/icons";

type Member = { id: string; name: string; email: string; role: string; expires_at: string | null };
const DAYS = ["7", "14", "30"] as const;
const endsOn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
// The server sets the exact end; before it answers, the day is what can be promised.
const day = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { year: "numeric", month: "long", day: "numeric" });

/** Give someone outside the workspace time-limited reviewer access (fn_grant_review): the owner only. */
export function ReviewAccess() {
  const { t, f, lang } = useI18n();
  const { workspaceId, role } = useSession();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [days, setDays] = useState<(typeof DAYS)[number]>("14");
  const [agreed, setAgreed] = useState(false);
  const [done, setDone] = useState<{ email: string; until: string } | null>(null);
  const members = useQuery({ queryKey: ["members", workspaceId], queryFn: () => api.get<Member[]>(`/workspaces/${workspaceId}/members`), enabled: role === "owner" });
  const grant = useMutation({
    mutationFn: (b: { email: string; days: number }) => api.post(`/workspaces/${workspaceId}/review-grant`, b),
    onSuccess: (_r: unknown, b: { email: string; days: number }) => {
      setDone({ email: b.email, until: endsOn(b.days) });
      setEmail("");
      setAgreed(false);
      return qc.invalidateQueries({ queryKey: ["members"] });
    },
  });
  const back = <Link className="back" to="/settings"><I.Back />{t("agirreview.back")}</Link>;

  if (role !== "owner") {
    return (
      <div className="stack">
        <div>{back}<h1 className="h1">{t("agirreview.title")}</h1></div>
        <p className="lead">{t("agirreview.notOwner")} <Link to="/settings">{t("agirreview.toSettings")}</Link></p>
      </div>
    );
  }

  const reviewers = (members.data ?? []).filter((m) => m.role === "reviewer");
  const now = new Date();
  return (
    <div className="stack">
      <div>
        {back}
        <h1 className="h1">{t("agirreview.title")}</h1>
        <p className="lead ra-lead">{t("agirreview.lead")}</p>
      </div>
      <div className="with-aside">
        <div className="card card-pad stack ra-card">
          <div>
            <h2 className="h3">{t("agirreview.who.title")}</h2>
            <p className="muted">{t("agirreview.who.body")}</p>
          </div>
          <div>
            <h2 className="h3">{t("agirreview.see.title")}</h2>
            <p className="muted">{t("agirreview.see.body")}</p>
          </div>
          <div>
            <h2 className="h3">{t("agirreview.can.title")}</h2>
            <p className="muted">{t("agirreview.can.body")}</p>
          </div>
          <p className="hint">{t("agirreview.audit")}</p>
          {done && <Notice tone="pass" role="status">{t("agirreview.done", { email: done.email, date: day(done.until, lang) })}</Notice>}
          <form
            className="stack tight"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              if (!agreed) return;
              setDone(null);
              return grant.mutate({ email: email.trim(), days: Number(days) });
            }}
          >
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="ra-email">{t("agirreview.email")}</label>
              <input className="input" id="ra-email" name="email" type="email" required value={email} aria-describedby="ra-email-hint"
                onChange={(e) => setEmail(e.target.value)} />
              <span className="hint" id="ra-email-hint">{t("agirreview.emailHint")}</span>
            </div>
            <div className="field">
              <span className="label">{t("agirreview.days")}</span>
              <div><Seg label={t("agirreview.days")} value={days} onChange={setDays} options={DAYS.map((d) => ({ value: d, label: t("agirreview.dayN", { n: d }) }))} /></div>
              <span className="hint">{t("agirreview.daysHint", { date: day(endsOn(Number(days)), lang) })}</span>
            </div>
            <label className="check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>{t("agirreview.consent")}</span>
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={!agreed || grant.isPending}>{t("agirreview.submit", { n: days })}</button>
              <Link className="btn quiet" to="/settings">{t("agirreview.toSettings")}</Link>
            </div>
            <ErrorText error={grant.error} />
          </form>
        </div>
        <aside className="card card-pad stack tight" aria-labelledby="ra-list">
          <h2 className="h3" id="ra-list">{t("agirreview.list")}</h2>
          <p className="muted small">{t("agirreview.listBody")}</p>
          {reviewers.length === 0 ? <p className="muted">{t("agirreview.none")}</p> : (
            <div className="scroll">
              <table className="table">
                <thead><tr><th scope="col">{t("agirreview.col.name")}</th><th scope="col">{t("agirreview.col.access")}</th></tr></thead>
                <tbody>{reviewers.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}<span className="sub">{m.email}</span></td>
                    <td>{m.expires_at ? t(new Date(m.expires_at) > now ? "agirreview.until" : "agirreview.ended", { date: f.date(m.expires_at) }) : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <ErrorText error={members.error} />
        </aside>
      </div>
    </div>
  );
}
