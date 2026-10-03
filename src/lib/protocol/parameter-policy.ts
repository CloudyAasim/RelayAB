/**
 * src/lib/protocol/parameter-policy.ts
 *
 * What the gateway does with each parameter a client sends.
 *
 * This is the piece that makes request parameters controllable, and the reason
 * it is a separate module from the mapping engine is that it runs **before** any
 * translation: a policy decides what survives, and only then does a spec decide
 * what the surviving values are called on the wire.
 *
 * The default is `passthrough`. That is the load-bearing decision. A gateway
 * whose default is "drop anything I do not recognise" loses parameters every
 * time a vendor ships a new one, silently, and the symptom is a client that
 * believes it asked for high reasoning and got something else. An operator who
 * wants a closed set writes the rules; nobody has to.
 */
import type { ParameterRule, TextSpec } from "./text-spec";

/** What happened to one parameter, for the docs page and for tests. */
export interface PolicyDecision {
  name: string;
  action: "kept" | "dropped" | "defaulted" | "forced" | "clamped" | "renamed";
  value?: unknown;
  /** Set when the client's value was replaced. */
  from?: unknown;
  note?: string;
}

export interface PolicyResult {
  body: Record<string, unknown>;
  decisions: PolicyDecision[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Write `value` at a dotted path, creating the objects on the way. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!isPlainObject(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** Read a dotted path out of a body. */
export function getAt(body: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cursor: unknown = body;
  for (const part of parts) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Apply a spec's `parameters` policy to a request body.
 *
 * Order matters and is fixed:
 *
 *  1. a parameter named by a `drop` rule is removed and never reconsidered —
 *     "drop" has to mean drop, or an operator cannot close a field;
 *  2. `default` applies only where the client sent nothing;
 *  3. `clamp` holds the client's own value inside the bounds;
 *  4. `force` replaces whatever is there;
 *  5. `rename` moves the value, removing it from its original name.
 *
 * A `force` therefore beats a `clamp` on the same parameter, and the decisions
 * list records both, so a background page can show which rule actually won.
 */
export function applyParameterPolicy(
  body: Record<string, unknown>,
  spec: Pick<TextSpec, "parameters"> | undefined,
): PolicyResult {
  const out: Record<string, unknown> = { ...body };
  const decisions: PolicyDecision[] = [];
  const rules = spec?.parameters ?? {};

  for (const [name, rule] of Object.entries(rules)) {
    if (!isPlainObject(rule)) continue;
    const mode = (rule as ParameterRule).mode;
    const current = out[name];
    const had = name in out;

    switch (mode) {
      case "drop": {
        if (had) {
          delete out[name];
          decisions.push({ name, action: "dropped", from: current });
        }
        break;
      }
      case "default": {
        if (had) {
          decisions.push({ name, action: "kept", value: current });
        } else {
          out[name] = (rule as ParameterRule).value;
          decisions.push({ name, action: "defaulted", value: (rule as ParameterRule).value });
        }
        break;
      }
      case "force": {
        const value = (rule as ParameterRule).value;
        if (!had || current !== value) {
          out[name] = value;
          decisions.push({ name, action: "forced", from: current, value });
        } else {
          decisions.push({ name, action: "kept", value: current });
        }
        break;
      }
      case "clamp": {
        if (!had || typeof current !== "number") {
          if (had) decisions.push({ name, action: "kept", value: current, note: "不是数字，未钳制" });
          break;
        }
        const { min, max } = rule as ParameterRule;
        let next = current;
        if (typeof min === "number" && next < min) next = min;
        if (typeof max === "number" && next > max) next = max;
        if (next === current) {
          decisions.push({ name, action: "kept", value: current });
        } else {
          out[name] = next;
          decisions.push({ name, action: "clamped", from: current, value: next });
        }
        break;
      }
      case "rename": {
        const to = (rule as ParameterRule).to;
        if (typeof to !== "string" || !to.trim()) break;
        if (!had) {
          decisions.push({ name, action: "kept", note: `客户端没传 ${name}` });
          break;
        }
        setPath(out, to, current);
        if (to !== name) delete out[name];
        decisions.push({ name, action: "renamed", from: current, value: current, note: to });
        break;
      }
      case "passthrough":
      default: {
        if (had) decisions.push({ name, action: "kept", value: current });
        break;
      }
    }
  }

  // A parameter a rule renamed *into* the body has no decision of its own; name
  // it so the background page can show where the value went.
  const named = new Set(Object.keys(rules));
  for (const decision of decisions) {
    if (decision.action !== "renamed") continue;
    const to = decision.note ?? "";
    if (!named.has(to)) {
      decisions.push({ name: to, action: "kept", value: decision.value, note: `来自 ${decision.name}` });
    }
  }

  return { body: out, decisions };
}

/**
 * The policy for one model, or null.
 *
 * Per-model overrides win over the provider's, the same way the media spec's
 * `params.byModel` does: a provider is a vendor, a model is what a client
 * actually calls, and they do not always want the same thing.
 */
export function resolveParameterRules(
  providerSpec: Pick<TextSpec, "parameters"> | undefined,
  byModel: Record<string, Record<string, ParameterRule>> | undefined,
  model: string,
): Record<string, ParameterRule> {
  return { ...(providerSpec?.parameters ?? {}), ...(byModel?.[model] ?? {}) };
}
