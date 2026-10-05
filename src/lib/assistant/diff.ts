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
import { ASSISTANT_PAGE_READ_LIMIT } from "./docs-reader";

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

  /**
   * Every model field that actually changed, and what it changes from.
   *
   * This section used to render the context window and nothing else, so a
   * proposal that repriced a model produced a diff that mentioned no price at
   * all — the administrator was asked to approve a production billing change on
   * a document that did not describe it. The only price in the output was
   * whatever the model had happened to type into the summary, which is the one
   * part of the screen nobody can rely on.
   *
   * Rendered per field, from the two sides, because the whole reason this
   * endpoint exists is that approving is a decision made by reading.
   */
  if (patch.modelConfigs) {
    const configs = patch.modelConfigs as Record<string, Record<string, unknown>>;
    const before = provider.modelConfigs ?? {};
    const rows: string[] = [];

    for (const [id, cfg] of Object.entries(configs)) {
      const prev = (before[id] ?? {}) as Record<string, unknown>;
      const changed = MODEL_DIFF_FIELDS.filter(
        (f) => f.key in cfg && !sameValue(prev[f.key], cfg[f.key]),
      );
      // A model entry carried but not altered is not news, and nine identical
      // rows of "unchanged" is how a real change gets lost in the list.
      if (!changed.length) continue;
      rows.push(`      ${id}:`);
      for (const f of changed) {
        rows.push(
          `        ${f.label}：${fmtModelValue(prev[f.key])} → ${fmtModelValue(cfg[f.key])}`,
        );
      }
    }
    if (rows.length) {
      out.push("模型配置：", ...rows, "");
    }
  }

  out.push("注意：本次变更不会触碰加密密钥。");
  return out.join("\n");
}

/**
 * The per-model fields a diff reports, in the order an operator reads them.
 *
 * Every field a write path accepts, so a change cannot be invisible by being
 * unexpected — the one thing a confirmation screen must not do.
 */
const MODEL_DIFF_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "enabled", label: "启用" },
  { key: "upstreamId", label: "上游模型名" },
  { key: "displayName", label: "显示名" },
  { key: "contextLength", label: "上下文" },
  { key: "maxOutputTokens", label: "最大输出" },
  { key: "reasoningLevels", label: "思考等级" },
  { key: "reasoningEffortSupported", label: "支持思考等级" },
  { key: "inputCost", label: "输入积分/百万 token" },
  { key: "outputCost", label: "输出积分/百万 token" },
  { key: "cachedInputCost", label: "缓存读积分/百万 token" },
  { key: "cacheWriteCost", label: "缓存写积分/百万 token" },
];

/** Deep-enough equality for the values these fields hold. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  // `undefined` and `null` are different stored states — one is "never set",
  // the other "set to nothing" — so they are not the same value here.
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return false;
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
 * A model field's value, for a line an operator is asked to make a decision on.
 *
 * `fmtNum` answers only for numbers, and a model row is not only numbers: a
 * proposal that switches thinking levels off has a boolean in it, and one that
 * replaces the level list has an array. Rendering either as "(未设置)" put two
 * identical words on both sides of an arrow, which is the one thing a diff must
 * never do — it says the value did not change while showing that it did.
 */
function fmtModelValue(v: unknown): string {
  if (v === undefined) return "(未设置)";
  if (v === null) return "(空)";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "boolean") return v ? "是" : "否";
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(" / ") : "（空列表）";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
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

  /*
   * A page the assistant cannot finish reading.
   *
   * Storage allows 60,000 characters and the reader cuts at 20,000, so anything
   * between the two is a page a browser renders whole and the assistant reads
   * half of — silently, because the cut is followed by a marker rather than an
   * error. That is the shape a 327-row voice list takes, and it is why a
   * reference the operator can see and the model cannot is a plausible thing to
   * approve by accident.
   *
   * Not a rejection: the reader-facing page is genuinely fine, and refusing it
   * would take away a capability the admin form legitimately has. It is said out
   * loud in the diff the admin reads, which is the only place it can still be
   * acted on.
   */
  const tooLong = after.filter((p) => p.body.length > ASSISTANT_PAGE_READ_LIMIT);
  if (tooLong.length) {
    out.push(
      `⚠ 以下页面正文超过 ${ASSISTANT_PAGE_READ_LIMIT.toLocaleString()} 字符，` +
        `助手读它时会被截断（页面上仍然完整显示）：` +
        tooLong.map((p) => ` ${p.id}（${p.body.length.toLocaleString()} 字符）`).join("、") +
        `。建议按语言或能力拆成多页，一页一类。`,
      "",
    );
  }

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
