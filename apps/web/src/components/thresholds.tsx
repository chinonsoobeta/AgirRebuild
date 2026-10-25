import { Fragment, useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { THRESHOLDS, type RunResult } from "@agir/contracts";
import { api, ApiError, type ThresholdView } from "../api";
import { checkText, useI18n, type I18n, type Key } from "../i18n";
import { ErrorText, useSession } from "./ui";

/** The policies this build knows (`POLICIES` in packages/contracts/src/policy.ts), each named in words. */
const POLICY_NAMES: Readonly<Record<string, Key>> = {
  "policy-v1": "thresholds.policy.policy-v1",
  "rental-hold-draft": "thresholds.policy.rental-hold-draft",
  "rental-hold-insured-draft": "thresholds.policy.rental-hold-insured-draft",
  "rental-hold-insured-standard-draft": "thresholds.policy.rental-hold-insured-standard-draft",
  "rental-hold-insured-standard-short-draft": "thresholds.policy.rental-hold-insured-standard-short-draft",
  "for-sale-draft": "thresholds.policy.for-sale-draft",
};

/** A policy as a person reads it: its name in words, or its version id when this build does not know it. */
export function policyName(i: Pick<I18n, "t">, version: string): string {
  return Object.hasOwn(POLICY_NAMES, version) ? i.t(POLICY_NAMES[version]!) : version;
}

/** A saved value that no longer fits: the policy's name and the threshold's label, else the raw version and path. */
function invalidLine(i: Pick<I18n, "t" | "lang">, v: NonNullable<ThresholdView["invalid"]>[number]): string {
  const label = THRESHOLDS[v.version]?.find((threshold) => threshold.path === v.path)?.label[i.lang] ?? v.path;
  return `${policyName(i, v.version)} · ${label} = ${v.value}`;
}

/** The same governed editor for workspace defaults and deal-specific values. A screen that already
    titles the section passes `summary` so the disclosure does not repeat its heading. */
export function Thresholds({ scope, id, initialVersion = "", summary, open }: { scope: "workspaces" | "deals"; id: string; initialVersion?: string; summary?: string; open?: boolean }) {
  const i = useI18n();
  const { t, lang, f } = i;
  const { role } = useSession();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState(initialVersion);
  const path = `/${scope}/${id}/thresholds`;
  const query = useQuery({ queryKey: ["thresholds", scope, id], queryFn: () => api.get<ThresholdView>(path) });
  const save = useMutation({ mutationFn: (body: { policyVersion: string; path: string; value: number | null; reason: string }) => api.post(path,body),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["thresholds"] }), qc.invalidateQueries({ queryKey: ["deal"] }), qc.invalidateQueries({ queryKey: ["deals"] }), qc.invalidateQueries({ queryKey: ["run"] })]) });
  const policies = query.data?.policies ?? [];
  const policy = policies.find((policy) => policy.version === chosen) ?? policies[0];
  const error = lang === "fr" && save.error instanceof ApiError && save.error.detail?.fr ? new Error(save.error.detail.fr) : save.error;
  return <details className="stack" open={open}>
    <summary className={summary ? undefined : "h3"}>{summary ?? t("threshold.title")}</summary>
    <ErrorText error={query.error ?? error} />
    {(query.data?.invalid ?? []).length > 0 && <div className="stack">
      <p className="hint">{t("threshold.invalid")}</p>
      <ul>{(query.data?.invalid ?? []).map((v) => {
        const own = (scope === "deals" ? "deal" : "workspace") === v.layer;
        const clear = (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          save.mutate({ policyVersion: v.version, path: v.path, value: null, reason: String(new FormData(event.currentTarget).get("reason")) });
        };
        return <li key={`${v.layer}-${v.version}-${v.path}`}>{invalidLine(i, v)} ({t(v.layer === "deal" ? "threshold.layerDeal" : "threshold.layerWorkspace")}) · {v.error[lang]}
          <p className="muted">{v.setByName} · {f.date(v.setAt)} · {v.reason}</p>
          {role === "owner" && own && <form className="row" onSubmit={clear}>
            <input aria-label={t("threshold.reason")} className="input" name="reason" required placeholder={t("threshold.reason")} />
            <button className="btn quiet sm" type="submit" value="clear-invalid" disabled={save.isPending}>{t("threshold.clear")}</button>
          </form>}</li>;
      })}</ul>
    </div>}
    {policy && <>
      <label className="field"><span className="label">{t("threshold.strategy")}</span><select className="select" value={policy.version} onChange={(event) => setChosen(event.target.value)}>{policies.map((policy) => <option key={policy.version} value={policy.version}>{policyName(i, policy.version)}</option>)}</select></label>
      <div className="scroll"><table className="table"><thead><tr><th>{t("threshold.name")}</th><th>{t("threshold.standard")}</th>{scope === "deals" && <th>{t("threshold.workspace")}</th>}<th>{t("threshold.yours")}</th></tr></thead>
        <tbody>{policy.thresholds.map((row) => {
          const own = scope === "deals" ? row.deal : row.workspace;
          const note = row.deal ?? row.workspace;
          const flags = [row.looser && t("threshold.looser"), row.looser && row.lenderCited && t("threshold.cited"), row.stressRemoved && t("threshold.removed")].filter(Boolean).join(" · ");
          const submit = (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const clear = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "clear";
            save.mutate({ policyVersion: policy.version, path: row.path, value: clear ? null : Number(form.get("value")), reason: String(form.get("reason")) });
          };
          return <tr key={row.path}><td>{row.label[lang]}<div className="muted">{t("threshold.range", { min: row.min, max: row.max, unit: row.unit, whole: row.integer ? t("threshold.whole") : "" })}</div>{flags && <p className="hint">{flags}</p>}</td>
            <td>{f.value(row.standard,row.unit)}</td>{scope === "deals" && <td>{row.workspace ? f.value(row.workspace.value,row.unit) : t("threshold.standard")}</td>}
            <td>{role === "owner" ? <form className="stack" key={`${policy.version}-${row.value}-${own?.setAt}`} onSubmit={submit}>
              <input aria-label={row.label[lang]} className="input" type="number" name="value" required defaultValue={row.value} min={row.min} max={row.max} step={row.integer ? 1 : "any"} />
              <input aria-label={t("threshold.reason")} className="input" name="reason" required placeholder={t("threshold.reason")} />
              <div className="row"><button className="btn primary sm" type="submit" value="save" disabled={save.isPending}>{t("threshold.save")}</button><button className="btn quiet sm" type="submit" value="clear" disabled={!own || save.isPending}>{t("threshold.clear")}</button></div>
            </form> : f.value(row.value,row.unit)}
              {note && <p className="muted">{note.setByName} · {f.date(note.setAt)} · {note.reason}</p>}
            </td></tr>;
        })}</tbody></table></div>
    </>}
  </details>;
}

/** A deal's thresholds in force, read-only: each one's bound and, when it is not the standard, where it was set.
    It shows the policy of the deal's latest run, otherwise the first, with a select for the others. */
export function ThresholdList({ dealId, children }: { dealId: string; children?: (version: string, invalid: boolean) => ReactNode }) {
  const i = useI18n();
  const { t, lang, f } = i;
  const { role } = useSession();
  const query = useQuery({ queryKey: ["thresholds", "deals", dealId], queryFn: () => api.get<ThresholdView>(`/deals/${dealId}/thresholds`) });
  const runs = useQuery({ queryKey: ["runs", dealId], queryFn: () => api.get<{ policy_version?: string }[]>(`/deals/${dealId}/runs`) });
  const [chosen, setChosen] = useState<string | null>(null);
  const selectId = useId();
  const policies = query.data?.policies ?? [];
  const latest = runs.data?.[0]?.policy_version;
  const policy = policies.find((p) => p.version === chosen) ?? policies.find((p) => p.version === latest) ?? policies[0];
  const invalid = query.data?.invalid ?? [];
  return <>
    <ErrorText error={query.error} />
    {policy && <>
      {policies.length > 1
        ? <label className="row small" htmlFor={selectId}><span className="muted">{t("threshold.strategy")}</span>
          <select id={selectId} className="select" value={policy.version} onChange={(event) => setChosen(event.target.value)}>{policies.map((p) => <option key={p.version} value={p.version}>{policyName(i, p.version)}</option>)}</select></label>
        : <span className="small muted">{policyName(i, policy.version)}</span>}
      <dl className="kv th-list">{policy.thresholds.map((row) => {
        const value = f.value(row.value, row.unit);
        const changed = row.value !== row.standard;
        const notes = [
          changed && row.deal ? t("thresholds.setDeal") : changed && row.workspace ? t("thresholds.setWorkspace") : null,
          row.looser && t("threshold.looser"), row.stressRemoved && t("threshold.removed"), row.lenderCited && t("thresholds.cited"),
        ].filter(Boolean).join(" · ");
        return <Fragment key={row.path}><dt>{row.label[lang]}</dt>
          <dd className="num">{row.looserDirection === "lower" ? t("thresholds.atLeast", { value }) : row.looserDirection === "higher" ? t("thresholds.atMost", { value }) : value}</dd>
          {notes && <dd className="small muted th-note">{notes}</dd>}</Fragment>;
      })}</dl>
    </>}
    {invalid.length > 0 && <p className="hint">{t("threshold.invalid")}</p>}
    {/* The owner clears these in the editor; anyone else still sees which values they are. */}
    {invalid.length > 0 && role !== "owner" && <ul className="small">{invalid.map((v) => <li key={`${v.layer}-${v.version}-${v.path}`}>{invalidLine(i, v)} ({t(v.layer === "deal" ? "threshold.layerDeal" : "threshold.layerWorkspace")}) · {v.error[lang]}</li>)}</ul>}
    {policy && children?.(policy.version, invalid.length > 0)}
  </>;
}

export function StandardVerdict({ custom, standard }: { custom: boolean; standard?: RunResult["standard"] }) {
  const i = useI18n();
  if (!custom || !standard) return null;
  const insured = standard.policyVersion.startsWith("rental-hold-insured");
  const failures = [
    ...standard.verdict.gates.filter((gate) => !["passed","not_applicable"].includes(gate.status)).map((gate) => ({ text: `${i.L.gate(gate.key,gate.label)} ≥ ${i.f.value(gate.threshold,gate.unit)}`, cited: insured && gate.key === "dcr_after_refinance" })),
    ...standard.checks.filter((check) => check.severity === "error").map((check) => ({ text: checkText(i,check), cited: ["insured_min_units","refinance_ltv_limit","refinance_ltc_limit","refinance_amort_limit"].includes(check.key) })),
  ].sort((a,b) => Number(b.cited)-Number(a.cited));
  return <div className="stack tight"><strong>{i.t("threshold.standardVerdict", { verdict: i.L.verdict(standard.verdict.code) })}</strong>{failures.length > 0 && <ul>{failures.map((failure,index) => <li key={index}>{failure.text}</li>)}</ul>}</div>;
}
