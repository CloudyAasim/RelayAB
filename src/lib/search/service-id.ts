/**
 * src/lib/search/service-id.ts
 *
 * The name a client uses to ask for a search service.
 *
 * It is the same job as a chat model's client-visible name, so it gets the
 * same rules: it goes into a JSON body, into a URL, and into somebody's
 * configuration file, so it has to survive being copied around by hand.
 *
 * This module is its own file because **two** places need it and one of them
 * is the database layer: the repository writes the name, and the schema
 * migration writes it for the rows that existed before it was a thing. A
 * module that imported the database would make that a cycle, so the rules live
 * here with nothing else in them.
 */

/**
 * What a service name may look like.
 *
 * Letters, digits, dot, dash and underscore; it has to start with a letter or
 * a digit. Nothing else — a name with a space in it is a name somebody has to
 * quote in three places, and a name with a slash in it is a name that has to
 * be escaped in a URL.
 */
export const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A service name derived from a display name.
 *
 * "自建 SearXNG" → "searxng"; "Tavily (主)" → "tavily"; "Tavily（备用）" →
 * "tavily". The slug is only a starting point: the operator may change it,
 * and the repository keeps it unique either way.
 */
export function slugifyServiceId(name: string, kind: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  if (fromName) return fromName;
  const fromKind = kind
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return fromKind || "search";
}

/**
 * A service name that is not taken yet.
 *
 * The suffix is a number rather than a random string, so an operator reading
 * the list can tell "tavily-2" (a second instance of the same vendor) from
 * "tavily-2k3j9" (a collision with a name somebody typed).
 */
export function uniqueServiceId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`.slice(0, 64);
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}
