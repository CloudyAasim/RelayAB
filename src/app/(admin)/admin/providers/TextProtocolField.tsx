"use client";

/**
 * src/app/(admin)/admin/providers/TextProtocolField.tsx
 *
 * A provider's configuration, in two modes.
 *
 * **Simple**: pick the endpoint and the models. Right for the ninety percent of
 * OpenAI-compatible vendors, and unchanged from before.
 *
 * **Advanced**: declare what the gateway does with the parameters in a request.
 *
 * **They are exclusive, and the interface says so.** The previous version was a
 * two-segment pill whose pressed state was a background tint, which is not a
 * thing anybody reads; the complaint was that you could not tell which mode you
 * were in. So this is two cards, each stating what it is and which one is on, in
 * words, and the chosen one says so out loud.
 *
 * **Advanced is a list, not a document.** A provider that serves both Chat
 * Completions and Anthropic Messages has two parameter vocabularies — the
 * second calls it `stop_sequences` and requires `max_tokens` — and one document
 * could only ever describe one of them. So each compatibility interface the
 * provider speaks gets its own entry, and the proxy applies the one matching the
 * surface the client called.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import {
  parseTextSpec,
  isTextProtocol,
  type TextProtocol,
} from "@/lib/protocol/text-spec";
import { SURFACES, validateTextSpecs } from "@/lib/protocol/text-specs";
import {
  CONFIGURABLE_PROTOCOLS,
  TEXT_PROTOCOL_LABELS,
  protocolPreset,
} from "@/lib/protocol/text-protocols";

export type ProtocolVerdict =
  | { kind: "none" }
  | { kind: "ok"; warnings: string[] }
  | { kind: "bad"; errors: string[] };

/** One shared judge, so a create form and an edit form cannot disagree. */
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

const judgeEntry = judgeTextSpec;

/** The two modes, as cards, because a pill does not say which one you are in. */
export function ProviderModeSwitch({
  mode,
  onChange,
  interfaceCount,
}: {
  mode: "simple" | "advanced";
  onChange: (mode: "simple" | "advanced") => void;
  /** How many compatibility interfaces are configured, for the advanced card. */
  interfaceCount: number;
}) {
  const t = useT();
  const card = (id: "simple" | "advanced", title: string, body: string, badge: string | null) => {
    const on = mode === id;
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        aria-pressed={on}
        className={
          on
            ? "flex-1 rounded-lg border-2 border-primary bg-primary/5 p-3 text-left"
            : "flex-1 rounded-lg border-2 border-border p-3 text-left hover:border-muted-foreground/40"
        }
      >
        <div className="flex items-center gap-2">
          <span
            className={
              on
                ? "flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground"
                : "flex h-4 w-4 items-center justify-center rounded-full border border-border"
            }
            aria-hidden
          >
            {on ? "●" : ""}
          </span>
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge && (
            <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 pl-6 text-xs text-muted-foreground">{body}</p>
      </button>
    );
  };

  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">{t("admin.textSpec.modeHint")}</p>
      <div className="flex gap-2">
        {card("simple", t("admin.textSpec.mode.simple"), t("admin.textSpec.mode.simpleBody"), mode === "simple" ? t("admin.textSpec.mode.current") : null)}
        {card(
          "advanced",
          t("admin.textSpec.mode.advanced"),
          t("admin.textSpec.mode.advancedBody"),
          mode === "advanced" ? t("admin.textSpec.mode.current") : interfaceCount > 0 ? t("admin.textSpec.mode.configured", { n: interfaceCount }) : null,
        )}
      </div>
    </div>
  );
}

/**
 * The advanced half: one entry per compatibility interface.
 *
 * No button of its own — the parent form submits, so the provider's key and
 * name are saved or not saved together with the protocols. A protocol is part
 * of a provider, and a save button that could commit one without the other is
 * how the two drift.
 */
export function TextProtocolField({
  value,
  onChange,
}: {
  /** The stored list, each entry a JSON document. */
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const used = new Set(
    value.map((raw) => {
      try {
        const parsed = JSON.parse(raw) as { protocol?: string };
        return typeof parsed.protocol === "string" ? parsed.protocol : "";
      } catch {
        return "";
      }
    }),
  );

  const add = (protocol: TextProtocol) => {
    onChange([...value, JSON.stringify(protocolPreset(protocol), null, 2)]);
    setOpenIndex(value.length);
  };

  const update = (index: number, text: string) =>
    onChange(value.map((entry, i) => (i === index ? text : entry)));

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    setOpenIndex(null);
  };

  const verdict = validateTextSpecs(value);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">{t("admin.textSpec.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("admin.textSpec.desc")}</p>
      </div>

      {value.length === 0 && (
        <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          {t("admin.textSpec.none")}
        </p>
      )}

      {value.map((raw, index) => {
        const entry = judgeEntry(raw);
        let protocol = "";
        try {
          protocol = (JSON.parse(raw) as { protocol?: string }).protocol ?? "";
        } catch {
          protocol = "";
        }
        const label = isTextProtocol(protocol)
          ? TEXT_PROTOCOL_LABELS[protocol].zh
          : t("admin.textSpec.mode.brokenEntry");
        const path = SURFACES.find((s) => s.id === protocol)?.clientPath;
        const isOpen = openIndex === index;

        return (
          <div
            key={index}
            className={
              entry.kind === "bad" ? "rounded-md border-2 border-destructive/60" : "rounded-md border border-border"
            }
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenIndex(isOpen ? null : index)}
                aria-expanded={isOpen}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
                <span className="text-sm font-medium text-foreground">{label}</span>
                {path && <code className="truncate text-[10px] text-muted-foreground">{path}</code>}
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
                onClick={() => remove(index)}
                aria-label={t("admin.docsSettings.pageDelete")}
              >
                ✕
              </Button>
            </div>

            {isOpen && (
              <div className="space-y-2 border-t border-border px-3 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {CONFIGURABLE_PROTOCOLS.filter((p) => p !== protocol || value.length === 1).map((p) => (
                    <Button
                      key={p}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => update(index, JSON.stringify(protocolPreset(p), null, 2))}
                      title={TEXT_PROTOCOL_LABELS[p].hint}
                    >
                      {TEXT_PROTOCOL_LABELS[p].zh}
                    </Button>
                  ))}
                </div>
                <textarea
                  value={raw}
                  onChange={(e) => update(index, e.target.value)}
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
      })}

      {!verdict.ok && (
        <ul className="space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {verdict.errors.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">{t("admin.textSpec.add")}</p>
        <div className="flex flex-wrap gap-1.5">
          {CONFIGURABLE_PROTOCOLS.filter((p) => !used.has(p)).map((p) => (
            <Button key={p} type="button" size="sm" variant="outline" onClick={() => add(p)} title={TEXT_PROTOCOL_LABELS[p].hint}>
              + {TEXT_PROTOCOL_LABELS[p].zh}
            </Button>
          ))}
          {CONFIGURABLE_PROTOCOLS.every((p) => used.has(p)) && (
            <p className="text-xs text-muted-foreground">
              {t("admin.textSpec.allAdded", { n: CONFIGURABLE_PROTOCOLS.length })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export { judgeEntry };
