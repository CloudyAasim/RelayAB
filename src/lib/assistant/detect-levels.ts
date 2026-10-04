/**
 * src/lib/assistant/detect-levels.ts
 *
 * Working out which thinking levels a model takes, by asking.
 *
 * Nothing publishes this. The levels are documented per model and per vendor —
 * MiniMax's own OpenAI-compatible notes show `reasoning_effort = "max"`, and
 * say the control exists only on one model in the family — and none of it
 * appears in a `/v1/models` response, which is where a model list was looked
 * first. So the only source is the vendor's own reaction to a real request.
 *
 * Two probes, cheapest first.
 *
 * **One sentinel.** Send a level that cannot exist and read the refusal. A
 * vendor that validates the value usually names what it does accept, so one
 * call can return the whole vocabulary. This is the common case and it costs
 * one request.
 *
 * **Then the candidates**, only for the ones the refusal did not settle. A
 * 400 means the level is not one this model takes; anything else — including a
 * refusal for a reason that has nothing to do with the level — does not.
 *
 * Pure, so both steps can be checked against a recorded vendor answer instead of
 * a live account. The previous version of this feature was reported working on
 * the strength of its source, and it never detected anything.
 */

/** A level that cannot be one, used to make the vendor say its vocabulary. */
export const PROBE_SENTINEL = "__relayab_not_a_level__";

/** How many candidates to try when the refusal did not name any. */
const MAX_PROBES = 12;

export interface LevelProbe {
  level: string;
  /** Whether the vendor accepted a request carrying this level. */
  accepted: boolean;
  /** HTTP status, when there was one. */
  status?: number;
  /** The refusal, trimmed — shown in the report so a wrong answer is arguable. */
  error?: string;
}

export interface DetectResult {
  /** What to store as this model's levels. Empty means "none of them work". */
  levels: string[];
  /** Every candidate that was tried, and what happened. */
  probes: LevelProbe[];
  /** True when the vendor named its own vocabulary in the refusal. */
  fromRefusal: boolean;
}

/**
 * Pull a list of quoted or bracketed names out of a refusal.
 *
 * Aimed at the shapes vendors actually use — `must be one of 'low', 'high'`,
 * `enum: ["minimal","low"]`, `invalid value: x, expected one of: a | b` — and
 * deliberately conservative: a handful of short tokens, or nothing. Guessing
 * here would put words in a model's mouth again, which is the thing this whole
 * path exists to stop.
 */
export function levelsFromRefusal(error: string): string[] {
  if (!error) return [];

  // Only what comes *after* the lead-in is a vocabulary. Before it, the vendor
  // is quoting the value it rejected — `invalid value: "x", expected one of …`
  // — and taking that would store the probe's own value as a level of the
  // model, which is the one mistake this whole path must not make. No lead-in,
  // no vocabulary: a refusal that never says what it wanted is a request to go
  // and probe.
  const lead = error.match(
    /(?:one of|expected|enum|allowed(?: values)?(?::| are)?|must be|supported values?(?: are|:)?)\s*:?\s*/i,
  );
  if (!lead || lead.index === undefined) return [];
  const tail = error.slice(lead.index + lead[0].length);

  const out: string[] = [];

  // Quoted names: 'low' | "low" | `low`
  for (const m of tail.matchAll(/['"`]([a-z][a-z0-9_-]{0,23})['"`]/gi)) {
    add(m[1]);
  }
  // Bracketed or comma-separated lists: [a, b, c]
  for (const m of tail.matchAll(/\[([^\]\n]{1,160})\]/g)) {
    for (const part of m[1].split(/[,;|]/)) {
      const name = part.trim().replace(/^['"`]|['"`]$/g, "");
      if (name) add(name);
    }
  }
  // Bare pipe-separated runs: "minimal | medium | high". Common enough to be
  // its own pass, and it carries no quotes to hang the first one on.
  for (const m of tail.matchAll(/([a-z0-9_| -]{0,160}\|[a-z0-9_| -]{0,160})/gi)) {
    for (const part of m[1].split("|")) {
      const name = part.trim();
      if (name) add(name);
    }
  }

  function add(raw: string) {
    const name = raw.trim();
    if (!name || name.length > 24) return;
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return;
    // Words from the surrounding sentence are not a vocabulary. Anything that
    // reads as English prose is left out; a level is a short identifier. The
    // parameter's own name counts as prose, including with the underscore that
    // makes it one token — a refusal that quotes `reasoning_effort` is quoting
    // the thing it rejected, not offering it as a value.
    if (
      /^(the|and|this|that|value|values|one|of|must|be|is|are|for|not|with|invalid|expected|parameter|field|argument|error|reasoning|effort|reasoning_effort|thinking|supported|allowed|options)$/i.test(
        name,
      )
    ) {
      return;
    }
    if (!out.includes(name)) out.push(name);
  }

  return out;
}

/**
 * Read a refusal for a vocabulary, or `null` when there is not one.
 *
 * Separate from {@link levelsFromRefusal} because "found nothing" and "found
 * an empty list" are different answers: the first means go and probe, the
 * second means the vendor named an empty set, which is itself a result.
 */
export function refusalVocabulary(error: string): string[] | null {
  if (!/one of|enum|expected|allowed|unsupported|invalid value/i.test(error)) return null;
  return levelsFromRefusal(error);
}

/**
 * The candidates to try, cheapest first.
 *
 * The sentinel leads because it is the one call that can settle the whole
 * question, and it is the call that runs against a model which may take no
 * levels at all. Everything after it is a real request billed to a real quota.
 */
export function candidatesFor(options: {
  declared: string[];
  fromRefusal: string[] | null;
  fallback: readonly string[];
}): string[] {
  const out: string[] = [PROBE_SENTINEL];
  for (const list of [options.fromRefusal, options.declared, options.fallback]) {
    if (!list) continue;
    for (const level of list) {
      const t = (level ?? "").trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.slice(0, MAX_PROBES + 1);
}

/**
 * What to store, from what the probes came back with.
 *
 * Only what the vendor **accepted**, in the order the candidates were tried. A
 * level that merely failed to answer is not evidence either way: a 500, a
 * timeout, a rate limit — all of those are the vendor not saying, which is not
 * the same as the vendor saying no. Only a 4xx that came back from an upstream
 * that otherwise works counts as a refusal.
 */
export function decideLevels(probes: LevelProbe[]): string[] {
  return probes.filter((p) => p.accepted).map((p) => p.level);
}

/**
 * Whether a failed probe should be recorded as a refusal.
 *
 * Deliberately narrow. "The vendor said no to this value" and "the vendor did
 * not answer" are different, and only the first one is evidence about the
 * level. Treating a timeout as a refusal would delete a level the model takes.
 */
export function isRefusal(status: number | undefined, body: string | undefined): boolean {
  if (typeof status === "number" && status >= 400 && status < 500) {
    // 429 is the vendor declining to answer, not declining the value.
    return status !== 429;
  }
  // No status at all: a refusal that arrived as text. Upstreams that validate
  // enums do so before doing any work, so a 4xx-shaped body counts.
  return Boolean(body) && /\b(invalid|unknown|unrecognized|unsupported|not supported|must be one of|expected)\b/i.test(body ?? "");
}
