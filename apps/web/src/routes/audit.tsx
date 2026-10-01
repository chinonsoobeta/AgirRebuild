import { FIELD_BY_KEY } from "@agir/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type AuditEvent } from "../api";
import { DealHeader, StatusTag, useDeal, useSession } from "../components/ui";
import { useI18n, type I18n } from "../i18n";

function describe(i: I18n, e: AuditEvent): string {
  const p = e.payload ?? {};
  const fr = i.lang === "fr";
  const kind = (k: string) => (k === "ic_memo" ? i.t("reports.memo") : k === "lender_package" ? i.t("reports.lender") : i.t("reports.modelExport"));
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
    case "assumptions.reconciled": return fr ? "A mis à jour la file d'examen à partir des documents" : "Updated the review queue from the documents";
    case "run.completed": return fr ? `A lancé l'analyse ${p.run_number} : ${i.L.verdict(p.verdict).toLowerCase()}` : `Ran underwriting: run ${p.run_number}, ${String(p.verdict).replace(/_/g, " ").toLowerCase()}`;
    case "decision.recorded":
      return fr
        ? `A consigné la décision « ${i.L.decision(p.decision).toLowerCase()} » pour l'analyse ${p.run_number}${p.against_verdict ? ", contraire au verdict" : ""}`
        : `Recorded the decision "${String(p.decision).replace(/_/g, " ")}" on run ${p.run_number}${p.against_verdict ? ", against the verdict" : ""}`;
    case "artifact.requested": return fr ? `A demandé : ${kind(p.kind)} (${p.format})` : `Requested a ${String(p.kind).replace(/_/g, " ")} (${p.format})`;
    case "artifact.ready": return fr ? `A diffusé : ${kind(p.kind)} (${p.format})` : `Released a ${String(p.kind).replace(/_/g, " ")} (${p.format})`;
    case "artifact.blocked": return fr ? "A bloqué un rapport : chiffres sans source" : "Blocked a report: figures without a source";
    case "workspace.created": return fr ? "A créé l'espace de travail" : "Created the workspace";
    case "member.added": return fr ? `A ajouté une personne (${i.L.role(p.role)})` : `Added a person (${p.role})`;
    default:
      if (e.action.startsWith("assumption.")) {
        const action = e.action.slice(11);
        const FR_ACT: Record<string, string> = {
          approve: "Approuvée", resolve: "Conflit résolu", modify: "Valeur modifiée", second_approve: "Confirmée par un second approbateur", reject: "Rejetée",
          reopen: "Rouverte", enter: "Valeur saisie", accept_default: "Valeur par défaut acceptée", override_pending_second_approval: "Dérogation en attente",
        };
        const verb = fr ? FR_ACT[action] ?? action : action.replace(/_/g, " ");
        const n = Number(p.to_value);
        const shown = p.to_value === null || p.to_value === undefined ? null : Number.isFinite(n) ? i.f.value(n, FIELD_BY_KEY.get(p.field)?.unit ?? "count") : String(p.to_value);
        const val = shown === null ? "" : ` = ${shown}`;
        return `${verb} : ${field()}${val}${p.reason ? ` (${i.msg(p.reason)})` : ""}`;
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
              <td>{describe(i, e)}</td>
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
