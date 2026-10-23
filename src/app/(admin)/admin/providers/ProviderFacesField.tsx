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

export type OpenAIFaceFormat = "responses" | "chat" | "gemini";

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
  /** Whether this vendor's own protocol is Google's Gemini API. */
  const nativeGemini = value.upstreamFormat === "gemini";
  // The OpenAI side is no longer forced off for a vendor that speaks no
  // OpenAI-compatible protocol: turning it on is how that vendor's models
  // become reachable from an OpenAI client, and the gateway does the
  // translating.
  const openaiOn = value.openaiEnabled;
  const noneOn = !openaiOn && !value.anthropicEnabled;
  /** The OpenAI face is served by the gateway's own translation. */
  const translated = nativeAnthropic || nativeGemini;
  /**
   * Whether the dialect can be chosen here.
   *
   * It cannot when the **vendor type** already says it — a row typed
   * "anthropic" speaks Anthropic, and the type is the thing that decides it.
   * It can otherwise, and it has to: a row whose stored dialect reads
   * "anthropic" while its type says something else would otherwise be stuck
   * on Anthropic with no way out of it.
   */
  const chooseDialect = kind !== "anthropic";

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
                  ...(chooseDialect ? { upstreamFormat: value.upstreamFormat } : {}),
                })
              }
            />
            <span>{t("admin.providers.faces.openai.label")}</span>
          </label>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            {t("admin.providers.faces.openai.hint")}
          </p>
          {openaiOn && translated && (
            /* The upstream speaks a protocol the OpenAI side has to be
               translated into. Saying so is better than offering a dropdown
               whose choice would be ignored — and for Gemini the dropdown
               stays, because Gemini *is* a choice: it names the upstream's
               protocol, not the OpenAI side's. */
            <p className="mt-2 ml-6 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              {t(
                nativeAnthropic
                  ? "admin.providers.faces.openai.translated"
                  : "admin.providers.faces.openai.translatedGemini",
              )}
            </p>
          )}
          {openaiOn && chooseDialect && (
            <div className="mt-2 pl-6">
              <p className="mb-1 text-xs font-medium text-foreground">
                {t("admin.providers.format.label")}
              </p>
              <select
                value={value.upstreamFormat}
                onChange={(e) =>
                  set({
                    upstreamFormat: e.target.value as UpstreamFormat,
                    openaiEnabled: true,
                  })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="responses">{t("admin.providers.format.responses")}</option>
                <option value="chat">{t("admin.providers.format.chat")}</option>
                <option value="anthropic">{t("admin.providers.format.anthropic")}</option>
                <option value="gemini">{t("admin.providers.format.gemini")}</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {value.upstreamFormat === "responses"
                  ? t("admin.providers.format.hint.responses")
                  : value.upstreamFormat === "chat"
                    ? t("admin.providers.format.hint.chat")
                    : value.upstreamFormat === "anthropic"
                      ? t("admin.providers.format.hint.anthropic")
                      : t("admin.providers.format.hint.gemini")}
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
              {/* The one case where the switch is on and the side still does
                  not answer: Google's base has no Anthropic endpoint under
                  it. Saying so beats a checkbox that promises a surface the
                  provider will not serve. */}
              {nativeGemini && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("admin.providers.faces.anthropic.geminiNote")}
                </p>
              )}
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
