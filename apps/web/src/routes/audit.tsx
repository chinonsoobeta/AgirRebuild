import { FIELD_BY_KEY } from "@agir/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AuditEvent } from "../api";
import { DealHeader, StatusTag, useDeal, useSession } from "../components/ui";
import { useI18n, type I18n } from "../i18n";

export function describeEvent(i: I18n, e: AuditEvent): string {
  const p = e.payload ?? {};
  const fr = i.lang === "fr";
  const kind = (k: string) => (k === "ic_memo" ? i.t("reports.memo") : k === "lender_package" ? i.t("reports.lender") : k === "build_decision" ? i.t("reports.buildDecision") : k === "partner_memo" ? i.t("reports.partnerMemo") : i.t("reports.modelExport"));
  const field = () => i.L.field(p.field, p.item || null);
  switch (e.action) {
    case "deal.created": return fr ? "A créé le projet" : "Created the deal";
    case "document.uploaded": return fr ? `A téléversé ${p.name}` : `Uploaded ${p.name}`;
    case "document.duplicate_ignored": return fr ? `A téléversé ${p.name} de nouveau ; la copie n'a pas été ajoutée` : `Uploaded ${p.name} again; the copy was not added`;
    case "document.verified": return fr ? "A vérifié un document : type, taille et empreinte" : "Checked a document: type, size and fingerprint";
    case "document.rejected": return fr ? `A refusé un document : ${i.msg(p.reason)}` : `Rejected a document: ${p.reason}`;
    case "document.extracted": return fr ? `A lu un document : ${p.candidates} valeurs trouvées` : `Read a document: ${p.candidates} values found`;
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
    case "run.completed": return fr ? `A lancé l'analyse ${p.run_number} : ${i.L.verdict(p.verdict).toLowerCase()}` : `Ran underwriting: run ${p.run_number}, ${String(p.verdict).replace(/_/g, " ").toLowerCase()}`;
    case "decision.recorded":
      return fr
        ? `A consigné la décision « ${i.L.decision(p.decision).toLowerCase()} » pour l'analyse ${p.run_number}${p.against_verdict ? ", contraire au verdict" : ""}`
        : `Recorded the decision "${String(p.decision).replace(/_/g, " ")}" on run ${p.run_number}${p.against_verdict ? ", against the verdict" : ""}`;
    case "artifact.requested": return fr ? `A demandé : ${kind(p.kind)} (${p.format})` : `Requested a ${String(p.kind).replace(/_/g, " ")} (${p.format})`;
    case "artifact.ready": return fr ? `A diffusé : ${kind(p.kind)} (${p.format})` : `Released a ${String(p.kind).replace(/_/g, " ")} (${p.format})`;
    case "artifact.blocked": return fr ? "A bloqué un rapport : chiffres sans source" : "Blocked a report: figures without a source";
    case "share.created": {
      const terms: Record<string, string> = fr ? { "24h": "24 heures", "7d": "7 jours", "30d": "30 jours", none: "Sans expiration" }
        : { "24h": "24 hours", "7d": "7 days", "30d": "30 days", none: "No expiry" };
      return fr ? `A partagé : ${kind(p.kind)} (${p.format}), ${terms[p.term] ?? ""}` : `Shared a ${kind(p.kind)} (${p.format}), ${terms[p.term] ?? ""}`;
    }
    case "share.revoked": return fr ? "A révoqué un lien partagé" : "Revoked a shared link";
    case "share.opened": {
      const what: Record<string, string> = fr ? { page: "la page", file: "le rapport", audit_package: "le dossier d'audit" }
        : { page: "the page", file: "the report", audit_package: "the audit package" };
      return fr ? `A ouvert un lien partagé : ${what[p.what] ?? what.page}` : `Opened a shared link: ${what[p.what] ?? what.page}`;
    }
    case "workspace.created": return fr ? "A créé l'espace de travail" : "Created the workspace";
    case "figure.labelled": return fr ? `A étiqueté un chiffre comme ${field()}` : `Labelled a figure as ${field()}`;
    case "figure.unlabelled": return fr ? "A retiré l'étiquette d'un chiffre" : "Removed a figure's label";
    case "deal.copied": return fr ? `A copié comme ${p.name}` : `Copied as ${p.name}`;
    case "deal.created_as_copy": return fr ? `A créé comme copie de ${p.name}` : `Created as a copy of ${p.name}`;
    case "workspace.review_mode_changed": {
      const mode = (m: string) => i.t(m === "team" ? "settings.mode.team" : "settings.mode.solo");
      return fr ? `A changé le mode d'examen : ${mode(p.from)} → ${mode(p.to)}` : `Changed the review mode: ${mode(p.from)} to ${mode(p.to)}`;
    }
    case "workspace.label_suggestions_changed": {
      const on = (b: boolean) => (fr ? (b ? "activées" : "désactivées") : b ? "on" : "off");
      return fr ? `A changé les suggestions de libellés : ${on(p.from)} → ${on(p.to)}` : `Changed label suggestions: ${on(p.from)} to ${on(p.to)}`;
    }
    case "review.granted":
      return fr ? `A donné accès à un réviseur${p.expires_at ? ` jusqu'au ${i.f.date(p.expires_at)}` : ""}` : `Gave a reviewer access${p.expires_at ? ` until ${i.f.date(p.expires_at)}` : ""}`;
    case "document.suggestions_failed":
      return fr ? "Les suggestions de libellés d'un modèle ont échoué pour un document ; les valeurs lues restent" : "A model's label suggestions failed for a document; the values read stand";
    case "member.added": return fr ? `A ajouté une personne (${i.L.role(p.role)})` : `Added a person (${p.role})`;
    default:
      if (e.action.startsWith("assumption.")) {
        const action = e.action.slice(11);
        const FR_ACT: Record<string, string> = {
          approve: "Approuvée", resolve: "Conflit résolu", modify: "Valeur modifiée", second_approve: "Confirmée par un second approbateur", reject: "Rejetée",
          reopen: "Rouverte", enter: "Valeur saisie", accept_default: "Valeur par défaut acceptée", override_pending_second_approval: "Dérogation en attente",
          copied: "Copiée", use_as_stated: "Utilisée telle qu'énoncée", needs_second_approver: "Second approbateur requis",
        };
        const EN_ACT: Record<string, string> = {
          enter: "Entered", approve: "Approved", resolve: "Resolved", modify: "Modified", second_approve: "Confirmed by a second approver", reject: "Rejected",
          reopen: "Reopened", accept_default: "Default accepted", override_pending_second_approval: "Override waiting for a second approver", copied: "Copied",
          use_as_stated: "Used as stated", needs_second_approver: "Needs a second approver",
        };
        const verb = fr ? FR_ACT[action] ?? action : EN_ACT[action] ?? action.replace(/_/g, " ");
        const n = Number(p.to_value);
        const shown = p.to_value === null || p.to_value === undefined ? null : Number.isFinite(n) ? i.f.value(n, FIELD_BY_KEY.get(p.field)?.unit ?? "count") : String(p.to_value);
        const val = shown === null ? "" : ` = ${shown}`;
        return `${verb}${fr ? " :" : ":"} ${field()}${val}${p.reason ? ` (${i.msg(p.reason)})` : ""}`;
      }
      return e.action;
  }
}

export function Audit({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f } = i;
  const { workspaceId } = useSession();
  const deal = useDeal(dealId);
  const events = useQuery({ queryKey: ["audit", dealId], queryFn: () => api.get<AuditEvent[]>(`/deals/${dealId}/audit`) });
  const verify = useMutation({ mutationFn: () => api.get<{ ok: boolean; events: number; broken_at: number | null }>(`/workspaces/${workspaceId}/audit/verify`) });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  return (
    <>
      <DealHeader o={deal.data} active="audit" />
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="h-section">{t("audit.title")}</h2>
          <p className="small muted">{t("audit.body")}</p>
        </div>
        <div className="row">
          {verify.data && (verify.data.ok ? <StatusTag tone="pass">{t("audit.intact", { n: verify.data.events })}</StatusTag> : <StatusTag tone="stop">{t("audit.broken", { n: verify.data.broken_at })}</StatusTag>)}
          <button className="btn small" type="button" onClick={() => verify.mutate()}>{t("audit.verify")}</button>
        </div>
      </div>
      <table className="tbl">
        <thead><tr><th style={{ width: 70 }}>#</th><th>{t("audit.col.event")}</th><th>{t("audit.col.who")}</th><th>{t("audit.col.when")}</th><th>{t("audit.col.hash")}</th></tr></thead>
        <tbody>
          {(events.data ?? []).map((e) => (
            <tr key={e.seq}>
              <td className="num faint">{e.seq}</td>
              <td>{describeEvent(i, e)}</td>
              <td className="small muted">{e.actor ?? t("audit.worker")}</td>
              <td className="small muted">{f.date(e.created_at)}</td>
              <td className="num small faint">{e.hash.slice(0, 12)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
