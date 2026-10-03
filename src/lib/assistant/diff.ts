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
import type { DocPage } from "../docs/custom";
import { surfaceOf } from "../protocol/text-specs";

/** Stored documents keyed by the interface they govern, for a before/after. */
function byProtocol(raws: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of raws) {
    try {
      const protocol = (JSON.parse(raw) as { protocol?: string }).protocol;
      if (typeof protocol === "string") out.set(protocol, raw);
    } catch {
      // Unparseable stored bytes are listed as absent, which is how the editor
      // treats them too: kept in the row, not shown as a working rule.
    }
  }
  return out;
}

function line(field: string, before: unknown, after: unknown): string | null {
  const b = format(before);
  const a = format(after);
  if (b === a) return null;
  return `  ${field}\n    - ${b}\n    + ${a}`;
}

/**
 * Diff a field only when the patch actually names it.
 *
 * A patch that omits `baseUrl` leaves it alone — `updateProvider` merges
 * `patch.baseUrl ?? existing.baseUrl`. Rendering the omission as
 * "- <current>  + (未设置)" would claim the change wipes a field it never
 * touches, and the diff is what the admin is asked to trust.
 */
function patchedLine(
  patch: Record<string, unknown>,
  field: string,
  before: unknown,
): string | null {
  if (!(field in patch)) return null;
  return line(field, before, patch[field]);
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
export function renderProviderDiff(
  provider: Provider,
  patch: Record<string, unknown>,
  summary?: string,
): string {
  const out: string[] = [
    `服务商：${provider.name}  (${provider.id})`,
    `变更摘要：${summary ?? "(未填写)"}`,
    "",
  ];

  out.push(
    ...section("字段变更", [
      patchedLine(patch, "baseUrl", provider.baseUrl),
      patchedLine(patch, "anthropicBaseUrl", provider.anthropicBaseUrl ?? null),
      patchedLine(patch, "openaiEnabled", provider.openaiEnabled),
      patchedLine(patch, "anthropicEnabled", provider.anthropicEnabled),
      patchedLine(patch, "enabled", provider.enabled),
      patchedLine(patch, "priority", provider.priority),
      patchedLine(patch, "upstreamFormat", provider.upstreamFormat),
    ]),
  );

  if (patch.headers !== undefined) {
    const before = provider.headers ?? {};
    const after = (patch.headers as Record<string, string>) ?? {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    out.push("请求头：");
    if (keys.length === 0) {
      out.push("  （无）");
    }
    for (const k of keys) {
      if (before[k] === after[k]) out.push(`  = ${k}: ${after[k]}`);
      else if (!(k in after)) out.push(`  - ${k}: ${before[k]}`);
      else if (!(k in before)) out.push(`  + ${k}: ${after[k]}`);
      else out.push(`  ~ ${k}: ${before[k]} → ${after[k]}`);
    }
  }

  // The protocols, by interface.
  //
  // This was missing entirely, which is part of why a protocol proposal could
  // be approved without anything showing: the diff said a field changed and
  // listed no field, because `textSpec` was never rendered here. A diff the
  // administrator reads to decide is the last place a change can be invisible.
  if (patch.textSpecs !== undefined) {
    const before = byProtocol(provider.textSpecs ?? []);
    const after = byProtocol((patch.textSpecs as string[]) ?? []);
    const added = [...after.keys()].filter((p) => !before.has(p));
    const removed = [...before.keys()].filter((p) => !after.has(p));
    const changed = [...after.keys()].filter(
      (p) => before.has(p) && before.get(p) !== after.get(p),
    );
    out.push("");
    out.push("上游协议（按兼容接口）：");
    for (const p of added) out.push(`  + ${p}${surfaceOf(p) ? `  (${surfaceOf(p)})` : ""}`);
    for (const p of changed) out.push(`  ~ ${p}  参数规则已改写`);
    for (const p of removed) out.push(`  - ${p}  已删除，回到原样透传`);
    if (!added.length && !changed.length && !removed.length) out.push("  （无变化）");
  }

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
  summary?: string,
): string {
  const out: string[] = [
    `媒体服务商：${provider.name}  (${provider.id})`,
    `变更摘要：${summary ?? "(未填写)"}`,
    "",
  ];

  out.push(
    ...section("字段变更", [
      patchedLine(patch, "baseUrl", provider.baseUrl),
      patchedLine(patch, "enabled", provider.enabled),
      patchedLine(patch, "priority", provider.priority),
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

/**
 * Same shape, for the operator's documentation chapter.
 *
 * The removal list is the part that matters here. `propose_doc_pages` is a
 * whole-list replacement, so an admin approving a diff that quietly shows
 * "新增 x" while dropping four pages has been shown a lie by omission — and
 * those four pages are the operator's own writing.
 */
export function renderDocPagesDiff(
  before: readonly DocPage[],
  after: readonly DocPage[],
  summary?: string,
): string {
  const out: string[] = [
    `用户文档自定义页面：${before.length} → ${after.length} 页`,
    `变更摘要：${summary ?? "(未填写)"}`,
    "",
  ];

  const beforeById = new Map(before.map((p) => [p.id, p]));
  const afterById = new Map(after.map((p) => [p.id, p]));

  const added = after.filter((p) => !beforeById.has(p.id));
  const removed = before.filter((p) => !afterById.has(p.id));
  const changed = after.filter((p) => {
    const prev = beforeById.get(p.id);
    return prev && (prev.title !== p.title || prev.body !== p.body || Boolean(prev.hidden) !== Boolean(p.hidden));
  });

  out.push("字段变更：");
  if (!added.length && !removed.length && !changed.length) out.push("    （无）");
  for (const p of added) {
    out.push(`    + 新增 ${p.id}「${p.title}」${p.hidden ? "（草稿，读者看不到）" : ""}`);
  }
  for (const p of changed) {
    out.push(`    ~ 修改 ${p.id} 标题或正文`);
  }
  for (const p of removed) {
    out.push(`    - 删除 ${p.id}「${p.title}」`);
  }
  out.push("");

  if (removed.length) {
    out.push(
      `提醒：这一次会真的删掉上面 ${removed.length} 个页面。它们是站长自己写的文字，删了不会留在任何地方。`,
      "",
    );
  }
  out.push("注意：id 是读者能收藏的锚点，发布后不要再改。");
  return out.join("\n");
}
