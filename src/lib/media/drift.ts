/**
 * src/lib/media/drift.ts
 *
 * Has a stored spec fallen behind the template it came from?
 *
 * A media spec is stored as JSON text in the provider row, and a template is a
 * value in this file. Those are two copies of the same thing with nothing
 * between them, so when the code moves the stored copy stays behind and says
 * nothing. That is not a hypothetical: a change to `MINIMAX_STT_SPEC` was made,
 * deployed, and did not reach production, because production was running a
 * different copy of the spec the whole time. Nothing failed. The only symptom
 * was a call that kept returning the same error while the fix sat in the
 * repository being correct.
 *
 * So the question is answered here rather than by asking somebody to paste a
 * configuration. An operator edits a spec; the next read of it says whether it
 * still matches the template, and if not, which paths moved.
 *
 * The diff is deliberately one-directional. A path the *template* has and the
 * stored spec lacks, or has at a different value, is the interesting one: that is
 * where a change in this file failed to land. Operator additions are not
 * reported, because an operator is entitled to their own additions and reporting
 * them would train people to ignore the output.
 */
import { MEDIA_TEMPLATES } from "./seeds";
import type { MediaSpec } from "./spec";

export type SpecDrift =
  /** Byte-identical to the template as it stands in this build. */
  | { kind: "in-sync"; templateId: string }
  /**
   * Corresponds to a template, but the stored copy is behind it. `paths` are
   * dotted locations where the template and the stored spec disagree — the paths
   * a reader should look at first.
   */
  | { kind: "differs"; templateId: string; paths: string[] }
  /** Matches no template. Hand-written, or from a template this build dropped. */
  | { kind: "no-template" };

/** Deep enough for a spec, shallow enough that a runaway object cannot flood it. */
const MAX_DEPTH = 8;
const MAX_PATHS = 40;

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
 * Only paths the template actually has are walked into: a key that exists solely
 * in the stored copy is an operator's addition, and reporting it would make every
 * hand-written spec look like a divergence to be resolved.
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
    // Arrays are compared element-wise only as far as the template defines them; a
    // longer stored array is a deliberate addition, not a drift.
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
  // A key the stored copy has and the template dropped is worth one line, without
  // walking into it: the template no longer believes in it. This is the shape a
  // removal takes in the stored copy — the field is still there, doing whatever
  // the old template told it to do — so it is the case most worth being loud
  // about, and the path has to be the full one or it is not locatable.
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
 * Correspondence is by capability, not by name: `displayName` is editable and a
 * template with two video specs has two specs of the same capability, so models
 * are used to pick between them where the template scopes by model.
 */
export function specDrift(stored: MediaSpec): SpecDrift {
  for (const [templateId, template] of Object.entries(MEDIA_TEMPLATES)) {
    for (const candidate of template.specs) {
      if (candidate.capability !== stored.capability) continue;
      if (canonical(candidate) === canonical(stored)) {
        return { kind: "in-sync", templateId };
      }
    }
  }

  // No exact match, so look for the template this one was built from: same
  // capability, and — where the template scopes by model — the same model.
  const storedModels = new Set(stored.models ?? []);
  for (const [templateId, template] of Object.entries(MEDIA_TEMPLATES)) {
    for (const candidate of template.specs) {
      if (candidate.capability !== stored.capability) continue;
      if (candidate.models?.length) {
        const overlaps = candidate.models.some((m) => storedModels.has(m));
        if (!overlaps) continue;
      }
      const paths: string[] = [];
      divergingPaths(candidate, stored, "", paths);
      if (paths.length === 0) return { kind: "in-sync", templateId };
      return { kind: "differs", templateId, paths };
    }
  }

  return { kind: "no-template" };
}

/** Every spec of a provider, with its verdict. Order follows the stored list. */
export function providerDrift(
  specs: MediaSpec[] | undefined,
): Array<{ spec: MediaSpec; drift: SpecDrift }> {
  return (specs ?? []).map((spec) => ({ spec, drift: specDrift(spec) }));
}

/**
 * One line per diverged spec, for a report a person or a model reads.
 *
 * Empty when nothing has fallen behind, which is the overwhelmingly common case
 * and must not turn into noise.
 */
export function driftReport(
  providers: Array<{ name: string; specs: MediaSpec[] | undefined }>,
): string[] {
  const lines: string[] = [];
  for (const provider of providers) {
    for (const { spec, drift } of providerDrift(provider.specs)) {
      if (drift.kind !== "differs") continue;
      lines.push(
        `${provider.name} / ${spec.capability}（${spec.displayName}）：` +
          `已与当前模板「${drift.templateId}」不一致，共 ${drift.paths.length} 处`,
      );
      for (const p of drift.paths) lines.push(`  - ${p}`);
    }
  }
  return lines;
}
