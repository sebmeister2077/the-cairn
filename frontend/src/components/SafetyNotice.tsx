/**
 * Visible safety/privacy notice shown at the top of every singleplayer tool.
 *
 * Two flavours:
 *   - "read"   — the tool only reads the uploaded save file (Extract, Commands).
 *                Shows the privacy line only.
 *   - "modify" — the tool returns a modified copy of the save (Import, Delete).
 *                Shows the privacy line AND a prominent "back up first" warning.
 */

import { useTranslation } from "@/lib/i18n";

type Mode = "read" | "modify";

interface SafetyNoticeProps {
  mode: Mode;
}

export function SafetyNotice({ mode }: SafetyNoticeProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {mode === "modify" && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-900">
          <strong>{t("singleplayerSafety.modify.warningTitle")}</strong>{" "}
          {t("singleplayerSafety.modify.warningBody")}
        </div>
      )}
      <div className="rounded border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
        <strong>{t("singleplayerSafety.privacy.title")}</strong>{" "}
        {mode === "modify"
          ? t("singleplayerSafety.privacy.modifyBody")
          : t("singleplayerSafety.privacy.readBody")}
      </div>
    </div>
  );
}
