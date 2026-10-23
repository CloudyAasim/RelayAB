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
  kind,
  className,
}: {
  value: ProviderFacesValue;
  onChange: (value: ProviderFacesValue) => void;
  /**
   * The provider's vendor type.
   *
   * It decides what the OpenAI side *means* for this row: a vendor that only
   * publishes an Anthropic endpoint has no Responses endpoint to point at, so
   * turning the OpenAI side on for it means **the gateway translates**.
   */
  kind: string;
  className?: string;
}) {
  const t = useT();
  const set = (patch: Partial<ProviderFacesValue>) => onChange({ ...value, ...patch });

  // A row whose upstream speaks Anthropic says so in one of two ways, and both
  // are still in the wild: `upstreamFormat: "anthropic"` (the older
  // encoding) and `kind: "anthropic"` (the vendor type).
  const anthropicUpstream = value.upstreamFormat === "anthropic";
  /**
   * Whether this vendor's own protocol is Anthropic.
   *
   * `kind` is the primary carrier; the `upstreamFormat` half is the older
   * encoding, kept so that a row written before `kind` existed still says
   * what it is.
   */
  const nativeAnthropic = kind === "anthropic" || anthropicUpstream;
  const openaiFormat: OpenAIFaceFormat = value.upstreamFormat === "chat" ? "chat" : "responses";
  // The OpenAI side is no longer forced off for an Anthropic vendor: turning it
  // on is how that vendor's models become reachable from an OpenAI client, and
  // the gateway does the translating.
  const openaiOn = value.openaiEnabled;
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
                set({
                  openaiEnabled: e.target.checked,
                  ...(nativeAnthropic ? {} : { upstreamFormat: openaiFormat }),
                })
              }
            />
            <span>{t("admin.providers.faces.openai.label")}</span>
          </label>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            {t("admin.providers.faces.openai.hint")}
          </p>
          {openaiOn && nativeAnthropic && (
            /* An Anthropic vendor has no Responses endpoint to point at, so
               there is no format to choose — the gateway translates. Saying
               so is better than offering a dropdown whose choice is ignored. */
            <p className="mt-2 ml-6 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {t("admin.providers.faces.openai.translated")}
            </p>
          )}
          {openaiOn && !nativeAnthropic && (
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
              <p className="mt-1 text-xs text-muted-foreground">
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
