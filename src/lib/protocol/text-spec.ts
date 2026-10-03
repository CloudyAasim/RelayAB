/**
 * src/lib/protocol/text-spec.ts
 *
 * A text provider's wire protocol, as one declarative document.
 *
 * The media side has had this shape since `docs/模型适配协议` — transport, auth,
 * request and response mappings, error rules, limits — validated by
 * `parseMediaSpec` and checked statically by `scripts/spec-check.ts`. Text
 * providers never got one. They were described by three scattered flags
 * (`kind`, `upstreamFormat`, `openaiEnabled`), which is enough to pick an
 * endpoint and nowhere near enough to say what happens to the parameters inside
 * the request.
 *
 * The mapping tree and its `$` operators are the media engine's own
 * `applyMapping` / `getPath`, which the proxy imports directly — two evaluators
 * for one syntax is two sets of bugs. The media-only operators are refused by
 * `parseTextSpec` below, so a text spec cannot reach the network (`$fetch`) or a
 * multipart file (`$file`).
 *
 * What this module deliberately does *not* do is import that engine: it is
 * reached from a client component, and the engine reaches `node:crypto`. See
 * `TextMapping` below.
 *
 * **What is new.** A media spec produces artifacts; a text spec produces one
 * answer, streamed or not. So there is no `items`, no `encodings`, no `async`.
 * What there is instead is `protocol` — an enum of the handful of shapes text
 * providers actually speak — and `parameters`, the policy that answers the
 * question this whole file exists for: *what does the gateway do with each
 * parameter a client sends?*
 *
 * **One document, one surface.** A provider that serves two surfaces needs two
 * of these; the list that holds them is `text-specs.ts`.
 */
import { isValidSpecMapping } from "./text-spec-mapping";

/**
 * A mapping node.
 *
 * `unknown`, exactly as the media spec's own `TextMapping` is, and for the same
 * reason: the shape is checked structurally by `parseTextSpec` rather than by a
 * recursive type, because `$.a.b[0].c` is easy to write and hard to describe.
 *
 * Declared here rather than imported so this module stays **free of the media
 * engine**. It is imported by the background page's client component, and the
 * engine reaches `node:crypto` for `$fetch` — so a re-export would drag a
 * server-only module into the browser bundle and the build would fail on a
 * scheme webpack cannot resolve. The engine is used where it belongs, in the
 * proxy, and nowhere else.
 */
export type TextMapping = unknown;

/** The protocols text providers actually speak. */
export const TEXT_PROTOCOLS = [
  /** OpenAI Chat Completions. The lingua franca: most vendors expose this. */
  "openai-chat",
  /** OpenAI Responses. Codex CLI and the OpenAI SDK's `responses.create`. */
  "openai-responses",
  /** Anthropic Messages. */
  "anthropic-messages",
  /** Google Gemini `generateContent`. */
  "gemini-generate",
] as const;
export type TextProtocol = (typeof TEXT_PROTOCOLS)[number];

export function isTextProtocol(value: unknown): value is TextProtocol {
  return typeof value === "string" && (TEXT_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * What the gateway does with one parameter.
 *
 * - `passthrough` — forward whatever the client sent. **The default for
 *   anything a spec does not name.** A whitelist is how a relay starts eating
 *   parameters: a new one ships, nobody here has heard of it, and it is dropped
 *   with no error.
 * - `drop` — refuse to forward it, even if the client sent it.
 * - `default` — use `value` only when the client sent nothing. Invisible to a
 *   client that is explicit, which is the point.
 * - `force` — use `value` even when the client did send one. This is the only
 *   mode that can hand a client behaviour it did not ask for, so it is opt-in.
 * - `clamp` — keep the client's value, but hold it inside `min`/`max`.
 * - `rename` — forward it under a different name, or at a different place
 *   (`to` may be a path such as `extra_body.thinking`).
 */
export const PARAMETER_MODES = [
  "passthrough",
  "drop",
  "default",
  "force",
  "clamp",
  "rename",
] as const;
export type ParameterMode = (typeof PARAMETER_MODES)[number];

export interface ParameterRule {
  mode: ParameterMode;
  /** Used by `default` and `force`. */
  value?: unknown;
  /** Used by `clamp`. */
  min?: number;
  max?: number;
  /** Used by `rename`: where it goes. A bare name or a dotted path. */
  to?: string;
}

export interface TextSpec {
  specVersion: 1;
  protocol: TextProtocol;
  /** How the client's canonical request becomes the upstream body. */
  request?: TextMapping;
  /** How the upstream body becomes the client's answer. */
  response?: TextMapping;
  /** Per-parameter policy. Anything not named is `passthrough`. */
  parameters?: Record<string, ParameterRule>;
  /** Per-status-code error mapping, same shape as the media spec's. */
  errors?: Array<{ httpStatus?: number; code: string; message?: string; when?: TextMapping }>;
  limits?: { timeoutMs?: number };
  /** Free-form, surfaced through `/v1/models` under `relay`. */
  metadata?: Record<string, unknown>;
}

export type TextSpecParse =
  | { ok: true; spec: TextSpec; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Operators that belong to the media engine and have no meaning in text. */
const FORBIDDEN_OPERATORS = ["$fetch", "$file", "$dataUrl"] as const;

function collectOperators(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectOperators(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$")) out.add(key);
    collectOperators(child, out);
  }
  return out;
}

/**
 * Validate an operator-written text spec.
 *
 * The shape is checked structurally rather than against a recursive schema,
 * for the same reason the media spec does it that way: a hand-written
 * `$.a.b[0].c` path is easy to get right and near-impossible to describe in a
 * type, and a type that rejects a correct spec is worse than one that accepts a
 * wrong one — the operator returns `undefined` for a bad path, which drops one
 * key rather than the whole request.
 *
 * What *is* refused is anything that would reach outside the request: the
 * media operators that perform a network call or attach a file. A text spec is
 * a description of a body, not a program.
 */
export function parseTextSpec(raw: unknown): TextSpecParse {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["spec must be a JSON object"], warnings };
  }
  const spec = raw as Record<string, unknown>;

  if (spec.specVersion !== 1) {
    errors.push(`specVersion must be 1 (got ${JSON.stringify(spec.specVersion)})`);
  }
  if (!isTextProtocol(spec.protocol)) {
    errors.push(
      `protocol must be one of ${TEXT_PROTOCOLS.join(", ")} (got ${JSON.stringify(spec.protocol)})`,
    );
  }

  for (const field of ["request", "response"] as const) {
    const mapping = spec[field];
    if (mapping === undefined) continue;
    // The forbidden operators are reported *first*, by name. "request is not a
    // mapping tree" is true but useless: the operator needs to know it was
    // `$fetch` specifically, because that is the one thing about it that matters.
    for (const op of collectOperators(mapping)) {
      if ((FORBIDDEN_OPERATORS as readonly string[]).includes(op)) {
        errors.push(`${field} uses ${op}, which only makes sense for a media spec`);
      }
    }
    if (errors.length === 0 && !isValidSpecMapping(mapping)) {
      errors.push(`${field} is not a mapping tree`);
    }
  }

  const parameters = spec.parameters;
  if (parameters !== undefined) {
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      errors.push("parameters must be an object keyed by parameter name");
    } else {
      for (const [name, rule] of Object.entries(parameters as Record<string, unknown>)) {
        const why = parameterProblem(name, rule);
        if (why) errors.push(why);
      }
    }
  }

  const errors_ = spec.errors;
  if (errors_ !== undefined) {
    if (!Array.isArray(errors_)) {
      errors.push("errors must be an array");
    } else {
      errors_.forEach((entry, i) => {
        const e = entry as { code?: unknown; httpStatus?: unknown };
        if (!e || typeof e !== "object") {
          errors.push(`errors[${i}] must be an object`);
          return;
        }
        if (typeof e.code !== "string" || !e.code.trim()) {
          errors.push(`errors[${i}].code is required`);
        }
        if (e.httpStatus !== undefined && !Number.isInteger(e.httpStatus)) {
          errors.push(`errors[${i}].httpStatus must be a whole number`);
        }
      });
    }
  }

  const limits = spec.limits;
  if (limits !== undefined) {
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      errors.push("limits must be an object");
    } else {
      const timeout = (limits as { timeoutMs?: unknown }).timeoutMs;
      if (timeout !== undefined && (!Number.isInteger(timeout) || (timeout as number) <= 0)) {
        errors.push("limits.timeoutMs must be a positive whole number");
      }
    }
  }

  if (Object.keys(parameters ?? {}).length === 0) {
    warnings.push("no parameters configured: every client parameter is forwarded as sent");
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, spec: raw as TextSpec, warnings };
}

/** Why one `parameters` entry is unusable, or null. */
function parameterProblem(name: string, rule: unknown): string | null {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return `parameters.${name} must be an object`;
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.mode !== "string" || !(PARAMETER_MODES as readonly string[]).includes(r.mode)) {
    return `parameters.${name}.mode must be one of ${PARAMETER_MODES.join(", ")}`;
  }
  const mode = r.mode as ParameterMode;
  if ((mode === "default" || mode === "force") && r.value === undefined) {
    return `parameters.${name} uses ${mode} but has no value`;
  }
  if (mode === "clamp") {
    if (r.max === undefined && r.min === undefined) {
      return `parameters.${name} uses clamp but has neither min nor max`;
    }
    for (const bound of ["min", "max"] as const) {
      if (r[bound] !== undefined && typeof r[bound] !== "number") {
        return `parameters.${name}.${bound} must be a number`;
      }
    }
    if (
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      r.min > r.max
    ) {
      return `parameters.${name} clamps to an empty range`;
    }
  }
  if (mode === "rename" && (typeof r.to !== "string" || !r.to.trim())) {
    return `parameters.${name} renames but has no "to"`;
  }
  return null;
}

/**
 * A provider's spec for one surface, or null.
 *
 * Thin on purpose: the list lives in `text-specs.ts`. This stays so the proxy's
 * call site reads as one thing, and so a provider written before the list
 * existed (which stored a single document) still resolves — a lone document is
 * read as a one-entry list, whatever it declared.
 */
export function readTextSpec(provider: {
  textSpecs?: readonly string[] | null;
  textSpec?: string | null;
}): TextSpec | null {
  const raws = provider.textSpecs?.length ? provider.textSpecs : provider.textSpec ? [provider.textSpec] : [];
  for (const raw of raws) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = parseTextSpec(parsed);
    if (result.ok) return result.spec;
  }
  return null;
}
