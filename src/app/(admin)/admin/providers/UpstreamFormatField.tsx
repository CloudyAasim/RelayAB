"use client";

/**
 * Upstream-format picker, shared by the create form and the edit modal.
 *
 * Picking "Anthropic Messages" swaps the endpoint the proxy targets, so the
 * field carries an inline explainer: the usual mistake is pointing an Anthropic
 * provider at the vendor's OpenAI base URL, which yields a 404 on
 * `<base>/v1/messages`.
 */
import { AlertCircle } from "lucide-react";
import { useT } from "@/components/i18n/I18nProvider";

export type UpstreamFormat = "responses" | "chat" | "anthropic";

export const UPSTREAM_FORMATS: UpstreamFormat[] = ["responses", "chat", "anthropic"];

export function UpstreamFormatField({
  value,
  onChange,
  className,
}: {
  value: UpstreamFormat;
  onChange: (value: UpstreamFormat) => void;
  className?: string;
}) {
  const t = useT();

  return (
    <div className={className}>
      <label className="mb-1.5 block text-sm font-medium">
        {t("admin.providers.format.label")}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as UpstreamFormat)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        <option value="responses">{t("admin.providers.format.responses")}</option>
        <option value="chat">{t("admin.providers.format.chat")}</option>
        <option value="anthropic">{t("admin.providers.format.anthropic")}</option>
      </select>
      <p className="mt-1 text-xs text-muted-foreground">
        {value === "responses" && t("admin.providers.format.hint.responses")}
        {value === "chat" && t("admin.providers.format.hint.chat")}
        {value === "anthropic" && t("admin.providers.format.hint.anthropic")}
      </p>
      {value === "anthropic" && <AnthropicFormatTip />}
    </div>
  );
}

/**
 * The checklist shown whenever the Anthropic protocol is selected. Mirrors the
 * "add an Anthropic interface for the same vendor" section of the admin docs.
 */
export function AnthropicFormatTip() {
  const t = useT();

  return (
    <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-warning-foreground dark:text-warning">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {t("admin.providers.format.anthropicTip.title")}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
        <li>{t("admin.providers.format.anthropicTip.baseUrl")}</li>
        <li>{t("admin.providers.format.anthropicTip.endpoint")}</li>
        <li>{t("admin.providers.format.anthropicTip.chat")}</li>
        <li>{t("admin.providers.format.anthropicTip.mapping")}</li>
      </ul>
    </div>
  );
}
