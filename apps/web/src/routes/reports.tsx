import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, type Artifact, type ShareLink, type ShareTerm } from "../api";
import { Banner, canEdit, DealFrame, ErrorText, StatusTag, useDeal, useSession } from "../components/ui";
import { Seg, Tag } from "../components/kit";
import * as I from "../components/icons";
import { useRun } from "./run";
import { useI18n } from "../i18n";

const KINDS = [
  { kind: "ic_memo", formats: ["pdf", "docx"] },
  { kind: "lender_package", formats: ["pdf", "docx"] },
  { kind: "build_decision", formats: ["pdf", "docx"] },
  { kind: "partner_memo", formats: ["pdf", "docx"] },
  { kind: "model_export", formats: ["xlsx"] },
] as const;
const TERMS: ShareTerm[] = ["24h", "7d", "30d", "none"];
const newest = (a: Artifact, b: Artifact) => (a.created_at < b.created_at ? 1 : -1);
/** The order the shared page lists files in (card R2): by report, then PDF before Word, then English before French. */
const SHARE_KINDS = ["build_decision", "lender_package", "partner_memo", "ic_memo", "model_export"];
const SHARE_FORMATS = ["pdf", "docx", "xlsx"];
const shareOrder = (a: Artifact, b: Artifact) => SHARE_KINDS.indexOf(a.kind) - SHARE_KINDS.indexOf(b.kind)
  || SHARE_FORMATS.indexOf(a.format) - SHARE_FORMATS.indexOf(b.format) || Number(a.lang === "fr") - Number(b.lang === "fr") || newest(a, b);

export function Reports({ dealId }: { dealId: string }) {
  const { t, f, lang } = useI18n();
  const { role } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const run = useRun(deal.data?.run?.id);
  const lp = run.data?.result.scenarios.find((s) => s.key === "base")?.metrics.find((m) => m.key === "lp_irr");
  // A held run with a split has a partner memo too (card 87); its partner returns are unrealized.
  const heldSplit = Boolean(run.data?.result.scenarios.find((s) => s.key === "base")?.metrics.some((m) => m.key === "unrealized_equity_irr")
    && run.data?.inputs?.some((i) => i.fieldKey === "lp_share_pct"));
  const partnerMemo = heldSplit || Boolean(lp && lp.status !== "NOT_APPLICABLE");
  const arts = useQuery({
    queryKey: ["artifacts", dealId],
    queryFn: () => api.get<Artifact[]>(`/deals/${dealId}/artifacts`),
    refetchInterval: (q) => (q.state.data?.some((a) => a.status === "queued") ? 1200 : false),
  });
  const links = useQuery({ queryKey: ["share-links", dealId], queryFn: () => api.get<ShareLink[]>(`/deals/${dealId}/share-links`) });
  // Sharing is open to every staff role (card 86): a link is read-only and shows no more than its maker can see.
  // A client (card 89) may not share. A link shares the ticked files of the current run (card R2); every one starts ticked.
  const [unticked, setUnticked] = useState<string[]>([]);
  const toPicker = () => {
    if (typeof document === "undefined") return;
    document.getElementById("rep-share")?.scrollIntoView({ block: "start" });
    document.getElementById("rep-share-pick")?.focus();
  };
  const [term, setTerm] = useState<ShareTerm>("7d");
  const [made, setMade] = useState<string | null>(null);
  const share = useMutation({
    mutationFn: (b: { run: string; artifacts: string[]; term: ShareTerm }) =>
      api.post<{ id: string; url: string; expiresAt: string | null }>(`/runs/${b.run}/share-links`, { term: b.term, artifacts: b.artifacts }),
    onSuccess: (r) => { setMade(window.location.origin + r.url); return qc.invalidateQueries({ queryKey: ["share-links", dealId] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/share-links/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["share-links", dealId] }),
  });
  const make = useMutation({
    mutationFn: (b: { kind: string; format: string; lang?: "en" | "fr" }) =>
      api.post(`/runs/${deal.data!.run!.id}/artifacts`, { kind: b.kind, format: b.format, lang: b.kind === "model_export" ? "en" : b.lang ?? lang }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["artifacts", dealId] }), qc.invalidateQueries({ queryKey: ["deal", dealId] })]),
  });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const all = arts.data ?? [];
  const kind = (k: string) => t(KINDS.find((x) => x.kind === k) ? `reports.k.${k as (typeof KINDS)[number]["kind"]}` : "reports.k.model_export");
  const fmtName = (x: string) => (x === "pdf" ? "PDF" : x === "docx" ? t("reports.word") : t("reports.excel"));
  const langName = (a: Pick<Artifact, "lang" | "kind">) => (a.lang === "fr" ? t("reports.frDraft") : t("reports.english"));
  /** A file from an older run, or from a current run whose inputs have since changed. */
  const outOfDate = (a: Artifact) => !o.run || a.run_id !== o.run.id || !o.run.fresh;
  const linkRows = links.data ?? [];
  const staff = role !== "client";
  // The ready files of the current run can be shared, in the shared page's order.
  const shareable = o.run ? all.filter((a) => a.status === "ready" && a.run_id === o.run!.id).sort(shareOrder) : [];
  const chosen = shareable.filter((a) => !unticked.includes(a.id)).map((a) => a.id);
  const tick = (id: string, on: boolean) => { setUnticked(on ? unticked.filter((x) => x !== id) : [...unticked, id]); setMade(null); share.reset(); };
  // A file in the screen's language is named plainly; one in the other language says which.
  const linkFile = (x: { kind: string; format: string; lang: string }) =>
    t(x.lang === lang ? "reports.linkFile" : x.lang === "fr" ? "reports.linkFileFr" : "reports.linkFileEn", { what: kind(x.kind), f: fmtName(x.format) });
  /** The language a card does not make by default: French on an English screen, English on a French one. */
  const otherLang = lang === "fr" ? "en" : "fr";
  const otherName = otherLang === "fr" ? t("reports.frDraft") : t("reports.englishVersion");

  const kindCard = (k: (typeof KINDS)[number]) => {
    const r = o.run!;
    const want = k.kind === "model_export" ? "en" : lang;
    const ofRun = all.filter((a) => a.kind === k.kind && a.run_id === r.id).sort(newest);
    const mine = ofRun.filter((a) => a.lang === want);
    const of = (fmt: string) => mine.find((a) => a.format === fmt);
    const ready = mine.filter((a) => a.status === "ready");
    const tag = ready.length ? <Tag tone="pass">{t("reports.ready")}</Tag>
      : mine.some((a) => a.status === "queued") ? <Tag>{t("reports.rendering")}</Tag>
      : <Tag tone="plain">{t("reports.notMade")}</Tag>;
    const traced = ready.find((a) => a.provenance_entries)?.provenance_entries;
    // The languages this run has a ready file in; before any, the language the main action makes.
    const made = (["en", "fr"] as const).filter((l) => ofRun.some((a) => a.lang === l && a.status === "ready"));
    const langs = k.kind === "model_export" ? t("reports.englishOnly")
      : (made.length ? made : [want]).map((l) => (l === "fr" ? t("reports.frDraft") : t("reports.english"))).join(" · ");
    const facts = [k.formats.map(fmtName).join(" · "), langs, traced ? t("reports.tracedN", { n: traced }) : t("reports.fromRun", { n: r.number })];
    const other = (fmt: string) => ofRun.find((a) => a.lang === otherLang && a.format === fmt);
    return (
      <div key={k.kind} className="card card-pad stack tight">
        <div className="rep-head"><h3 className="h3">{kind(k.kind)}</h3>{tag}</div>
        <p className="muted">{t(`reports.kd.${k.kind}`)}</p>
        <p className="small muted">{facts.join(" · ")}</p>
        <div className="row rep-acts">
          {k.formats.map((fmt) => {
            const a = of(fmt);
            // A ready file can be made again from the same run, for example after the workspace logo changes.
            if (a?.status === "ready") return (
              <Fragment key={fmt}>
                <a className="btn quiet sm" href={`/api/artifacts/${a.id}/file`}><I.Download />{t("reports.downloadFmt", { f: fmtName(fmt) })}</a>
                {canEdit(role) && (
                  <button name="regenerate" value={`${k.kind}:${fmt}`} className="btn ghost sm" type="button" disabled={make.isPending}
                    aria-label={t("reports.makeAgainFmt", { f: fmtName(fmt) })} onClick={() => make.mutate({ kind: k.kind, format: fmt })}>{t("reports.makeAgain")}</button>
                )}
              </Fragment>
            );
            if (a?.status === "queued") return null;
            return (
              <button key={fmt} name="generate" value={`${k.kind}:${fmt}`} className="btn primary sm" type="button" disabled={!canEdit(role) || make.isPending}
                onClick={() => make.mutate({ kind: k.kind, format: fmt })}>{t("reports.generateFmt", { f: fmtName(fmt), n: r.number })}</button>
            );
          })}
        </div>
        {k.kind !== "model_export" && (
          // The other language, quieter: the model export is English only (the API refuses French).
          <div className="row rep-acts rep-other">
            {k.formats.map((fmt) => {
              const a = other(fmt);
              const what = t("reports.otherFmt", { l: otherName, f: fmtName(fmt) });
              if (a?.status === "ready") return (
                <Fragment key={fmt}>
                  <a className="btn ghost sm" href={`/api/artifacts/${a.id}/file`}><I.Download />{what}</a>
                  {canEdit(role) && (
                    <button name="regenerate-other" value={`${k.kind}:${fmt}:${otherLang}`} className="btn ghost sm" type="button" disabled={make.isPending}
                      aria-label={t("reports.makeAgainOther", { l: otherName, f: fmtName(fmt) })} onClick={() => make.mutate({ kind: k.kind, format: fmt, lang: otherLang })}>{t("reports.makeAgain")}</button>
                  )}
                </Fragment>
              );
              if (a?.status === "queued") return <span key={fmt} className="small muted">{what} · {t("reports.rendering")}</span>;
              return (
                <button key={fmt} name="generate-other" value={`${k.kind}:${fmt}:${otherLang}`} className="btn ghost sm" type="button" disabled={!canEdit(role) || make.isPending}
                  onClick={() => make.mutate({ kind: k.kind, format: fmt, lang: otherLang })}>{what}</button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <DealFrame o={o} active="reports" />
      <div className="stack">
        <div className="page-head rep-page-head">
          <div>
            <h2 className="h1">{t("reports.title")}</h2>
            {o.run && <p className="lead rep-lead">{t("reports.lead", { n: o.run.number })}</p>}
          </div>
          {o.run && staff && <button className="btn primary" type="button" onClick={toPicker}>{t("reports.shareTop")}</button>}
        </div>
        {!o.run ? (
          <Banner tone="neutral" title={t("reports.needRun")}>{t("reports.needRunBody")}</Banner>
        ) : (
          <>
            {!o.run.fresh && <Banner tone="review" title={t("reports.stale", { n: o.run.number })}>{t("reports.staleBody")}</Banner>}
            <div className="grid3">
              {KINDS.filter((k) => k.kind !== "partner_memo" || partnerMemo).map(kindCard)}
              <div className="card card-pad stack tight">
                <div className="rep-head"><h3 className="h3">{t("reports.package")}</h3><Tag tone="pass">{t("reports.always")}</Tag></div>
                <p className="muted">{t("reports.kd.audit")}</p>
                <p className="small muted">{t("reports.builtOnRequest")}</p>
                <div className="row rep-acts"><a className="btn quiet sm" href={`/api/runs/${o.run.id}/audit-package`}><I.Download />{t("common.download")}</a></div>
              </div>
            </div>
            <ErrorText error={make.error} />
          </>
        )}

        <section className="section">
          <h2 className="h2">{t("reports.madeSoFar")}</h2>
          <div className="card scroll">
            <table className="table">
              <thead><tr><th>{t("reports.col.report")}</th><th>{t("step.run")}</th><th>{t("reports.col.status")}</th><th>{t("reports.col.made")}</th><th className="r"><span className="sr-only">{t("common.download")}</span></th></tr></thead>
              <tbody>
                {all.map((a) => (
                  <tr key={a.id}>
                    <td>{kind(a.kind)}<span className="sub">{fmtName(a.format)} · {langName(a)}</span></td>
                    <td className="num">{t("common.run", { n: a.run_number })}</td>
                    <td>
                      {a.status === "ready" && (outOfDate(a)
                        ? <><StatusTag tone="review">{t("reports.outOfDate")}</StatusTag> <span className="small muted">· {t("reports.outOfDateNote", { n: a.run_number })}</span></>
                        : <><StatusTag tone="pass">{t("reports.ready")}</StatusTag>{a.provenance_entries ? <span className="small muted"> · {t("reports.tracedN", { n: a.provenance_entries })}</span> : null}</>)}
                      {a.status === "queued" && <StatusTag tone="neutral">{t("reports.rendering")}</StatusTag>}
                      {(a.status === "blocked" || a.status === "failed") && (
                        <div className="stack tight rep-err"><StatusTag tone="stop">{a.status === "blocked" ? t("reports.blocked") : t("reports.failed")}</StatusTag><span className="small muted">{a.error}</span></div>
                      )}
                    </td>
                    <td className="small muted">{f.date(a.created_at)}</td>
                    <td>
                      <div className="acts">
                        {a.status === "ready" && <a className="btn quiet sm" href={`/api/artifacts/${a.id}/file`}><I.Download />{t("common.download")}</a>}
                        {a.status === "ready" && a.format === "pdf" && <a className="btn ghost sm" href={`/api/artifacts/${a.id}/file?inline=1`} target="_blank" rel="noreferrer">{t("common.open")}</a>}
                      </div>
                    </td>
                  </tr>
                ))}
                {arts.data?.length === 0 && <tr><td colSpan={5} className="muted">{t("reports.none")}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {staff && (o.run || linkRows.length > 0) && (
          <section className="section" id="rep-share">
            <div><h2 className="h2">{t("share.title")}</h2><p className="muted rep-share-lead">{t("reports.shareLead")}</p></div>
            <div className="card">
              <div className="card-pad stack tight">
                {shareable.length === 0 || !o.run ? <p className="muted">{t("reports.shareNeedsFile")}</p> : (
                  <>
                    <fieldset className="rep-pick">
                      <legend className="label">{t("reports.shareWhat")}</legend>
                      {shareable.map((a, n) => (
                        <label key={a.id} className="check">
                          <input type="checkbox" id={n === 0 ? "rep-share-pick" : undefined} value={a.id} checked={!unticked.includes(a.id)}
                            onChange={(e) => tick(a.id, e.target.checked)} />
                          <span>{[kind(a.kind), fmtName(a.format), langName(a)].join(" · ")}</span>
                        </label>
                      ))}
                    </fieldset>
                    <span className="label" aria-hidden="true">{t("reports.term")}</span>
                    <div className="row">
                      <Seg label={t("reports.term")} value={term} onChange={setTerm} options={TERMS.map((x) => ({ value: x, label: t(`share.term.${x}`) }))} />
                      <button className="btn primary" type="button" disabled={share.isPending || chosen.length === 0}
                        onClick={() => share.mutate({ run: o.run!.id, artifacts: chosen, term })}>{t("share.make")}</button>
                    </div>
                    {made ? (
                      <>
                        <div className="row">
                          <input className="input rep-secret" aria-label={t("share.link")} readOnly value={made} />
                          <button className="btn quiet" type="button" onClick={() => navigator.clipboard.writeText(made)}>{t("share.copy")}</button>
                        </div>
                        <p className="small muted">{t("share.once")}</p>
                      </>
                    ) : <p className="small muted">{t("reports.onceNote")}</p>}
                    <ErrorText error={share.error} />
                  </>
                )}
              </div>
              {linkRows.length > 0 && (
                <div className="scroll">
                  <table className="table">
                    <thead><tr><th>{t("share.by")}</th><th>{t("share.on")}</th><th>{t("step.run")}</th><th>{t("reports.col.files")}</th><th>{t("share.expires")}</th><th className="r">{t("share.openings")}</th><th>{t("share.lastOpened")}</th><th>{t("reports.col.status")}</th><th><span className="sr-only">{t("reports.preview")}</span></th><th className="r"><span className="sr-only">{t("share.revoke")}</span></th></tr></thead>
                    <tbody>
                      {linkRows.map((l) => {
                        const state = l.revoked_at ? "revoked" : l.expires_at && new Date(l.expires_at).getTime() <= Date.now() ? "expired" : "active";
                        return (
                          <tr key={l.id}>
                            <td>{l.created_by}</td>
                            <td className="small muted">{f.date(l.created_at)}</td>
                            <td className="num">{t("common.run", { n: l.run_number })}</td>
                            <td>{l.files.map(linkFile).join(", ")}</td>
                            <td className="small muted">{l.expires_at ? f.date(l.expires_at) : t("share.term.none")}</td>
                            <td className="r num">{l.openings}</td>
                            <td className="small muted">{l.last_opened_at ? f.date(l.last_opened_at) : "—"}</td>
                            <td><StatusTag tone={state === "active" ? "pass" : "neutral"}>{t(`share.${state}`)}</StatusTag></td>
                            <td>{state === "active" && <Link className="btn ghost sm" to="/deals/$dealId/reports/preview/$linkId" params={{ dealId, linkId: l.id }}>{t("reports.preview")}</Link>}</td>
                            <td><div className="acts">{state === "active" && <button className="btn danger sm" type="button" disabled={revoke.isPending} onClick={() => { if (window.confirm(t("share.confirm"))) return revoke.mutate(l.id); }}>{t("share.revoke")}</button>}</div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <ErrorText error={revoke.error} />
          </section>
        )}

        <p className="small muted">{t("reports.closing")}</p>
      </div>
    </>
  );
}
