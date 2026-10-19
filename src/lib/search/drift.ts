/**
 * src/lib/search/drift.ts
 *
 * Has a stored search spec fallen behind the template it came from?
 *
 * The same question the media protocol asks, and for the same reason: a spec is
 * stored as JSON text in the provider row and a template is a value in the
 * code. Those are two copies of the same thing with nothing between them, so
 * when the code moves the stored copy stays behind and says nothing.
 *
 * The difference is deliberately one-directional. A path the *template* has and
 * the stored spec lacks, or has at a different value, is the interesting one:
 * that is where a change in this file failed to land. Operator additions are
 * not reported, because an operator is entitled to their own additions and
 * reporting them would train people to ignore the output.
 *
 * ## What is compared
 *
 * `transport`, `auth`, `response` and `limits` — the parts that decide what is
 * sent and how the answer is read. `displayName` and `baseUrl` are **not**:
 * the first is the operator's own wording for the backend and the second is
 * their own address, and neither is a template's business. Comparing them
 * would report every renamed backend as a divergence, which is the way a drift
 * report turns into noise.
 */
import { SEARCH_TEMPLATES, type SearchTemplate } from "./templates";
import type { SearchSpec } from "./spec";

export type SpecDrift =
  /** Matches the template as it stands in this build. */
  | { kind: "in-sync"; templateId: string }
  /**
   * Corresponds to a template, but the stored copy is behind it. `paths` are
   * dotted locations where the template and the stored spec disagree — the
   * paths a reader should look at first.
   */
  | { kind: "differs"; templateId: string; paths: string[] }
  /** Matches no template. Hand-written, or from a template this build dropped. */
  | { kind: "no-template" };

/** Deep enough for a spec, shallow enough that a runaway object cannot flood it. */
const MAX_DEPTH = 8;
const MAX_PATHS = 40;

/** The parts of a spec a template is allowed to have an opinion about. */
function comparable(spec: SearchSpec): Record<string, unknown> {
  return {
    transport: spec.transport,
    auth: spec.auth ?? null,
    response: spec.response,
    limits: spec.limits ?? null,
  };
}

/** Stable stringify, so key order cannot read as a difference. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** One-line rendering of a value, for a report a model or a person reads. */
function brief(value: unknown): string {
  const s = canonical(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Paths where `template` and `stored` disagree, template-first.
 *
 * Only paths the template actually has are walked into: a key that exists
 * solely in the stored copy is an operator's addition.
 */
function divergingPaths(
  template: unknown,
  stored: unknown,
  prefix: string,
  out: string[],
  depth = 0,
): void {
  if (out.length >= MAX_PATHS || depth > MAX_DEPTH) return;
  if (canonical(template) === canonical(stored)) return;

  if (Array.isArray(template) || Array.isArray(stored)) {
    if (!Array.isArray(template) || !Array.isArray(stored)) {
      out.push(`${prefix || "$"}  模板=${brief(template)}  已存=${brief(stored)}`);
      return;
    }
    template.forEach((item, i) => {
      if (i < stored.length) divergingPaths(item, stored[i], `${prefix}[${i}]`, out, depth + 1);
    });
    return;
  }

  const tRecord =
    template && typeof template === "object" ? (template as Record<string, unknown>) : null;
  const sRecord =
    stored && typeof stored === "object" ? (stored as Record<string, unknown>) : null;
  if (!tRecord || !sRecord) {
    out.push(`${prefix || "$"}  模板=${brief(template)}  已存=${brief(stored)}`);
    return;
  }

  for (const [key, tValue] of Object.entries(tRecord)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in sRecord)) {
      out.push(`${path}  模板=${brief(tValue)}  已存=（没有这个字段）`);
      continue;
    }
    divergingPaths(tValue, sRecord[key], path, out, depth + 1);
  }
  for (const key of Object.keys(sRecord)) {
    if (out.length >= MAX_PATHS) return;
    if (key in tRecord) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(`${path}  模板=（已删除）  已存=${brief(sRecord[key])}`);
  }
}

/**
 * Which template does this spec correspond to, and has it fallen behind?
 *
 * Correspondence is by vendor: a search spec describes one vendor's web search
 * endpoint, so the vendor is what identifies the template it came from. A spec
 * with no vendor — or one naming a vendor this build has no template for — is
 * hand-written, and saying so is more useful than guessing.
 */
export function specDrift(stored: SearchSpec): SpecDrift {
  const vendor = stored.vendor;
  const candidates = SEARCH_TEMPLATES.filter(
    (template) => template.spec.vendor === vendor || template.id === vendor,
  );

  for (const template of candidates) {
    if (canonical(comparable(template.spec)) === canonical(comparable(stored))) {
      return { kind: "in-sync", templateId: template.id };
    }
  }

  for (const template of candidates) {
    const paths: string[] = [];
    divergingPaths(comparable(template.spec), comparable(stored), "", paths);
    if (paths.length === 0) return { kind: "in-sync", templateId: template.id };
    return { kind: "differs", templateId: template.id, paths };
  }

  return { kind: "no-template" };
}

/**
 * One line per diverged spec, for a report a person or a model reads.
 *
 * Empty when nothing has fallen behind, which is the overwhelmingly common
 * case and must not turn into noise.
 */
export function driftReport(
  providers: Array<{ name: string; spec: SearchSpec | undefined }>,
): string[] {
  const lines: string[] = [];
  for (const provider of providers) {
    if (!provider.spec) continue;
    const drift = specDrift(provider.spec);
    if (drift.kind !== "differs") continue;
    lines.push(
      `${provider.name}：已与当前模板「${drift.templateId}」不一致，共 ${drift.paths.length} 处`,
    );
    for (const p of drift.paths) lines.push(`  - ${p}`);
  }
  return lines;
}

/** The template a spec came from, when it is one this build still ships. */
export function templateForSpec(spec: SearchSpec): SearchTemplate | null {
  const drift = specDrift(spec);
  if (drift.kind === "no-template") return null;
  return SEARCH_TEMPLATES.find((template) => template.id === drift.templateId) ?? null;
}
