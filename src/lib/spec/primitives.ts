/**
 * src/lib/spec/primitives.ts
 *
 * The syntax every declarative protocol in this codebase speaks.
 *
 * Two protocols exist here: the media adapter protocol (`src/lib/media/`) and the
 * search adapter protocol (`src/lib/search/`). They describe different things —
 * one produces files, the other produces links — but they read the same three
 * notations:
 *
 *   - a **path** (`$.a.b[0].c`) that reads a value out of a document,
 *   - a **template** (`"{{query}}"`) that writes a value into a string,
 *   - the rule that an empty string counts as *absent* while `0` and `false` do
 *     not.
 *
 * Those three were written twice — once in the media engine, once wherever the
 * next protocol needed them — and the media engine's own history is the argument
 * against doing it again: a rule that exists in one evaluator and not the other
 * is a rule that is validated on one side of a door and not the other. So they
 * live here, once, and both protocols import them.
 *
 * What is deliberately **not** here: the media engine's transform set
 * (`$file`, `$dataUrl`, `$fetch`, …). Those exist to move bytes — an uploaded
 * file, a base64 payload, a second HTTP call — and a search response has none
 * of those. The search protocol says so in its own terms rather than
 * pretending to be the media protocol with the file parts removed.
 */

/**
 * Read a dotted/indexed path such as `$.a.b[0].c` out of a value.
 *
 * `$` alone is the whole value; a path that does not exist reads as
 * `undefined` rather than throwing, because every caller has to cope with a
 * vendor that renamed a field and there is no useful way to keep going.
 */
export function getPath(value: unknown, path: string): unknown {
  if (path === "$" || path === "") return value;
  const body = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : null;
  if (body === null) return undefined;

  let current: unknown = value;
  for (const rawSegment of body.split(".")) {
    if (current === null || current === undefined) return undefined;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(rawSegment);
    if (!match) return undefined;
    const [, key, indexPart] = match;
    if (key) {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    for (const indexMatch of indexPart.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(indexMatch[1])];
    }
  }
  return current;
}

/**
 * Fill `{{path}}` placeholders in a string from a scope.
 *
 * A placeholder that resolves to nothing becomes an empty string, because a
 * half-written URL is still a URL and a half-written search query is still a
 * search query — the alternative is sending the placeholder itself upstream.
 */
export function resolveTemplate(text: string, scope: unknown): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const resolved = getPath(scope, path.trim());
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

/**
 * Is a value "provided"?
 *
 * `""` counts as absent. OpenAI-compatible aggregators answer with *both* keys
 * of a mutually-exclusive pair and blank the one that does not apply:
 *
 *   {"data":[{"url":"https://…","b64_json":""}]}          // url requested
 *   {"data":[{"url":"","b64_json":"iVBORw0KGgo…"}]}        // b64_json requested
 *
 * Treating `""` as present made `$ifPresent` pick the blank branch, and the
 * `""` value is then dropped by the item collector — the client's image silently
 * disappeared into `upstream_contract_mismatch`. `0` and `false` stay present.
 */
export function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
