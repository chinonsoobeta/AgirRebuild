import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { COUNTRIES, CURRENCIES, PROVINCES, type Country, type Currency } from "@agir/contracts";
import { api } from "../api";
import { canEdit, ErrorText, useSession } from "../components/ui";
import { useI18n } from "../i18n";
import "../strings/deals";
import "../strings/newdeal";
import * as I from "../components/icons";

// The kinds the API stores and displays through L.asset.
const ASSET_TYPES = ["Multifamily", "Mixed-use", "Industrial", "Office", "Retail", "Hospitality", "Self storage", "Other"] as const;
const NAME_MAX = 160;

export function NewDeal() {
  const { t, L, lang } = useI18n();
  const { workspaceId, role } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The currency follows the country until someone picks another.
  const [country, setCountry] = useState<Country>("CA");
  const [currency, setCurrency] = useState<Currency>("CAD");
  // The name as typed: its length drives the counter, and a paste longer than the limit says it was cut (QA #18).
  const [name, setName] = useState("");
  const [cut, setCut] = useState(false);
  const [blank, setBlank] = useState(false);
  const create = useMutation({
    mutationFn: (body: { name: string; assetType: string; location: string; country: Country; province: string | null; currency: Currency }) =>
      api.post<{ id: string }>(`/workspaces/${workspaceId}/deals`, body),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["deals"] });
      void navigate({ to: "/deals/$dealId/documents", params: { dealId: r.id } });
    },
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // Spaces around a name or a place are never kept, and a name of spaces is no name.
    const trimmed = String(f.get("name") ?? "").trim();
    if (!trimmed) {
      setBlank(true);
      document.getElementById("nd-name")?.focus();
      return;
    }
    create.mutate({
      name: trimmed,
      assetType: String(f.get("assetType")),
      location: String(f.get("location") ?? "").trim(),
      country,
      province: country === "CA" ? String(f.get("province")) : null,
      currency,
    });
  };
  return (
    <div className="newdeal">
      <Link to="/deals" className="back"><I.Back />{t("newdeal.back")}</Link>
      <div className="page-head">
        <div>
          <h1 className="h1">{t("deals.new")}</h1>
          {canEdit(role) && <p className="lead newdeal-lead">{t("newdeal.lead")}</p>}
        </div>
      </div>
      {!canEdit(role) ? (
        <p className="lead">{t("newdeal.cannot")}</p>
      ) : (
        <form className="card card-pad newdeal-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="nd-name">{t("newdeal.name")}</label>
            <input className="input" id="nd-name" name="name" required maxLength={NAME_MAX} aria-describedby="nd-name-help nd-name-count" aria-invalid={blank || undefined}
              value={name}
              onChange={(e) => { setName(e.target.value); setBlank(false); if (e.target.value.length < NAME_MAX) setCut(false); }}
              onPaste={(e) => {
                const el = e.currentTarget;
                const kept = el.value.length - (el.selectionEnd ?? 0) + (el.selectionStart ?? 0);
                setCut(kept + e.clipboardData.getData("text").length > NAME_MAX);
              }} />
            <p className="hint" id="nd-name-help">{t("newdeal.nameHelp")}</p>
            <p className={cut ? "hint newdeal-cut" : "hint"} id="nd-name-count" aria-live="polite">{cut ? t("newdeal.cut", { max: NAME_MAX }) : name.length > NAME_MAX - 40 ? t("newdeal.count", { n: name.length, max: NAME_MAX }) : null}</p>
            {blank && <p className="error-text" role="alert">{t("newdeal.blank")}</p>}
          </div>
          <div className="field">
            <label htmlFor="nd-type">{t("newdeal.kind")}</label>
            <select className="select" id="nd-type" name="assetType">{ASSET_TYPES.map((a) => <option key={a} value={a}>{`${L.asset(a)}: ${t(`newdeal.hint.${a}`)}`}</option>)}</select>
          </div>
          <div className="grid2 newdeal-pair">
            <div className="field">
              <label htmlFor="nd-country">{t("deals.country")}</label>
              <select
                className="select"
                id="nd-country"
                value={country}
                onChange={(e) => {
                  const c = e.target.value as Country;
                  setCountry(c);
                  setCurrency(c === "CA" ? "CAD" : "USD");
                }}
              >
                {COUNTRIES.map((c) => <option key={c} value={c}>{t(`deals.country.${c}`)}</option>)}
              </select>
            </div>
            {country === "CA" && (
              <div className="field">
                <label htmlFor="nd-prov">{t("deals.province")}</label>
                <select className="select" id="nd-prov" name="province" required defaultValue="">
                  <option value="" disabled>{t("deals.provinceChoose")}</option>
                  {[...PROVINCES]
                    .sort((a, b) => a[lang].localeCompare(b[lang], lang === "fr" ? "fr-CA" : "en-CA"))
                    .map((p) => <option key={p.code} value={p.code}>{p[lang]}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="nd-loc">{t("deals.location")}</label>
            <input className="input" id="nd-loc" name="location" maxLength={NAME_MAX} aria-describedby="nd-loc-help" />
            <p className="hint" id="nd-loc-help">{t("newdeal.locationHelp")}</p>
          </div>
          <div className="field">
            <label htmlFor="nd-cur">{t("deals.currency")}</label>
            <select className="select newdeal-currency" id="nd-cur" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-describedby="nd-cur-help">
              {CURRENCIES.map((c) => <option key={c} value={c}>{L.currency(c)}</option>)}
            </select>
            <p className="hint" id="nd-cur-help">{t("deals.currencyHint")}</p>
          </div>
          <ErrorText error={create.error} />
          <div className="row newdeal-actions">
            <button className="btn primary" type="submit" disabled={create.isPending}>{t("deals.create")}</button>
            <Link to="/deals" className="btn quiet">{t("common.cancel")}</Link>
            <span className="small muted newdeal-landing">{t("newdeal.landing")}</span>
          </div>
        </form>
      )}
    </div>
  );
}
