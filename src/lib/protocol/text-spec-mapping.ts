/**
 * src/lib/protocol/text-spec-mapping.ts
 *
 * Whether a value is a well-formed mapping tree, without evaluating it.
 *
 * The evaluation itself is the media engine's `applyMapping`, imported by
 * `text-spec.ts`. This is only the cheap structural gate `parseTextSpec` runs
 * first, kept separate so the answer can be tested without an engine.
 *
 * A node is one of: a string, a number, a boolean, `null`, an array of nodes,
 * or an object whose keys are either operator names (`$merge`, `$const`, …) or
 * output field names mapping to further nodes. An object mixing a `$.path`
 * lookup with plain siblings is rejected: the media engine treats the first `$`
 * key it recognises as an instruction and evaluates the rest as fields, so
 * accepting it here would be accepting a spec whose meaning is decided by key
 * order.
 */
const KNOWN_OPERATORS = new Set([
  "$",
  "$const",
  "$ifPresent",
  "$firstPresent",
  "$merge",
  "$mapSize",
  "$enum",
  "$toString",
  "$eq",
  "$from",
  "$to",
]);

/**
 * A node is one of: a string, a number, a boolean, `null`, an array of nodes,
 * or an object whose keys are either operator names (`$merge`, `$const`, …) or
 * output field names mapping to further nodes. An object mixing a `$.path`
 * lookup with plain siblings is rejected: the media engine treats the first `$`
 * key it recognises as an instruction and evaluates the rest as fields, so
 * accepting it here would be accepting a spec whose meaning is decided by key
 * order.
 *
 * **Every string is a valid node.** The engine returns a string that begins with
 * no sigil as a literal, so rejecting one here would refuse an enum table —
 * `{"s1024": "1024x1024"}` is a mapping whose leaves are filenames, and refusing
 * it would be refusing the most ordinary thing a spec does.
 */

function isNode(value: unknown, depth: number): boolean {
  // Bound the walk. A spec is a hand-written document, not a program; anything
  // this deep is a mistake, and an unbounded recursion on operator data is a
  // denial of service in a file the operator uploaded.
  if (depth > 32) return false;
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isNode(item, depth + 1));
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return true;

  // An instruction node: one operator, and nothing else beside it. A lone
  // `$.path` is a lookup, which is also an instruction — either way the single
  // key is the instruction and the rest is its operand.
  if (keys.length === 1 && keys[0].startsWith("$")) {
    if (!KNOWN_OPERATORS.has(keys[0]) && !keys[0].startsWith("$.")) return false;
    return isNode(record[keys[0]], depth + 1);
  }

  // A field node: every value is itself a node. A key that *is* an operator
  // here is the ambiguous case described above.
  if (keys.some((k) => KNOWN_OPERATORS.has(k))) return false;
  return Object.values(record).every((child) => isNode(child, depth + 1));
}

export function isValidSpecMapping(value: unknown): boolean {
  return isNode(value, 0);
}
