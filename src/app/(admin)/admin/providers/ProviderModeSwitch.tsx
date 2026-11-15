"use client";

/**
 * src/app/(admin)/admin/providers/ProviderModeSwitch.tsx
 *
 * Which half of the provider editor is open: 简易模式 / 高级模式（协议） / 透传模式.
 *
 * **A native select, like every other choice of this kind.** The modes were
 * three cards for a while; the cards were clearer than the pill before them,
 * but they were also a second visual language for a choice the rest of the
 * admin uses a dropdown for — and three cards take the top of the dialog away
 * from the fields. The selected mode's own sentence sits under the select, so
 * the explanation did not go with the cards.
 */
import { Select } from "@/components/ui/Select";
import { useT } from "@/components/i18n/I18nProvider";

type Mode = "simple" | "advanced" | "passthrough";

export function ProviderModeSwitch({
  mode,
  onChange,
  interfaceCount,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  /** How many interfaces have a rule written, for the advanced option. */
  interfaceCount: number;
}) {
  const t = useT();

  const bodies: Record<Mode, string> = {
    simple: t("admin.textSpec.mode.simpleBody"),
    advanced: t("admin.textSpec.mode.advancedBody"),
    passthrough: t("admin.providers.routes.mode.passthroughBody"),
  };

  return (
    <Select
      label={t("admin.providers.modeLabel")}
      value={mode}
      onChange={(e) => onChange(e.target.value as Mode)}
      hint={bodies[mode]}
    >
      <option value="simple">{t("admin.textSpec.mode.simple")}</option>
      <option value="advanced">
        {t("admin.textSpec.mode.advanced")}
        {interfaceCount > 0
          ? ` · ${t("admin.textSpec.mode.configured", { n: interfaceCount })}`
          : ""}
      </option>
      <option value="passthrough">{t("admin.providers.routes.mode.passthrough")}</option>
    </Select>
  );
}
