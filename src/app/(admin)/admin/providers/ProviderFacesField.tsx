"use client";

/**
 * src/app/(admin)/admin/providers/ProviderFacesField.tsx
 *
 * Which interfaces this provider answers. **Simple mode only.**
 *
 * Advanced mode renders `ProviderInterfacesList` instead and leaves the face
 * flags alone — the two modes are alternatives, so editing rules never has a
 * switch to contradict, and switching a face is never a reason to go looking
 * through the rules.
 *
 * The flags themselves are not mode-dependent: `openaiEnabled` and
 * `anthropicEnabled` are columns the proxy routes on, they are not derivable
 * from the rules (a provider can serve Chat Completions with no rule at all),
 * and whatever they were set to in simple mode is what advanced mode saves.
 */
import { AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";

export type OpenAIFaceFormat = "responses" | "chat";

/** `"anthropic"` is the legacy "Anthropic-only row" encoding. */
export type UpstreamFormat = OpenAIFaceFormat | "anthropic";

export interface ProviderFacesValue {
  openaiEnabled: boolean;
  upstreamFormat: UpstreamFormat;
  anthropicEnabled: boolean;
  anthropicBaseUrl: string;
}

export function ProviderFacesField({
  value,
  onChange,
  className,
}: {
  value: ProviderFacesValue;
  onChange: (value: ProviderFacesValue) => void;
  className?: string;
}) {
  const t = useT();
  const set = (patch: Partial<ProviderFacesValue>) => onChange({ ...value, ...patch });

  // Rows written before faces existed store "anthropic" here; they show up as
  // "Anthropic only" and are rewritten into the two-flag shape on save.
  const legacyAnthropicOnly = value.upstreamFormat === "anthropic";
  const openaiFormat: OpenAIFaceFormat = value.upstreamFormat === "chat" ? "chat" : "responses";
  const openaiOn = value.openaiEnabled && !legacyAnthropicOnly;
  const noneOn = !openaiOn && !value.anthropicEnabled;

  return (
    <div className={className}>
      <p className="mb-1 text-sm font-medium">{t("admin.providers.faces.title")}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t("admin.providers.faces.hint")}</p>

      <div className="space-y-3">
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={openaiOn}
              onChange={(e) =>
                set({ openaiEnabled: e.target.checked, upstreamFormat: openaiFormat })
              }
            />
            <span>{t("admin.providers.faces.openai.label")}</span>
          </label>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            {t("admin.providers.faces.openai.hint")}
          </p>
          {openaiOn && (
            <div className="mt-2 pl-6">
              <p className="mb-1 text-xs font-medium text-foreground">
                {t("admin.providers.format.label")}
              </p>
              <select
                value={openaiFormat}
                onChange={(e) =>
                  set({ upstreamFormat: e.target.value as OpenAIFaceFormat, openaiEnabled: true })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="responses">{t("admin.providers.format.responses")}</option>
                <option value="chat">{t("admin.providers.format.chat")}</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {openaiFormat === "responses"
                  ? t("admin.providers.format.hint.responses")
                  : t("admin.providers.format.hint.chat")}
              </p>
            </div>
          )}
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={value.anthropicEnabled}
              onChange={(e) => set({ anthropicEnabled: e.target.checked })}
            />
            <span>{t("admin.providers.faces.anthropic.label")}</span>
          </label>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            {t("admin.providers.faces.anthropic.hint")}
          </p>
          {value.anthropicEnabled && (
            <div className="mt-2 pl-6">
              <Input
                label={t("admin.providers.faces.anthropic.baseUrl")}
                value={value.anthropicBaseUrl}
                onChange={(e) => set({ anthropicBaseUrl: e.target.value })}
                placeholder="https://api.agnes-ai.cn"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.providers.faces.anthropic.baseUrlHint")}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("admin.providers.faces.anthropicTip.endpoint")}
              </p>
            </div>
          )}
        </div>
      </div>

      {noneOn && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning-foreground dark:text-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("admin.providers.faces.noneWarning")}
        </p>
      )}
    </div>
  );
}
