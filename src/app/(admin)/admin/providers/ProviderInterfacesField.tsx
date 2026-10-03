"use client";

/**
 * src/app/(admin)/admin/providers/ProviderInterfacesField.tsx
 *
 * Which interfaces this provider answers, and the rule for each — one block.
 *
 * **These were two blocks, and they contradicted each other.** "协议面" was a
 * pair of checkboxes over the same three interfaces that "上游协议" then listed
 * again as an editable list, with its own vocabulary for the same question. You
 * could switch the OpenAI side off and still be offered "add /v1/responses",
 * which is why the two had to be joined up with a filter, a badge and a warning
 * explaining why one of them was lying. The plumbing worked; the shape was
 * wrong.
 *
 * The grouping that is actually true: **a face is the switch, the interfaces
 * under it are the rules.** The two OpenAI interfaces answer to
 * `openaiEnabled` and the Anthropic one to `anthropicEnabled` — those are
 * provider columns the proxy routes on, and they are not derivable from the
 * rules, because a provider can serve Chat Completions with no rule at all. So
 * the toggles stay. The rules move inside them, where the only interfaces on
 * offer are the ones that face already covers.
 *
 * That makes three whole classes of defect unrepresentable rather than merely
 * guarded: a rule for a switched-off face, a badge saying a rule is inert, and
 * an "all N configured" line whose N was a number in a sentence.
 *
 * It also removes the protocol picker from each row. The row *is* the protocol,
 * so there is nothing left to pick wrongly.
 */
import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { isTextProtocol, parseTextSpec, type TextProtocol } from "@/lib/protocol/text-spec";
import { SURFACES, validateTextSpecs, type ProviderFaceId } from "@/lib/protocol/text-specs";
import { TEXT_PROTOCOL_LABELS, protocolPreset } from "@/lib/protocol/text-protocols";

export type OpenAIFaceFormat = "responses" | "chat";

/** `"anthropic"` is the legacy "Anthropic-only row" encoding. */
export type UpstreamFormat = OpenAIFaceFormat | "anthropic";

export interface ProviderFacesValue {
  openaiEnabled: boolean;
  upstreamFormat: UpstreamFormat;
  anthropicEnabled: boolean;
  anthropicBaseUrl: string;
}

export type ProtocolVerdict =
  | { kind: "none" }
  | { kind: "ok"; warnings: string[] }
  | { kind: "bad"; errors: string[] };

/** One shared judge, so the editor and the endpoint cannot disagree. */
export function judgeTextSpec(text: string): ProtocolVerdict {
  if (!text.trim()) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: "bad", errors: [e instanceof Error ? e.message : "JSON 解析失败"] };
  }
  const result = parseTextSpec(parsed);
  return result.ok
    ? { kind: "ok", warnings: result.warnings }
    : { kind: "bad", errors: result.errors };
}

/** The interfaces that belong to one face, in declaration order. */
function surfacesOf(face: ProviderFaceId) {
  return SURFACES.filter((s) => s.face === face);
}

/**
 * The rule written for one interface, as its raw stored string.
 *
 * Read from the raw column rather than a parsed form so an entry that no
 * longer parses is still shown as a broken row to be fixed, not silently
 * dropped from the editor the way a parse-and-filter would drop it.
 */
function ruleFor(raws: readonly string[], protocol: string): string | undefined {
  for (const raw of raws) {
    try {
      if ((JSON.parse(raw) as { protocol?: string }).protocol === protocol) return raw;
    } catch {
      // Reported as "this one is wrong" by judgeTextSpec below.
    }
  }
  return undefined;
}

export function ProviderInterfacesField({
  value,
  onChange,
  textSpecs,
  onTextSpecsChange,
  showRules,
  className,
}: {
  value: ProviderFacesValue;
  onChange: (value: ProviderFacesValue) => void;
  /** The stored protocol documents, one JSON string per interface. */
  textSpecs: string[];
  onTextSpecsChange: (next: string[]) => void;
  /** Advanced mode. Simple mode shows the switches and leaves the rules out. */
  showRules: boolean;
  className?: string;
}) {
  const t = useT();
  const set = (patch: Partial<ProviderFacesValue>) => onChange({ ...value, ...patch });

  // Legacy rows (`upstreamFormat: "anthropic"`) read as "Anthropic only" and
  // are rewritten into the two-flag shape on save.
  const legacyAnthropicOnly = value.upstreamFormat === "anthropic";
  const openaiFormat: OpenAIFaceFormat = value.upstreamFormat === "chat" ? "chat" : "responses";
  const openaiOn = value.openaiEnabled && !legacyAnthropicOnly;
  const noneOn = !openaiOn && !value.anthropicEnabled;

  const put = (protocol: string, raw: string) => {
    const kept = textSpecs.filter((r) => {
      try {
        return (JSON.parse(r) as { protocol?: string }).protocol !== protocol;
      } catch {
        return true;
      }
    });
    onTextSpecsChange([...kept, raw]);
  };

  const drop = (protocol: string) => {
    onTextSpecsChange(
      textSpecs.filter((r) => {
        try {
          return (JSON.parse(r) as { protocol?: string }).protocol !== protocol;
        } catch {
          return true;
        }
      }),
    );
  };

  const verdict = validateTextSpecs(textSpecs);

  const face = (
    id: ProviderFaceId,
    on: boolean,
    label: string,
    hint: string,
    extras: React.ReactNode,
  ) => {
    const surfaces = surfacesOf(id);
    const written = surfaces.filter((s) => ruleFor(textSpecs, s.id) !== undefined).length;

    return (
      <div
        className={
          on
            ? "rounded-md border border-border bg-muted/20 px-3 py-2.5"
            : "rounded-md border border-border px-3 py-2.5 opacity-60"
        }
      >
        <label className="flex items-start gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={on}
            onChange={(e) =>
              id === "openai"
                ? set({ openaiEnabled: e.target.checked, upstreamFormat: openaiFormat })
                : set({ anthropicEnabled: e.target.checked })
            }
          />
          <span>{label}</span>
        </label>
        <p className="mt-1 pl-6 text-xs text-muted-foreground">{hint}</p>

        {on && <div className="mt-2 pl-6">{extras}</div>}

        {showRules && on && (
          <div className="mt-3 space-y-2 pl-6">
            {surfaces.map((s) => (
              <SurfaceRule
                key={s.id}
                protocol={s.id}
                clientPath={s.clientPath}
                raw={ruleFor(textSpecs, s.id)}
                onPut={(raw) => put(s.id, raw)}
                onDrop={() => drop(s.id)}
              />
            ))}
            <p className="text-[11px] text-muted-foreground">
              {written === surfaces.length
                ? t("admin.interfaces.rulesAll")
                : written === 0
                  ? t("admin.interfaces.rulesNone")
                  : t("admin.interfaces.rulesSome", { n: written, total: surfaces.length })}
            </p>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={className}>
      <p className="mb-1 text-sm font-medium">{t("admin.interfaces.title")}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t("admin.interfaces.hint")}</p>

      <div className="space-y-3">
        {face(
          "openai",
          openaiOn,
          t("admin.providers.faces.openai.label"),
          t("admin.providers.faces.openai.hint"),
          <>
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
          </>,
        )}

        {face(
          "anthropic",
          value.anthropicEnabled,
          t("admin.providers.faces.anthropic.label"),
          t("admin.providers.faces.anthropic.hint"),
          <>
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
          </>,
        )}
      </div>

      {noneOn && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning-foreground dark:text-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("admin.providers.faces.noneWarning")}
        </p>
      )}

      {!verdict.ok && (
        <ul className="mt-2 space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {verdict.errors.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One interface, and the rule written for it.
 *
 * No protocol picker: the row already *is* one interface, so the question
 * "which protocol is this" has no answer to get wrong. A row is either empty
 * (the request is forwarded as sent) or holds a document.
 */
function SurfaceRule({
  protocol,
  clientPath,
  raw,
  onPut,
  onDrop,
}: {
  protocol: string;
  clientPath: string;
  raw: string | undefined;
  onPut: (raw: string) => void;
  onDrop: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = isTextProtocol(protocol) ? TEXT_PROTOCOL_LABELS[protocol as TextProtocol].zh : protocol;
  const entry = raw === undefined ? { kind: "none" as const } : judgeTextSpec(raw);

  if (raw === undefined) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-muted-foreground">{clientPath}</code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              if (isTextProtocol(protocol)) onPut(JSON.stringify(protocolPreset(protocol), null, 2));
              setOpen(true);
            }}
          >
            {t("admin.interfaces.addRule")}
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("admin.interfaces.defaultNote")}</p>
      </div>
    );
  }

  return (
    <div
      className={
        entry.kind === "bad"
          ? "rounded-md border-2 border-destructive/60"
          : "rounded-md border border-border"
      }
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
          <span className="text-xs font-medium text-foreground">{label}</span>
          <code className="truncate text-[10px] text-muted-foreground">{clientPath}</code>
          {entry.kind === "bad" && (
            <span className="ml-auto shrink-0 text-[10px] text-destructive">
              {t("admin.textSpec.mode.brokenEntry")}
            </span>
          )}
        </button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDrop}
          aria-label={t("admin.interfaces.removeRule")}
        >
          ✕
        </Button>
      </div>

      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          <textarea
            value={raw}
            onChange={(e) => onPut(e.target.value)}
            rows={12}
            spellCheck={false}
            aria-label={label}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
          />
          {entry.kind === "bad" && (
            <ul className="space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {entry.errors.map((e) => (
                <li key={e}>· {e}</li>
              ))}
            </ul>
          )}
          {entry.kind === "ok" && entry.warnings.length > 0 && (
            <ul className="space-y-0.5 rounded-md bg-warning/10 p-2 text-xs text-warning-foreground">
              {entry.warnings.map((w) => (
                <li key={w}>· {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
