"use client";

/**
 * src/app/(admin)/admin/providers/TextProtocolField.tsx
 *
 * A provider's wire protocol, as an editor.
 *
 * **A field, not a page.** It used to be a block under the provider table, which
 * meant the two things you configure together — which endpoint this vendor is,
 * and what it does with the parameters in a request — lived on two screens, and
 * the harder half was the one you had to go looking for.
 *
 * So the provider editor offers two modes:
 *
 *  - **simple**: pick the endpoint and the models. Right for the ninety percent
 *    of OpenAI-compatible vendors, and unchanged from before.
 *  - **advanced**: declare the protocol and what the gateway does with each
 *    request parameter. For a vendor that is not quite OpenAI.
 *
 * They are separate fields on the same row, not two views of one thing: the
 * simple form's face flags choose *which endpoint* is called, the protocol
 * governs *what happens to the parameters* on the way. A provider can have
 * both, and editing one does not clear the other.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import {
  parseTextSpec,
  TEXT_PROTOCOLS,
  type TextProtocol,
  isTextProtocol,
} from "@/lib/protocol/text-spec";
import { TEXT_PROTOCOL_LABELS, protocolPreset } from "@/lib/protocol/text-protocols";

export type ProtocolVerdict =
  | { kind: "none" }
  | { kind: "ok"; warnings: string[] }
  | { kind: "bad"; errors: string[] };

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

/** The two ways to configure a provider, and which one is open. */
export function ProviderModeSwitch({
  mode,
  onChange,
  hasSpec,
}: {
  mode: "simple" | "advanced";
  onChange: (mode: "simple" | "advanced") => void;
  hasSpec: boolean;
}) {
  const t = useT();
  return (
    <div className="flex gap-1 rounded-md bg-muted/60 p-1">
      {(
        [
          ["simple", t("admin.textSpec.mode.simple")],
          ["advanced", hasSpec ? t("admin.textSpec.mode.advancedSet") : t("admin.textSpec.mode.advanced")],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={mode === id}
          className={
            mode === id
              ? "flex-1 rounded px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
              : "flex-1 rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The protocol editor, with no button of its own.
 *
 * The parent's form submits, so the provider's name and key are saved or not
 * saved together with the spec. A protocol is part of a provider, and a save
 * button that could commit one without the other is how they drift.
 */
export function TextProtocolField({
  value,
  onChange,
  providerName,
}: {
  value: string;
  onChange: (next: string) => void;
  providerName: string;
}) {
  const t = useT();
  const verdict = judgeTextSpec(value);

  function applyPreset(protocol: string) {
    if (!isTextProtocol(protocol)) return;
    onChange(JSON.stringify(protocolPreset(protocol as TextProtocol), null, 2));
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">{t("admin.textSpec.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("admin.textSpec.desc")}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TEXT_PROTOCOLS.map((protocol) => (
          <Button
            key={protocol}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPreset(protocol)}
            title={TEXT_PROTOCOL_LABELS[protocol].hint}
          >
            {TEXT_PROTOCOL_LABELS[protocol].zh}
          </Button>
        ))}
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={14}
        spellCheck={false}
        aria-label={t("admin.textSpec.title")}
        placeholder='{ "specVersion": 1, "protocol": "openai-chat" }'
        className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
      />

      {verdict.kind === "bad" && (
        <ul className="space-y-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {verdict.errors.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      )}
      {verdict.kind === "ok" && verdict.warnings.length > 0 && (
        <ul className="space-y-0.5 rounded-md bg-warning/10 p-2 text-xs text-warning-foreground">
          {verdict.warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      )}
      {verdict.kind === "none" && (
        <p className="text-xs text-muted-foreground">{t("admin.textSpec.none")}</p>
      )}
      {verdict.kind === "ok" && verdict.warnings.length === 0 && (
        <p className="text-xs text-green-600">{t("admin.textSpec.valid")}</p>
      )}
    </div>
  );
}
