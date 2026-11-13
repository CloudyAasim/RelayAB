/**
 * src/lib/media/passthrough.ts
 *
 * Call a vendor exactly as its own documentation describes.
 *
 * Text surfaces have had this for a while (`passthrough` in the route table): the
 * request goes out in the shape it arrived in, and the response comes back
 * untouched. Media could not, because the client speaks OpenAI's image/video
 * shape while the vendor speaks its own — so every media call went through a spec.
 *
 * This is the escape hatch for the case where the client *does* speak the
 * vendor's shape (a vendor-native SDK, an async submit/poll API, a preview
 * endpoint): `/v1/raw/<provider>/<path>` forwards method, path, query, body and
 * the response verbatim, and injects the provider's own credentials.
 *
 * What it deliberately does not do:
 *   - parse the body, so nothing is mapped, counted per item, or validated;
 *   - rewrite the response, so the vendor's status and errors are the client's;
 *   - poll anything — an async vendor's task id belongs to the client, and it
 *     calls the poll path through the same route.
 * Billing is per call on the submit (non-GET) and nothing for polls, because a
 * response we do not parse cannot be counted per image.
 */
import { decryptSecret } from "@/lib/crypto/secrets";
import type { MediaProvider, MediaSpec } from "./spec";

export interface RawPassthroughTarget {
  url: URL;
  headers: Headers;
}

/** Headers a proxy must not copy through in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // The relay's own credential, never the vendor's.
  "authorization",
  "cookie",
]);

/** A path segment that could escape the provider origin. */
function isUnsafeSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0");
}

/**
 * Resolve the vendor URL the client asked for.
 *
 * The path arrives raw (Next hands back decoded segments), so it is rebuilt from
 * the request URL rather than from `params` — a vendor path may contain `:`
 * (Gemini) or dots, and re-encoding it would change which endpoint is called.
 * Anything that could leave the provider's origin is refused.
 */
export function resolveRawTarget(args: {
  provider: MediaProvider;
  spec: MediaSpec;
  /** The request path after the provider segment, e.g. `/v1/videos/up_1`. */
  suffix: string;
  search: URLSearchParams;
}): RawPassthroughTarget {
  const { provider, spec, suffix, search } = args;
  if (!suffix.startsWith("/")) throw new Error("raw path must start with /");

  // `..` in any spelling: the WHATWG URL parser normalizes the percent-encoded
  // forms too, so checking only the literal one would still let a path climb.
  if (/\.\.|%2e|%2f|%5c/i.test(suffix)) {
    throw new Error("raw path may not contain traversal segments");
  }
  const segments = suffix.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "" || segment.includes("\\") || segment.includes("\0")) {
      throw new Error("raw path may not contain an empty segment");
    }
  }

  const base = new URL(spec.baseUrl ?? provider.baseUrl);
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${suffix}`, base.origin);
  if (url.origin !== base.origin) throw new Error("raw path escapes the provider origin");

  // The client's query string is the vendor's query string.
  for (const [key, value] of search.entries()) url.searchParams.append(key, value);

  const headers = new Headers();
  for (const [key, value] of Object.entries(spec.transport.headers ?? {})) {
    if (typeof value === "string") headers.set(key, value);
  }
  if (spec.auth.type === "query" && typeof spec.auth.name === "string") {
    url.searchParams.set(spec.auth.name, decryptSecret(provider.encryptedApiKey));
  }
  return { url, headers };
}

/** Headers for the upstream call: the vendor's auth plus whatever the spec declares. */
export function rawRequestHeaders(args: {
  provider: MediaProvider;
  spec: MediaSpec;
  incoming: Headers;
  target: RawPassthroughTarget;
}): Headers {
  const { provider, spec, incoming, target } = args;
  const headers = new Headers(target.headers);

  for (const [key, value] of incoming.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }

  if (spec.auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${decryptSecret(provider.encryptedApiKey)}`);
  } else if (spec.auth.type === "header" && typeof spec.auth.name === "string") {
    const prefix = spec.auth.prefix ?? "";
    headers.set(spec.auth.name, `${prefix}${decryptSecret(provider.encryptedApiKey)}`);
  }
  return headers;
}

/** Response headers worth passing on; the rest are hop-by-hop or already decoded. */
export function rawResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of upstream.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // fetch has already decoded the body; forwarding this would announce a
    // content-coding the client then tries to decode a second time.
    if (lower === "content-encoding") continue;
    if (lower === "set-cookie") continue;
    headers.set(key, value);
  }
  return headers;
}

/**
 * The spec whose credentials speak for this model.
 *
 * A passthrough call does not name a capability — it names a vendor path — so the
 * spec is chosen by model scope first, then by "the provider has exactly one
 * spec" (a single-endpoint vendor whose model list was never filled in). When
 * several specs exist and none scopes the model, the first is used: credentials
 * are a property of the provider account, and refusing here would make the
 * passthrough unusable for multi-capability vendors.
 */
export function specForRawCall(provider: MediaProvider, model: string): MediaSpec | null {
  const scoped = provider.specs.find((spec) => spec.models?.includes(model));
  if (scoped) return scoped;
  if (!provider.models[model]) return provider.specs.length === 1 ? provider.specs[0] : null;
  return provider.specs[0] ?? null;
}
