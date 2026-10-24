import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, type DocumentRow } from "../api";
import { canEdit, DealHeader, ErrorText, useDeal, useSession } from "../components/ui";
import * as I from "../components/icons";
import { QuickStart } from "../components/QuickStart";
import { useI18n, type I18n } from "../i18n";

const ROLE_CHOICES = ["", "deal_source", "evidence", "context"] as const;
const ROLE_KEYS = { "": "docs.role.auto", deal_source: "docs.role.deal_source", evidence: "docs.role.evidence", context: "docs.role.context" } as const;

const SEGMENTS: Record<string, [string, string, string]> = {
  uploaded: ["#9c978a", "#ddd8cc", "#ddd8cc"],
  checking: ["#9c978a", "#ddd8cc", "#ddd8cc"],
  rejected: ["#c8401f", "#ddd8cc", "#ddd8cc"],
  reading: ["#15171c", "#9c978a", "#ddd8cc"],
  read_failed: ["#15171c", "#c8401f", "#ddd8cc"],
  extracting: ["#15171c", "#15171c", "#9c978a"],
  extracted: ["#15171c", "#15171c", "#15171c"],
};
function Result({ d, i }: { d: DocumentRow; i: I18n }) {
  const { t, msg } = i;
  if (d.stage === "rejected" || d.stage === "read_failed") {
    return <span className="row" style={{ gap: 6, color: "var(--stop-text)", fontWeight: 500 }}><I.Stop />{d.stage_detail ? msg(d.stage_detail) : t("docs.unusable")}</span>;
  }
  if (d.stage !== "extracted") {
    const key = `docs.stage.${d.stage}` as const;
    return <span className="row muted" style={{ gap: 6 }}><I.Spinner />{["uploaded", "checking", "reading", "extracting"].includes(d.stage) ? t(key as "docs.stage.reading") : d.stage}</span>;
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted">
        {d.candidate_count === 0 ? t("docs.noValues") : t("docs.values", { n: d.candidate_count })}
        {d.other_count > 0 && <span className="faint"> · {t("docs.other", { n: d.other_count })}</span>}
      </span>
      {d.number_format && d.number_format !== "1,234.56" && d.number_format !== "not detected" && (
        <span className="tag review" style={{ alignSelf: "flex-start" }}><I.Eye />{t("docs.format", { f: d.number_format })}</span>
      )}
    </div>
  );
}

export function Documents({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f } = i;
  const { role } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const docs = useQuery({
    queryKey: ["documents", dealId],
    queryFn: () => api.get<DocumentRow[]>(`/deals/${dealId}/documents`),
    refetchInterval: (q) => (q.state.data?.some((d) => !["extracted", "rejected", "read_failed"].includes(d.stage)) ? 1200 : false),
  });
  const input = useRef<HTMLInputElement>(null);
  const [uploadRole, setUploadRole] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["documents", dealId] }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const out: string[] = [];
      for (const f of files) {
        const r = await api.upload<{ id: string; duplicate: boolean }>(`/deals/${dealId}/documents?name=${encodeURIComponent(f.name)}${uploadRole ? `&role=${uploadRole}` : ""}`, f);
        if (r.duplicate) out.push(t("docs.duplicate", { name: f.name }));
      }
      return out;
    },
    onSuccess: (n) => {
      setNotes(n);
      void refresh();
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "retire" }) => api.post(`/documents/${id}/${action}`),
    onSuccess: () => refresh(),
  });
  const setRole = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => api.post(`/documents/${id}/role`, { role: value || null }),
    onSuccess: () => refresh(),
  });
  const roleOptions = ROLE_CHOICES.map(value => <option key={value} value={value}>{t(ROLE_KEYS[value])}</option>);
  const pick = (list: FileList | null) => list && list.length && upload.mutate([...list]);
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const editable = canEdit(role);
  return (
    <>
      <DealHeader o={deal.data} active="documents" />
      <div className="side">
        <div className="stack" style={{ gap: 20 }}>
          {editable && (
            <div
              className="panel spread"
              style={{ borderStyle: "dashed", borderColor: dragging ? "var(--ink)" : "var(--rule-strong)" }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files);
              }}
            >
              <div className="row" style={{ gap: 16 }}>
                <I.Upload size={28} />
                <div className="stack" style={{ gap: 2 }}>
                  <strong>{t("docs.drop")}</strong>
                  <span className="small faint">{t("docs.types")}</span>
                </div>
              </div>
              <label className="stack small" style={{ gap: 4 }}>
                {t("docs.role.question")}
                <select value={uploadRole} onChange={e => setUploadRole(e.target.value)}>{roleOptions}</select>
              </label>
              <label className="btn" htmlFor="doc-upload">{upload.isPending ? t("docs.uploading") : t("docs.choose")}</label>
              <input ref={input} id="doc-upload" type="file" multiple accept=".pdf,.xlsx,.csv,.docx,.txt" className="sr-only" onChange={(e) => pick(e.target.files)} />
            </div>
          )}
          {editable && docs.data?.length === 0 && <QuickStart dealId={dealId} />}
          <ErrorText error={upload.error ?? act.error ?? setRole.error} />
          {notes.map((n) => <p key={n} className="small muted">{n}</p>)}
          <table className="tbl">
            <thead><tr><th>{t("docs.col.doc")}</th><th style={{ width: 150 }}>{t("docs.col.stages")}</th><th>{t("docs.col.result")}</th><th className="r"><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
            <tbody>
              {(docs.data ?? []).map((d) => {
                const seg = SEGMENTS[d.stage] ?? SEGMENTS.uploaded!;
                const readRole = /\((deal source|evidence|context)(?:, set by a person)?\)$/.exec(d.read_role ?? "")?.[1];
                const usedRole = readRole === "deal source" ? "deal_source" : readRole === "evidence" || readRole === "context" ? readRole : null;
                const byPerson = d.read_role?.includes(", set by a person)");
                return (
                  <tr key={d.id}>
                    <td>
                      <div className="stack" style={{ gap: 2 }}>
                        <a href={`/api/documents/${d.id}/file`} className="row" style={{ gap: 8, textDecoration: "none" }}><I.Doc />{d.name}</a>
                        {usedRole && <span className="small muted">{t(byPerson ? "docs.role.you" : "docs.role.agir", { role: t(ROLE_KEYS[usedRole]) })}</span>}
                        {editable && <select aria-label={t("docs.role.change", { name: d.name })} value={d.role_set ?? ""} disabled={setRole.isPending} onChange={e => setRole.mutate({ id: d.id, value: e.target.value })}>{roleOptions}</select>}
                        <span className="small faint">{f.bytes(d.size_bytes)}{d.page_count ? ` · ${t("docs.pages", { n: d.page_count })}` : ""}{d.uploaded_by ? ` · ${d.uploaded_by}` : ""}</span>
                      </div>
                    </td>
                    <td>
                      <div role="img" aria-label={d.stage.replace(/_/g, " ")} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, width: 120, marginTop: 8 }}>
                        {seg.map((c, i) => <span key={i} style={{ height: 6, background: c, borderRadius: 1 }} />)}
                      </div>
                    </td>
                    <td><Result d={d} i={i} /></td>
                    <td className="r" style={{ whiteSpace: "nowrap" }}>
                      {editable && d.stage === "read_failed" && (
                        <button className="btn small" type="button" onClick={() => act.mutate({ id: d.id, action: "retry" })}><I.Retry />{t("docs.retry")}</button>
                      )}
                      {editable && (
                        <button
                          className="btn quiet small"
                          type="button"
                          onClick={() => {
                            if (confirm(t("docs.removeConfirm", { name: d.name }))) act.mutate({ id: d.id, action: "retire" });
                          }}
                        >
                          {t("docs.remove")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {docs.data?.length === 0 && <tr><td colSpan={4} className="muted">{t("docs.empty")}</td></tr>}
            </tbody>
          </table>
        </div>
        <aside className="stack" style={{ gap: 20 }} aria-label="About this step">
          <div className="stack" style={{ gap: 10 }}>
            <span className="label">{t("docs.what")}</span>
            <ol className="stack small muted" style={{ gap: 10, margin: 0, paddingLeft: 20 }}>
              <li><strong style={{ color: "var(--ink)" }}>{t("docs.what1")}</strong> {t("docs.what1b")}</li>
              <li><strong style={{ color: "var(--ink)" }}>{t("docs.what2")}</strong> {t("docs.what2b")}</li>
              <li><strong style={{ color: "var(--ink)" }}>{t("docs.what3")}</strong> {t("docs.what3b")}</li>
            </ol>
          </div>
          <div className="formula" style={{ fontFamily: "var(--sans)", fontSize: 14, lineHeight: 1.55 }}>
            {t("docs.candidates")}
          </div>
        </aside>
      </div>
    </>
  );
}
