/**
 * src/lib/assistant/diff.ts
 *
 * Renders a proposed change as text an admin can actually check.
 *
 * The assistant's proposals are reviewed by a human before they touch
 * production, so the diff is the whole safety mechanism. It is deliberately a
 * plain string rather than a structured object: it is stored alongside the
 * action (so the decision outlives the page), shown in the UI, and handed back
 * to the model so it can explain exactly what it wants changed.
 */
import type { Provider } from "../db/types";
import type { MediaProvider } from "../media/spec";

function line(field: string, before: unknown, after: unknown): string | null {
  const b = format(before);
  const a = format(after);
  if (b === a) return null;
  return `  ${field}\n    - ${b}\n    + ${a}`;
}

function format(value: unknown): string {
  if (value === undefined) return "(未设置)";
  if (value === null) return "(空)";
  if (typeof value === "string") return value === "" ? "(空)" : value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function section(title: string, lines: Array<string | null>): string[] {
  const present = lines.filter((l): l is string => l !== null);
  return present.length === 0 ? [] : [title, ...present, ""];
}

/**
 * What a `propose_provider_update` would do.
 *
 * `patch` is the exact object that will be handed to `updateProvider`, so the
 * before-state has to be read off the *current* row — a diff against anything
 * else is worse than no diff, because it looks authoritative.
 */
export function renderProviderDiff(provider: Provider, patch: Record<string, unknown>): string {
  const out: string[] = [
    `服务商：${provider.name}  (${provider.id})`,
    `变更摘要：${String(patch.__summary ?? "(未填写)")}`,
    "",
  ];

  out.push(
    ...section("字段变更", [
      line("baseUrl", provider.baseUrl, patch.baseUrl),
      line(
        "anthropicBaseUrl",
        provider.anthropicBaseUrl,
        patch.anthropicBaseUrl === undefined ? undefined : patch.anthropicBaseUrl,
      ),
      line("openaiEnabled", provider.openaiEnabled, patch.openaiEnabled),
      line("anthropicEnabled", provider.anthropicEnabled, patch.anthropicEnabled),
      line("enabled", provider.enabled, patch.enabled),
    ]),
  );

  if (patch.modelMapping) {
    const before = new Set(Object.keys(provider.modelMapping ?? {}));
    const after = new Set(Object.keys(patch.modelMapping as Record<string, string>));
    const added = [...after].filter((m) => !before.has(m));
    const removed = [...before].filter((m) => !after.has(m));
    const kept = [...after].filter((m) => before.has(m));

    out.push("模型映射：");
    if (added.length) out.push(`    + 新增 ${added.join(", ")}`);
    if (removed.length) out.push(`    - 移除 ${removed.join(", ")}`);
    if (kept.length) out.push(`      保留 ${kept.join(", ")}`);
    if (!added.length && !removed.length) out.push("      （与当前一致）");
    out.push("");
  }

  // The context-window check the diff exists to make visible: a model whose
  // advertised context collapses would quietly reject large prompts upstream.
  if (patch.modelConfigs) {
    const configs = patch.modelConfigs as Record<string, { contextLength?: number; maxOutputTokens?: number }>;
    const before = provider.modelConfigs ?? {};
    const rows: string[] = [];
    for (const [id, cfg] of Object.entries(configs)) {
      const prev = before[id];
      if (prev?.contextLength === cfg.contextLength && prev?.maxOutputTokens === cfg.maxOutputTokens) {
        continue;
      }
      rows.push(
        `      ${id}: 上下文 ${fmtNum(prev?.contextLength)} → ${fmtNum(cfg.contextLength)}，` +
          `输出 ${fmtNum(prev?.maxOutputTokens)} → ${fmtNum(cfg.maxOutputTokens)}`,
      );
    }
    if (rows.length) {
      out.push("上下文窗口：", ...rows, "");
    }
  }

  out.push("注意：本次变更不会触碰加密密钥。");
  return out.join("\n");
}

/** Same shape, for a media provider. */
export function renderMediaDiff(
  provider: MediaProvider,
  patch: Record<string, unknown>,
): string {
  const out: string[] = [
    `媒体服务商：${provider.name}  (${provider.id})`,
    `变更摘要：${String(patch.__summary ?? "(未填写)")}`,
    "",
  ];

  out.push(
    ...section("字段变更", [
      line("baseUrl", provider.baseUrl, patch.baseUrl),
      line("enabled", provider.enabled, patch.enabled),
    ]),
  );

  if (patch.models) {
    const before = new Set(Object.keys(provider.models ?? {}));
    const after = new Set(Object.keys(patch.models as Record<string, unknown>));
    const added = [...after].filter((m) => !before.has(m));
    const removed = [...before].filter((m) => !after.has(m));
    if (added.length || removed.length) {
      out.push("模型：");
      if (added.length) out.push(`    + 新增 ${added.join(", ")}`);
      if (removed.length) out.push(`    - 移除 ${removed.join(", ")}`);
      out.push("");
    }
  }

  if (patch.specs) {
    const before = (provider.specs ?? []).length;
    const after = (patch.specs as unknown[]).length;
    out.push(...section("spec 数量", [line("specs", before, after)]));
    for (const s of patch.specs as Array<{
      capability?: string;
      transport?: { method?: string; path?: string };
    }>) {
      out.push(
        `      ${s.capability ?? "?"}  ${s.transport?.method ?? ""} ${s.transport?.path ?? ""}`.trimEnd(),
      );
    }
    if (after) out.push("");
  }

  out.push("注意：本次变更不会触碰加密密钥。");
  return out.join("\n");
}

function fmtNum(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString() : "(未设置)";
}
