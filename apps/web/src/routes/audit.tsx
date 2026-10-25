import { THRESHOLDS, FIELD_BY_KEY } from "@agir/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditEvent } from "../api";
import { DealFrame, useDeal, useSession } from "../components/ui";
import { Tag } from "../components/kit";
import { useI18n, type I18n } from "../i18n";

export function describeEvent(i: I18n, e: AuditEvent): string {
  const p = e.payload ?? {};
  const fr = i.lang === "fr";
  const kind = (k: string) => (k === "ic_memo" ? i.t("reports.memo") : k === "lender_package" ? i.t("reports.lender") : k === "build_decision" ? i.t("reports.buildDecision") : k === "partner_memo" ? i.t("reports.partnerMemo") : i.t("reports.modelExport"));
  const field = () => i.L.field(p.field, p.item || null);
  // A file's format as the reports screen names it: PDF, Word or Excel.
  const format = (f: unknown) => (f === "pdf" ? "PDF" : f === "docx" ? i.t("reports.word") : f === "xlsx" ? i.t("reports.excel") : String(f));
  switch (e.action) {
    case "policy.threshold_changed": {
      const threshold = THRESHOLDS[p.version]?.find((threshold) => threshold.path === p.path);
      const name = threshold?.label[i.lang] ?? p.path ?? "";
      const value = p.new == null ? i.t("threshold.inherited") : i.f.value(Number(p.new),threshold?.unit ?? "count");
      return i.t("audit.thresholdChanged", { name, value, reason: p.reason ?? "" });
    }
    case "deal.created": return fr ? "A créé le projet" : "Created the deal";
    case "document.uploaded": return fr ? `A téléversé ${p.name}` : `Uploaded ${p.name}`;
    case "document.duplicate_ignored": return fr ? `A téléversé ${p.name} de nouveau\u00a0; la copie n'a pas été ajoutée` : `Uploaded ${p.name} again; the copy was not added`;
    case "document.verified": return fr ? "A vérifié un document\u00a0: type, taille et empreinte" : "Checked a document: type, size and fingerprint";
    case "document.rejected": return fr ? `A refusé un document\u00a0: ${i.msg(p.reason)}` : `Rejected a document: ${p.reason}`;
    case "document.extracted": return fr ? `A lu un document\u00a0: ${i.t("docs.values", { n: p.candidates })}` : `Read a document: ${i.t("docs.values", { n: p.candidates })}`;
    case "document.role_set": {
      const role = (value: unknown) => i.t(value === "deal_source" ? "docs.role.deal_source" : value === "evidence" ? "docs.role.evidence" : value === "context" ? "docs.role.context" : "docs.role.auto");
      return i.t("docs.role.changed", { old: role(p.old), new: role(p.new) });
    }
    case "document.retired": return fr ? `A retiré ${p.name}` : `Removed ${p.name}`;
    case "document.retried": return fr ? "A relancé la lecture d'un document" : "Retried reading a document";
    case "assumptions.reconciled": {
      const done = fr ? "A mis à jour la file d'examen à partir des documents" : "Updated the review queue from the documents";
      // Values a removed label or document had reopened, back as they were (cards 58b, 63): named, since no person approved them again.
      const back: { field: string; item: string; by?: "label" | "document" }[] = p.restored_values ?? [];
      if (!back.length) return done;
      const sentence = (by: "label" | "document") => {
        const some = back.filter((v) => (v.by ?? "label") === by);
        if (!some.length) return "";
        const names = some.map((v) => i.L.field(v.field, v.item || null)).join(fr ? "\u00a0; " : "; ");
        const cause = by === "label" ? (fr ? "d'une étiquette" : "a label") : fr ? "d'un document" : "a document";
        return fr ? `${some.length === 1 ? "Rétablie" : "Rétablies"} après le retrait ${cause}\u00a0: ${names}` : `Put back after ${cause} was removed: ${names}`;
      };
      return [done, sentence("label"), sentence("document")].filter(Boolean).join(". ");
    }
    case "run.completed": return fr ? `A lancé l'analyse ${p.run_number}\u00a0: ${i.L.verdict(p.verdict).toLowerCase()}` : `Ran underwriting: run ${p.run_number}, ${String(p.verdict).replace(/_/g, " ").toLowerCase()}`;
    case "decision.recorded":
      return fr
        ? `A consigné la décision «\u00a0${i.L.decision(p.decision).toLowerCase()}\u00a0» pour l'analyse ${p.run_number}${p.against_verdict ? ", contraire au verdict" : ""}`
        : `Recorded the decision "${i.L.decision(p.decision)}" on run ${p.run_number}${p.against_verdict ? ", against the verdict" : ""}`;
    case "artifact.requested": return fr ? `A demandé\u00a0: ${kind(p.kind)} (${format(p.format)})` : `Requested the ${kind(p.kind)} (${format(p.format)})`;
    case "artifact.ready": return fr ? `A diffusé\u00a0: ${kind(p.kind)} (${format(p.format)})` : `Released the ${kind(p.kind)} (${format(p.format)})`;
    case "artifact.blocked": return fr ? "A bloqué un rapport\u00a0: chiffres sans source" : "Blocked a report: figures without a source";
    case "share.created": {
      const terms: Record<string, string> = fr ? { "24h": "24 heures", "7d": "7 jours", "30d": "30 jours", none: "Sans expiration" }
        : { "24h": "24 hours", "7d": "7 days", "30d": "30 days", none: "No expiry" };
      return fr ? `A partagé un lien\u00a0: ${kind(p.kind)} (${format(p.format)}), ${terms[p.term] ?? ""}` : `Shared a link to the ${kind(p.kind)} (${format(p.format)}), ${terms[p.term] ?? ""}`;
    }
    case "share.revoked": return fr ? "A révoqué un lien partagé" : "Revoked a shared link";
    case "share.opened": {
      const what: Record<string, string> = fr ? { page: "la page", file: "le rapport", audit_package: "le dossier d'audit" }
        : { page: "the page", file: "the report", audit_package: "the audit package" };
      return fr ? `A ouvert un lien partagé\u00a0: ${what[p.what] ?? what.page}` : `Opened a shared link: ${what[p.what] ?? what.page}`;
    }
    case "workspace.created": return fr ? "A créé l'espace de travail" : "Created the workspace";
    case "figure.labelled": return fr ? `A étiqueté un chiffre comme ${field()}` : `Labelled a figure as ${field()}`;
    case "figure.unlabelled": return fr ? "A retiré l'étiquette d'un chiffre" : "Removed a figure's label";
    case "label.remembered": return fr ? `A retenu le libellé «\u00a0${p.phrase}\u00a0» comme ${field()} pour les projets de cet espace` : `Remembered the label "${p.phrase}" as ${field()} for this workspace's deals`;
    case "label.forgotten": return fr ? `A oublié le libellé «\u00a0${p.phrase}\u00a0» comme ${field()}` : `Forgot the label "${p.phrase}" as ${field()}`;
    case "deal.copied": return fr ? `A copié comme ${p.name}` : `Copied as ${p.name}`;
    case "deal.created_as_copy": return fr ? `A créé comme copie de ${p.name}` : `Created as a copy of ${p.name}`;
    case "workspace.review_mode_changed": {
      const mode = (m: string) => i.t(m === "team" ? "settings.mode.team" : "settings.mode.solo");
      return fr ? `A changé le mode d'examen\u00a0: ${mode(p.from)} → ${mode(p.to)}` : `Changed the review mode: ${mode(p.from)} to ${mode(p.to)}`;
    }
    case "workspace.label_suggestions_changed": {
      const on = (b: boolean) => (fr ? (b ? "activées" : "désactivées") : b ? "on" : "off");
      return fr ? `A changé les suggestions de libellés\u00a0: ${on(p.from)} → ${on(p.to)}` : `Changed label suggestions: ${on(p.from)} to ${on(p.to)}`;
    }
    case "review.granted":
      return fr ? `A donné accès à un réviseur${p.expires_at ? ` jusqu'au ${i.f.date(p.expires_at)}` : ""}` : `Gave a reviewer access${p.expires_at ? ` until ${i.f.date(p.expires_at)}` : ""}`;
    case "document.suggestions_failed":
      return fr ? "Les suggestions de libellés d'un modèle ont échoué pour un document\u00a0; les valeurs lues restent" : "A model's label suggestions failed for a document; the values read stand";
    case "logo.set": return fr ? "A mis le logo du dossier pour le prêteur" : "Set the lender package logo";
    case "logo.cleared": return fr ? "A retiré le logo du dossier pour le prêteur" : "Removed the lender package logo";
    case "invite.created": return fr ? "A créé un lien d'invitation pour un client" : "Made an invitation link for a client";
    case "invite.revoked": return fr ? "A révoqué un lien d'invitation" : "Revoked an invitation link";
    case "invite.used": return fr ? "Un client s'est joint au projet par un lien d'invitation" : "A client joined the deal through an invitation link";
    case "client.assigned": return fr ? "A ajouté un client à ce projet" : "Added a client to this deal";
    case "client.unassigned": return fr ? "A retiré un client de ce projet" : "Removed a client from this deal";
    case "member.added": return fr ? `A ajouté une personne (${i.L.role(p.role)})` : `Added a person (${p.role})`;
    case "member.removed": return fr ? `A retiré une personne (${i.L.role(p.role)})` : `Removed a person (${p.role})`;
    case "workspace.renamed": return fr ? `A renommé l'espace de travail «\u00a0${p.from}\u00a0» en «\u00a0${p.to}\u00a0»` : `Renamed the workspace from "${p.from}" to "${p.to}"`;
    case "review.ended": return fr ? "A mis fin à l'accès d'un réviseur" : "Ended a reviewer's access";
    case "user.renamed": return fr ? "A changé son nom" : "Changed their name";
    default:
      if (e.action.startsWith("assumption.")) {
        const action = e.action.slice(11);
        const FR_ACT: Record<string, string> = {
          approve: "Approuvée", resolve: "Conflit résolu", modify: "Valeur modifiée", second_approve: "Confirmée par un second approbateur", reject: "Rejetée",
          reopen: "Rouverte", enter: "Valeur saisie", accept_default: "Valeur par défaut acceptée", override_pending_second_approval: "Dérogation en attente",
          copied: "Copiée", use_as_stated: "Utilisée telle qu'énoncée", needs_second_approver: "Second approbateur requis", client_confirm: "Confirmée par le client",
        };
        const EN_ACT: Record<string, string> = {
          enter: "Entered", approve: "Approved", resolve: "Resolved", modify: "Modified", second_approve: "Confirmed by a second approver", reject: "Rejected",
          reopen: "Reopened", accept_default: "Default accepted", override_pending_second_approval: "Override waiting for a second approver", copied: "Copied",
          use_as_stated: "Used as stated", needs_second_approver: "Needs a second approver", client_confirm: "Confirmed by the client",
        };
        const verb = fr ? FR_ACT[action] ?? action : EN_ACT[action] ?? action.replace(/_/g, " ");
        const n = Number(p.to_value);
        const shown = p.to_value === null || p.to_value === undefined ? null : Number.isFinite(n) ? i.f.value(n, FIELD_BY_KEY.get(p.field)?.unit ?? "count") : String(p.to_value);
        const val = shown === null ? "" : ` = ${shown}`;
        return `${verb}${fr ? "\u00a0:" : ":"} ${field()}${val}${p.reason ? ` (${i.msg(p.reason)})` : ""}`;
      }
      return e.action;
  }
}

export type AuditCategory = "values" | "documents" | "runs" | "reports" | "sharing";
const CATEGORIES: readonly AuditCategory[] = ["values", "documents", "runs", "reports", "sharing"];

/** The chip an action belongs to; null means it shows only under Everything. */
export function categoryOf(action: string): AuditCategory | null {
  const [head] = action.split(".");
  if (head === "assumption" || head === "assumptions" || head === "figure" || head === "label") return "values";
  if (head === "document") return "documents";
  if (head === "run") return "runs";
  if (head === "decision" || head === "artifact" || head === "logo") return "reports";
  if (head === "share" || head === "invite" || head === "client" || head === "review" || head === "member") return "sharing";
  return null;
}

const PAGE = 50;
/** The API returns at most this many events a page, newest first; a shorter page reached the deal's first event. */
const SERVER_PAGE = 500;
const shortHash = (h: string) => `${h.slice(0, 4)} ${h.slice(4, 8)} ${h.slice(8, 12)}…`;

export function Audit({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f } = i;
  const { workspaceId } = useSession();
  const deal = useDeal(dealId);
  const [category, setCategory] = useState<AuditCategory | "all">("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // Pages of 500, newest first; each next page asks for the events older than the oldest one loaded.
  const events = useInfiniteQuery({
    queryKey: ["audit", dealId],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api.get<AuditEvent[]>(pageParam === null ? `/deals/${dealId}/audit` : `/deals/${dealId}/audit?before=${pageParam}`),
    getNextPageParam: (last) => (last.length >= SERVER_PAGE ? last[last.length - 1]!.seq : undefined),
  });
  // fn_verify_audit_chain walks every event in the installation, in order: ok, how many it read, and where it stopped.
  const verify = useQuery({
    queryKey: ["audit-verify", workspaceId],
    queryFn: () => api.get<{ ok: boolean; events: number; broken_at: number | null }>(`/workspaces/${workspaceId}/audit/verify`),
  });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const who = (e: AuditEvent) => e.actor ?? (e.action === "share.opened" ? t("audit.someone") : t("audit.worker"));
  const loaded = events.data?.pages.flat();
  const all = (loaded ?? []).map((e) => ({ e, text: describeEvent(i, e) }));
  const needle = q.trim().toLowerCase();
  const matching = all.filter(({ e, text }) => (category === "all" || categoryOf(e.action) === category)
    && (!needle || `${text} ${who(e)} ${e.hash}`.toLowerCase().includes(needle)));
  const shown = matching.slice(0, limit);
  const more = matching.length > shown.length || events.hasNextPage;
  // Show what is loaded first; past it, fetch the next older page and show it as it comes.
  const showOlder = () => {
    setLimit(limit + PAGE);
    return matching.length > shown.length ? undefined : events.fetchNextPage();
  };
  const filtered = category !== "all" || Boolean(needle);
  const v = verify.data;
  return (
    <>
      <DealFrame o={o} active="audit" />
      <div className="stack audit">
        <div className="page-head audit-head">
          <div>
            <h2 className="h1">{t("audit.title")}</h2>
            <p className="lead">{t("audit.lead")}</p>
            {v && <p className="small muted audit-checked">{t("audit.checked", { ok: v.ok, n: v.events, at: v.broken_at })}</p>}
            {verify.error && <p className="small muted audit-checked" role="alert">{t("audit.verifyFailed")}</p>}
          </div>
          <div className="row">
            {v ? <Tag tone={v.ok ? "pass" : "stop"}>{v.ok ? t("audit.intact", { n: v.events }) : t("audit.broken", { n: v.broken_at })}</Tag>
              : verify.isFetching ? <Tag>{t("audit.checking")}</Tag> : null}
            <button className="btn quiet" type="button" disabled={verify.isFetching} onClick={() => void verify.refetch()}>{t("audit.verifyAgain")}</button>
          </div>
        </div>

        <div className="row">
          <label className="search audit-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input className="input" type="search" value={q} placeholder={t("audit.searchHint")} aria-label={t("audit.searchLabel")} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
          </label>
          <div className="chips" role="group" aria-label={t("audit.chipsLabel")}>
            {(["all", ...CATEGORIES] as const).map((c) => (
              <button key={c} className={c === category ? "chip on" : "chip"} type="button" aria-pressed={c === category} onClick={() => { setCategory(c); setLimit(PAGE); }}>
                {t(`audit.cat.${c}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="card scroll">
          <table className="table">
            <thead><tr><th scope="col">{t("audit.col.event")}</th><th scope="col">{t("audit.col.who")}</th><th scope="col">{t("audit.col.when")}</th><th scope="col">{t("audit.col.hash")}</th></tr></thead>
            <tbody>
              {shown.map(({ e, text }) => (
                <tr key={e.seq}>
                  <td>{text}<span className="sub">{t("audit.seq", { n: e.seq })}</span></td>
                  <td>{who(e)}</td>
                  <td className="muted audit-when">{f.date(e.created_at)}</td>
                  <td className="hash" title={e.hash}>{shortHash(e.hash)}</td>
                </tr>
              ))}
              {shown.length === 0 && loaded && <tr><td colSpan={4} className="muted">{t(filtered ? "audit.noMatch" : "audit.empty")}</td></tr>}
            </tbody>
          </table>
          <div className="card-foot row between">
            <span className="small muted">
              {t("audit.shown", { n: shown.length, m: matching.length, filtered, more: events.hasNextPage })}
              {events.hasNextPage && ` ${t("audit.capped")}`}
            </span>
            <div className="row">
              {more && <button className="btn quiet sm" type="button" disabled={events.isFetchingNextPage} onClick={showOlder}>{t("audit.older")}</button>}
              {o.run && <a className="btn ghost sm" href={`/api/runs/${o.run.id}/audit-package`}>{t("audit.package")}</a>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
