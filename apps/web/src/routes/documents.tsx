import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, type DocumentRow } from "../api";
import { canEdit, DealFrame, ErrorText, useDeal, useSession } from "../components/ui";
import { ChoiceCards, Notice, Tag } from "../components/kit";
import * as I from "../components/icons";
import { QuickStart } from "../components/QuickStart";
import { useI18n, type I18n } from "../i18n";
import "../strings/documents";

const ROLE_CHOICES = ["", "deal_source", "evidence", "context"] as const;
const ROLE_KEYS = { "": "docs.role.auto", deal_source: "docs.role.deal_source", evidence: "docs.role.evidence", context: "docs.role.context" } as const;
const ROLE_DESCRIPTIONS = { "": "documents.role.autoD", deal_source: "documents.role.deal_sourceD", evidence: "documents.role.evidenceD", context: "documents.role.contextD" } as const;

type Dot = "done" | "on" | "fail" | "";
/** The three stage dots (Checked · Read · Values) for each stage the worker sets. */
const DOTS: Record<string, [Dot, Dot, Dot]> = {
  uploaded: ["on", "", ""],
  checking: ["on", "", ""],
  rejected: ["fail", "", ""],
  reading: ["done", "on", ""],
  read_failed: ["done", "fail", ""],
  extracting: ["done", "done", "on"],
  extracted: ["done", "done", "done"],
};
const STAGE_KEYS: Record<string, string> = {
  uploaded: "docs.stage.uploaded", checking: "docs.stage.checking", reading: "docs.stage.reading", extracting: "docs.stage.extracting",
  rejected: "documents.stage.rejected", read_failed: "documents.stage.read_failed", extracted: "documents.stage.extracted",
};
const FAILED = ["rejected", "read_failed"];
const DONE = ["extracted", ...FAILED];

function Stages({ d, i }: { d: DocumentRow; i: I18n }) {
  const dots = DOTS[d.stage] ?? DOTS.uploaded!;
  const key = STAGE_KEYS[d.stage];
  return (
    <span className="stages" role="img" aria-label={key ? i.t(key as "docs.stage.reading") : d.stage}>
      {dots.map((c, n) => (
        <span key={n} className={c ? `st ${c}` : "st"} aria-hidden="true">
          {c === "done" && <I.Check size={10} />}
          {c === "fail" && <I.Cross size={10} />}
        </span>
      ))}
    </span>
  );
}

/** A sentence ends with a full stop, so a reason never trails off (QA #18: "does not start like a PDF —"). */
const sentence = (x: string) => (/[.!?…]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`);

function Result({ d, i, dealId }: { d: DocumentRow; i: I18n; dealId: string }) {
  const { t, msg } = i;
  if (FAILED.includes(d.stage)) {
    return (
      <span className="docs-fail">{t("docs.unusable")}
        {d.stage_detail && <span className="sub">{sentence(msg(d.stage_detail))}</span>}
        <span className="sub">{t(d.stage === "rejected" ? "documents.rejectedHint" : "documents.readFailedHint")}</span>
      </span>
    );
  }
  if (d.stage !== "extracted") {
    const key = STAGE_KEYS[d.stage];
    return <Tag tone="plain"><I.Spinner />{key ? t(key as "docs.stage.reading") : d.stage}</Tag>;
  }
  return (
    <>
      {/* QA run 2 (skeptic N2): one number, honestly named: the values in use from this file, or before that what the rules found. */}
      {d.used_count > 0 ? t("docs.used", { n: d.used_count }) : d.candidate_count > 0 ? t("docs.byRules", { n: d.candidate_count }) : t("docs.noValues")}
      {d.other_count > 0 && <span className="sub">{t("docs.other", { n: d.other_count })} (<Link to="/deals/$dealId/review" params={{ dealId }} hash="unused-figures">{t("documents.otherShow")}</Link>)</span>}
      {d.number_format && d.number_format !== "1,234.56" && d.number_format !== "not detected" && (
        <span className="sub docs-warn"><I.Eye />{t("docs.format", { f: d.number_format })}</span>
      )}
      {d.stage_detail ? <span className="sub docs-warn"><I.Eye />{msg(d.stage_detail)}</span>
        : d.needs_ocr && <span className="sub docs-warn"><I.Eye />{t("documents.ocr")}</span>}
    </>
  );
}

export function Documents({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f } = i;
  const { role, me } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const docs = useQuery({
    queryKey: ["documents", dealId],
    queryFn: () => api.get<DocumentRow[]>(`/deals/${dealId}/documents`),
    refetchInterval: (q) => (q.state.data?.some((d) => !DONE.includes(d.stage)) ? 1200 : false),
  });
  const input = useRef<HTMLInputElement>(null);
  const [uploadRole, setUploadRole] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [changing, setChanging] = useState<string | null>(null);
  // The files added in this visit: the banner speaks once they are read, and a phone scrolls to the first new row.
  const [added, setAdded] = useState<string[]>([]);
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    try { setTouch(window.matchMedia("(pointer: coarse)").matches); } catch { /* no matchMedia: keep the desktop words */ }
  }, []);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["documents", dealId] }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const out: string[] = [];
      const ids: string[] = [];
      for (const f of files) {
        const r = await api.upload<{ id: string; duplicate: boolean }>(`/deals/${dealId}/documents?name=${encodeURIComponent(f.name)}${uploadRole ? `&role=${uploadRole}` : ""}`, f);
        if (r.duplicate) out.push(t("docs.duplicate", { name: f.name }));
        else ids.push(r.id);
      }
      return { notes: out, ids };
    },
    onSuccess: async ({ notes: n, ids }) => {
      setNotes(n);
      await refresh();
      setAdded(ids);
      // On a phone the list is far below the upload box: bring the first new row into view so its progress is seen.
      try {
        if (ids[0] && window.matchMedia("(max-width: 600px)").matches) document.getElementById(`doc-${ids[0]}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch { /* no matchMedia */ }
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
  // Card C: which way the owner set AI reading for the deal's workspace.
  const aiReading = me.workspaces.find((w) => w.id === deal.data!.deal.workspace_id)?.ai_reading;
  const list = docs.data ?? [];
  // A deal whose only files failed still has nothing to read from, so the quick start stays (QA #18).
  const empty = docs.data !== undefined && list.every((d) => FAILED.includes(d.stage));
  const o = deal.data;
  const reading = list.some((d) => !DONE.includes(d.stage)) || o.documents.processing > 0 || Boolean(o.updating) || upload.isPending;
  const readCount = list.filter((d) => d.stage === "extracted").length;
  const failedCount = list.filter((d) => FAILED.includes(d.stage)).length;
  // The count Review shows: the values waiting for a person there, from the same overview the stepper reads.
  const toReview = (o.review?.needsReview ?? 0) + (o.review?.conflicting ?? 0);
  const addedNow = added.length > 0;
  const counts = [
    ["documents.count.read", list.filter((d) => d.stage === "extracted").length],
    ["documents.count.processing", list.filter((d) => !DONE.includes(d.stage)).length],
    ["documents.count.failed", list.filter((d) => FAILED.includes(d.stage)).length],
  ] as const;
  return (
    <>
      <DealFrame o={deal.data} active="documents" />
      <div className="stack">
        {addedNow && (reading ? (
          <Notice title={t("documents.banner.reading", { n: list.filter((d) => !DONE.includes(d.stage)).length || added.length })} role="status" />
        ) : readCount > 0 ? (
          <Notice tone="pass" role="status" title={t("documents.banner.done", { files: readCount, n: toReview })}>
            {failedCount > 0 && <p className="small">{t("documents.banner.failed", { n: failedCount })}</p>}
            <Link className="btn primary sm" to="/deals/$dealId/review" params={{ dealId }}>{toReview > 0 ? t("documents.banner.go", { n: toReview }) : t("documents.banner.goNone")}</Link>
          </Notice>
        ) : failedCount > 0 ? (
          <Notice tone="stop" role="status" title={t("documents.banner.allFailed", { n: failedCount })} />
        ) : null)}
        {editable && (
          <div className="docs-top">
            <div
              className={dragging ? "drop dragging" : "drop"}
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
              <I.Upload size={28} />
              <p className="docs-drop">{t(touch ? "documents.dropTouch" : "docs.drop")}</p>
              <p className="small muted">{t("docs.types")}</p>
              <div className="row docs-drop-actions">
                <button className="btn primary" type="button" disabled={upload.isPending} onClick={() => input.current?.click()}>{upload.isPending ? t("docs.uploading") : t("docs.choose")}</button>
                {empty && <a className="btn ghost" href="#quick-start">{t("documents.quickStart")}</a>}
              </div>
              {(upload.isPending || (addedNow && reading)) && (
                <p className="small docs-inline" role="status"><I.Spinner />{upload.isPending ? t("docs.uploading") : t("documents.inline.reading")}</p>
              )}
              <input ref={input} id="doc-upload" type="file" multiple accept=".pdf,.xlsx,.csv,.docx,.txt" className="sr-only" tabIndex={-1} aria-label={t("docs.choose")} onChange={(e) => pick(e.target.files)} />
            </div>
            <div className="card card-pad">
              <ChoiceCards
                name="upload-role"
                legend={t("docs.role.question")}
                value={uploadRole}
                onChange={setUploadRole}
                options={ROLE_CHOICES.map((value) => ({ value, title: t(ROLE_KEYS[value]), description: t(ROLE_DESCRIPTIONS[value]) }))}
              />
            </div>
          </div>
        )}
        {editable && aiReading !== undefined && <p className="small muted">{t(aiReading ? "documents.ai.on" : "documents.ai.off")}</p>}
        <ErrorText error={upload.error ?? act.error ?? setRole.error} />
        {notes.map((n) => <p key={n} className="small muted docs-note">{n}</p>)}

        <div className="card">
          <div className="card-head">
            <h2 className="h2">{t("documents.title")}</h2>
            {list.length > 0 && <span className="small muted">{counts.filter(([, n]) => n > 0).map(([k, n]) => t(k, { n })).join(" · ")}</span>}
          </div>
          <div className="scroll docs-list">
            <table className="table">
              <thead><tr><th>{t("docs.col.doc")}</th><th>{t("docs.col.stages")}</th><th>{t("docs.col.result")}</th><th>{t("documents.col.role")}</th><th className="r"><span className="sr-only">{t("docs.actions")}</span></th></tr></thead>
              <tbody>
                {list.map((d) => {
                  const readRole = /\((deal source|evidence|context)(?:, set by a person)?\)$/.exec(d.read_role ?? "")?.[1];
                  const usedRole = readRole === "deal source" ? "deal_source" : readRole === "evidence" || readRole === "context" ? readRole : null;
                  const byPerson = d.read_role?.includes(", set by a person)");
                  const open = changing === d.id;
                  return (
                    <tr key={d.id} id={`doc-${d.id}`}>
                      <td>
                        <a href={`/api/documents/${d.id}/file`}>{d.name}</a>
                        <span className="sub">
                          {d.page_count ? `${t("docs.pages", { n: d.page_count })} · ` : ""}{f.bytes(d.size_bytes)} · {t("documents.added", { date: f.date(d.created_at), name: d.uploaded_by })}
                        </span>
                      </td>
                      <td data-label={t("docs.col.stages")}><Stages d={d} i={i} /></td>
                      <td data-label={t("docs.col.result")}><Result d={d} i={i} dealId={dealId} /></td>
                      <td data-label={t("documents.col.role")}>
                        {usedRole ? t(byPerson ? "docs.role.you" : "docs.role.agir", { role: t(ROLE_KEYS[usedRole]) })
                          : d.role_set ? t("docs.role.you", { role: t(ROLE_KEYS[d.role_set]) })
                          : <><span aria-hidden="true" className="muted">—</span><span className="sr-only">{t("documents.noRole")}</span></>}
                        {editable && (
                          <span className="sub">
                            <button type="button" className="docs-link" aria-expanded={open} aria-label={t("docs.role.change", { name: d.name })} onClick={() => setChanging(open ? null : d.id)}>{t("documents.change")}</button>
                          </span>
                        )}
                        {editable && open && (
                          <select className="docs-role" aria-label={t("docs.role.change", { name: d.name })} value={d.role_set ?? ""} disabled={setRole.isPending} onChange={e => { setRole.mutate({ id: d.id, value: e.target.value }); setChanging(null); }}>{roleOptions}</select>
                        )}
                      </td>
                      <td>
                        {editable && (
                          <div className="acts">
                            {d.stage === "read_failed" && (
                              <button className="btn quiet sm" type="button" onClick={() => act.mutate({ id: d.id, action: "retry" })}>{t("docs.retry")}</button>
                            )}
                            <button
                              className="btn ghost sm"
                              type="button"
                              onClick={() => {
                                if (confirm(t("docs.removeConfirm", { name: d.name }))) act.mutate({ id: d.id, action: "retire" });
                              }}
                            >
                              {t("docs.remove")}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {list.length === 0 && docs.data && <tr><td colSpan={5} className="muted">{t("docs.empty")}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot small muted">
            {t("docs.candidates")} <Link to="/deals/$dealId/review" params={{ dealId }}>{t("documents.toReview")}</Link>
          </div>
        </div>

        {editable && empty && <div id="quick-start"><QuickStart dealId={dealId} /></div>}

        <section className="section" aria-labelledby="docs-what">
          <h2 className="h2" id="docs-what">{t("docs.what")}</h2>
          <div className="grid3">
            <div className="card card-pad"><h3 className="h3">{t("documents.step.checked")}</h3><p className="muted docs-what">{t("docs.what1b")}</p></div>
            <div className="card card-pad"><h3 className="h3">{t("documents.step.read")}</h3><p className="muted docs-what">{t("docs.what2b")}</p></div>
            <div className="card card-pad"><h3 className="h3">{t("documents.step.values")}</h3><p className="muted docs-what">{t("docs.what3b")}</p></div>
          </div>
        </section>
      </div>
    </>
  );
}
