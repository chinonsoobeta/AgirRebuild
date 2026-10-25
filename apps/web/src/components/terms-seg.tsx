// The "Finance terms" choice in Settings (card X1): plain words first or finance terms first.
import { useI18n } from "../i18n";
import { useTerms, type TermsPref } from "../terms";
import { Seg } from "./kit";

export function TermsSeg() {
  const { t } = useI18n();
  const { terms, setTerms } = useTerms();
  return (
    <Seg<TermsPref> label={t("terms.title")} value={terms} onChange={setTerms}
      options={[{ value: "plain", label: t("terms.plain") }, { value: "finance", label: t("terms.finance") }]} />
  );
}
