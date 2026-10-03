"use client";

/**
 * src/app/(admin)/admin/providers/TextProtocolPanel.tsx
 *
 * One provider's wire protocol, as a form.
 *
 * The common case is a dropdown: a vendor speaks one of four protocols, and
 * picking it fills in a spec that already works. The text area is there for the
 * vendor who does not, and it is a textarea rather than a form of fifty inputs
 * because that is what the thing is — one document.
 *
 * The live verdict matters more than the text: an operator who cannot tell
 * whether their spec does anything will not trust it, and an invalid one that
 * looks saved is worse than one that was refused.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { parseTextSpec, TEXT_PROTOCOLS, type TextProtocol, isTextProtocol } from "@/lib/protocol/text-spec";
import { TEXT_PROTOCOL_LABELS, protocolPreset } from "@/lib/protocol/text-protocols";

interface Props {
  providerId: string;
  providerName: string;
  /** The stored spec, or null. */
  current: string | null;
}

type Verdict =
  | { kind: "none" }
  | { kind: "ok"; warnings: string[] }
  | { kind: "bad"; errors: string[] };

function judge(text: string): Verdict {
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

export function TextProtocolPanel({ providerId, providerName, current }: Props) {
  const t = useT();
  const [text, setText] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const verdict = judge(text);

  /** Fill in a preset, keeping anything the operator already wrote. */
  function applyPreset(protocol: string) {
    if (!isTextProtocol(protocol)) return;
    setText(JSON.stringify(protocolPreset(protocol as TextProtocol), null, 2));
    setMessage(null);
  }

  async function save() {
    if (verdict.kind === "bad") return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/providers/${providerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textSpec: text.trim() ? text : null }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (json?.ok) setMessage({ ok: true, text: t("admin.textSpec.saved") });
      else setMessage({ ok: false, text: json?.error?.message ?? `HTTP ${res.status}` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            {t("admin.textSpec.title")} · {providerName}
          </h4>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {t("admin.textSpec.desc")}
          </p>
        </div>
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
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMessage(null);
        }}
        rows={16}
        spellCheck={false}
        placeholder='{ "specVersion": 1, "protocol": "openai-chat" }'
        className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
      />

      {/*
        The verdict, live and in words. An operator who cannot tell whether
        their spec does anything will not save it, and one that silently does
        nothing is the failure this whole feature exists to remove.
      */}
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

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy || verdict.kind === "bad"}>
          {t("admin.docsSettings.save")}
        </Button>
        {message && (
          <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
