import { ChevronDown, HeartHandshake } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { CompanionReplyMode } from "../../../../../shared/companion";

const modes = ["listen", "reflect", "help", "light"] as const satisfies readonly CompanionReplyMode[];

export function ChatCompanionReplyMode({
  mode,
  onChange,
}: {
  mode?: CompanionReplyMode;
  onChange: (mode: CompanionReplyMode | undefined) => void;
}) {
  const { t } = useTranslation();
  const label = t("composer.companionReply.label");

  return (
    <label className={`cy-companion-reply-mode${mode ? " is-selected" : ""}`} title={label}>
      <HeartHandshake size={16} aria-hidden="true" />
      <select
        aria-label={label}
        value={mode ?? ""}
        onChange={(event) => onChange(modes.find((item) => item === event.currentTarget.value))}
      >
        <option value="">{t("composer.companionReply.natural")}</option>
        {modes.map((item) => <option key={item} value={item}>{t(`composer.companionReply.${item}`)}</option>)}
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  );
}
