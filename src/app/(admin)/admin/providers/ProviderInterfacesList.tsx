"use client";

/**
 * src/app/(admin)/admin/providers/ProviderInterfacesList.tsx
 *
 * What the gateway does with each interface's parameters. **Advanced mode
 * only.**
 *
 * One row per compatibility interface, flat and ungrouped. The grouping that
 * used to be here — under a face toggle — went away with the toggle: with no
 * switch beside it, a heading that says "these answer" has nothing to say that
 * the client path does not already say, and it is one more thing that can read
 * as a control.
 *
 * The rows are always all three, and a row is never disabled. A rule here is
 * not a routing decision: the faces decide what answers, and they are set in
 * simple mode. So the two modes are alternatives rather than halves of one
 * form, and neither can contradict the other on screen.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { isTextProtocol, parseTextSpec, type TextProtocol } from "@/lib/protocol/text-spec";
import { SURFACES, validateTextSpecs } from "@/lib/protocol/text-specs";
import { TEXT_PROTOCOL_LABELS, protocolPreset } from "@/lib/protocol/text-protocols";

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

/**
 * The rule written for one interface, as its raw stored string.
 *
 * Read from the raw column rather than a parsed form so an entry that no longer
 * parses still shows as a broken row to be fixed, instead of silently
 * disappearing from the editor the way a parse-and-filter would drop it.
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

export function ProviderInterfacesList({
  textSpecs,
  onTextSpecsChange,
}: {
  textSpecs: string[];
  onTextSpecsChange: (next: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);

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

  const written = SURFACES.filter((s) => ruleFor(textSpecs, s.id) !== undefined).length;
  const verdict = validateTextSpecs(textSpecs);

  return (
    <div>
      <p className="mb-1 text-sm font-medium">{t("admin.textSpec.title")}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t("admin.textSpec.desc")}</p>

      {written === 0 && (
        <p className="mb-3 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          {t("admin.textSpec.none")}
        </p>
      )}

      <div className="space-y-2">
        {SURFACES.map((s) => (
          <InterfaceRow
            key={s.id}
            protocol={s.id}
            clientPath={s.clientPath}
            raw={ruleFor(textSpecs, s.id)}
            open={open === s.id}
            onToggle={() => setOpen(open === s.id ? null : s.id)}
            onPut={(raw) => put(s.id, raw)}
            onDrop={() => {
              drop(s.id);
              setOpen(null);
            }}
          />
        ))}
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {written === SURFACES.length
          ? t("admin.textSpec.allConfigured", { n: SURFACES.length })
          : t("admin.textSpec.configuredCount", { n: written, total: SURFACES.length })}
      </p>

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
 * One interface and its rule.
 *
 * No protocol picker: the row already *is* one interface, so "which protocol is
 * this" has no answer left to get wrong.
 */
function InterfaceRow({
  protocol,
  clientPath,
  raw,
  open,
  onToggle,
  onPut,
  onDrop,
}: {
  protocol: string;
  clientPath: string;
  raw: string | undefined;
  open: boolean;
  onToggle: () => void;
  onPut: (raw: string) => void;
  onDrop: () => void;
}) {
  const t = useT();
  const label = isTextProtocol(protocol) ? TEXT_PROTOCOL_LABELS[protocol as TextProtocol].zh : protocol;
  const entry = raw === undefined ? { kind: "none" as const } : judgeTextSpec(raw);

  if (raw === undefined) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (isTextProtocol(protocol)) onPut(JSON.stringify(protocolPreset(protocol), null, 2));
              onToggle();
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
            <span className="text-xs font-medium text-foreground">{label}</span>
            <code className="truncate text-[10px] text-muted-foreground">{clientPath}</code>
          </button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={t("admin.textSpec.add")}
            onClick={() => {
              if (isTextProtocol(protocol)) onPut(JSON.stringify(protocolPreset(protocol), null, 2));
              onToggle();
            }}
          >
            {t("admin.textSpec.add")}
          </Button>
        </div>
        <p className="mt-1 pl-4 text-[11px] text-muted-foreground">
          {t("admin.textSpec.defaultNote")}
        </p>
        {open && raw !== undefined && (
          <RuleBody raw={raw} label={label} entry={entry} onPut={onPut} />
        )}
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
          onClick={onToggle}
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
          aria-label={t("admin.textSpec.remove")}
        >
          ✕
        </Button>
      </div>

      {open && <RuleBody raw={raw} label={label} entry={entry} onPut={onPut} />}
    </div>
  );
}

function RuleBody({
  raw,
  label,
  entry,
  onPut,
}: {
  raw: string;
  label: string;
  entry: ProtocolVerdict;
  onPut: (raw: string) => void;
}) {
  return (
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
  );
}
