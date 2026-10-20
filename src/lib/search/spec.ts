/**
 * src/lib/search/spec.ts
 *
 * The **search adapter protocol** — `specVersion: 1`.
 *
 * ## Why this exists
 *
 * Search backends used to be three hand-written adapters in one file
 * (`src/lib/assistant/web-search.ts`): SearXNG, Tavily, Brave. Each had its own
 * request builder, its own response reader, and its own idea of what a "base
 * URL" meant. Adding a fourth vendor meant editing that file and shipping a
 * deploy; making a vendor do something its API already supports — a different
 * language, a freshness window, a country, a different search depth — meant
 * editing that file too, because the parameter was hardcoded next to the
 * adapter.
 *
 * Meanwhile the media side of this same codebase had solved exactly this
 * problem: a declarative spec plus a generic engine, so a vendor is a JSON
 * document and never a code change. Two provider families behaving differently
 * is the inconsistency this protocol removes.
 *
 * ## The shape
 *
 * ```
 * {
 *   "specVersion": 1,
 *   "displayName": "Tavily",
 *   "baseUrl": "https://api.tavily.com",
 *   "transport": {
 *     "method": "POST",
 *     "path": "/search",
 *     "query": { "q": "{{$.query}}" },
 *     "body": { "query": "{{$.query}}", "max_results": "{{$.limit}}" }
 *   },
 *   "auth": { "type": "bearer" },
 *   "response": {
 *     "items": "$.results",
 *     "fields": { "title": "$.title", "url": "$.url", "snippet": "$.content" }
 *   },
 *   "limits": { "timeoutMs": 15000 }
 * }
 * ```
 *
 * The syntax is the media protocol's, read from `src/lib/spec/primitives.ts`:
 *
 *   - a **path** (`$.web.results`) reads a value out of the upstream's JSON,
 *   - a **template** (`"{{$.query}}"`) writes the request's own values into a
 *     request field,
 *   - `{"$firstPresent": ["$.content", "$.snippet"]}` takes the first of several
 *     paths that the vendor actually answered.
 *
 * What is deliberately not here: the media protocol's file/base64/fetch
 * transforms. A search response carries links, not bytes, and inventing an
 * equivalent vocabulary would be a second dialect of the same idea.
 *
 * ## The one rule that matters
 *
 * **Unknown fields are rejected, at every level.** A typo like `respone` or
 * `transport.contntType` used to parse "successfully" and then be ignored, so
 * the operator believed a setting had taken effect when it had not. A loud
 * rejection is the whole thesis of this protocol — and it is the rule the
 * media protocol learned the hard way.
 */
import { getPath } from "../spec/primitives";

/** The protocol version. One version, no branches — see the media protocol. */
export const SEARCH_SPEC_VERSION = 1;

export type SearchSpecMethod = "GET" | "POST";

export interface SearchTransport {
  method: SearchSpecMethod;
  /**
   * Appended to the provider's base address.
   *
   * Starts with `/`, and is **appended** to the base rather than replacing
   * the base's own path: a base of `https://api.example.com/v1` with a path
   * of `/search` asks for `https://api.example.com/v1/search`. The **base
   * address** is one concept for every vendor: the service root, not the full
   * endpoint. That is the difference this protocol fixes — the old column
   * meant "the whole endpoint" for Tavily and Brave and "the service root" for
   * SearXNG, which is how a Tavily URL ended up in a Brave row and was only
   * discovered at request time.
   *
   * **An empty path means the address is the whole endpoint.** That is the
   * rule the rows written before the protocol existed are read under, and it
   * is how a user points the assistant at a search service that publishes one
   * exact URL.
   */
  path: string;
  /** Fixed request headers. Never carries the credential — that is `auth`. */
  headers?: Record<string, string>;
  /**
   * Query-string parameters.
   *
   * Values are templates or literals. `{{$.query}}` and `{{$.limit}}` are the
   * only two the engine knows; anything else resolves to an empty string,
   * which is why the engine refuses a spec that asks for an unknown
   * placeholder.
   */
  query?: Record<string, string>;
  /**
   * The JSON body, for a POST.
   *
   * Values are templates or literals. A value that is exactly one template
   * keeps the *type* of what it resolves to — `"{{$.limit}}"` is the number
   * `6`, not the string `"6"` — because a vendor that documents a numeric
   * field rejects the string form.
   */
  body?: Record<string, unknown>;
}

export type SearchAuthType = "bearer" | "header" | "query" | "none";

export interface SearchAuth {
  type: SearchAuthType;
  /** For `header`: the header name. For `query`: the parameter name. */
  name?: string;
  /** For `bearer` and `header`: what goes in front of the key, e.g. `"Bearer "`. */
  prefix?: string;
  /**
   * Whether the backend cannot answer without a credential.
   *
   * True by default, which is the safe answer: a keyed API that is given no
   * key cannot be built into a backend at all, so the row is **skipped** and
   * the operator sees "this configuration cannot work" rather than a stream of
   * 401s from a request that was never going to be authenticated. A
   * self-hosted instance behind a proxy sets this to false, and then a missing
   * key means no credential is sent at all — never an empty one.
   */
  required?: boolean;
}

/**
 * Where one field of a hit lives.
 *
 * Either a path, or `{"$firstPresent": [path, …]}` — the second form exists
 * because vendors disagree about the name of a snippet (`content` / `snippet` /
 * `description`) and a spec should not have to guess which one this
 * deployment's instance happens to use.
 */
export type SearchFieldSelector = string | { $firstPresent: string[] };

export interface SearchResponseFields {
  title: SearchFieldSelector;
  url: SearchFieldSelector;
  snippet: SearchFieldSelector;
}

export interface SearchResponse {
  /** Path to the array of hits, e.g. `$.results` or `$.web.results`. */
  items: string;
  /**
   * Where each field of one hit lives, relative to the hit.
   *
   * A field is either a path or `{"$firstPresent": [path, …]}` — the second
   * form exists because vendors disagree about the name of a snippet
   * (`content` / `snippet` / `description`) and a spec should not have to
   * guess.
   */
  fields: SearchResponseFields;
}

export interface SearchLimits {
  /** Request deadline in milliseconds. */
  timeoutMs?: number;
  /** Largest number of hits the upstream accepts. */
  maxResults?: number;
}

export interface SearchSpec {
  specVersion: 1;
  /** What the operator calls this backend. */
  displayName?: string;
  /**
   * The vendor's service root, used when the provider row has none.
   *
   * A row's own address always wins — the row is what the operator edits, and a
   * spec that could override it would make the panel lie about where a request
   * goes.
   */
  baseUrl?: string;
  /**
   * Which vendor this speaks to, recorded in usage rows.
   *
   * Kept apart from the provider row's `kind`, which selects the *template* a
   * row without a spec uses. A row that carries its own spec is free to be
   * any vendor at all — that is the point of the protocol.
   */
  vendor?: string;
  transport: SearchTransport;
  auth?: SearchAuth;
  response: SearchResponse;
  limits?: SearchLimits;
}

/**
 * The placeholders the engine can fill in. Anything else is a mistake.
 *
 * They are **paths**, not bare names, because that is what the media
 * protocol's `{{…}}` syntax takes — one notation for both protocols. `$.query`
 * is the search term, `$.limit` is how many hits were asked for.
 */
export const SEARCH_TEMPLATE_PATHS = ["$.query", "$.limit"] as const;
export type SearchTemplatePath = (typeof SEARCH_TEMPLATE_PATHS)[number];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SearchSpecParse =
  | { ok: true; spec: SearchSpec; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const SPEC_KEYS = new Set([
  "specVersion",
  "displayName",
  "baseUrl",
  "vendor",
  "transport",
  "auth",
  "response",
  "limits",
]);

const TRANSPORT_KEYS = new Set(["method", "path", "headers", "query", "body"]);
const AUTH_KEYS = new Set(["type", "name", "prefix", "required"]);
const RESPONSE_KEYS = new Set(["items", "fields"]);
const FIELD_KEYS = new Set(["title", "url", "snippet"]);
const LIMITS_KEYS = new Set(["timeoutMs", "maxResults"]);

/**
 * Report every key the engine will not read.
 *
 * The reason this exists, verbatim from the media protocol: rejecting unknown
 * keys only at the top level let every other typo through silently, so a
 * setting the operator believed in was a setting that did nothing.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field (typo?)`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A path is `$` or `$.a.b[0]`. Anything else cannot be read. */
const PATH_PATTERN = /^\$(?:\.[^.[\]]+(?:\[\d+\])*)*$/;

function checkPath(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${path}: must be a path such as "$.results"`);
    return;
  }
  if (!PATH_PATTERN.test(value)) {
    errors.push(`${path}: "${value}" is not a path — a path starts with "$" and reads like "$.web.results"`);
  }
}

/**
 * Every `{{…}}` placeholder a value mentions.
 *
 * A spec that asks for a placeholder the engine cannot fill would send a
 * literal `{{foo}}` upstream, which reads as a search for the text
 * "{{foo}}" and returns confidently wrong results. So it is an error at save
 * time, not a surprise at request time.
 */
function collectTemplates(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectTemplates(entry, out, depth + 1);
    return out;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      for (const match of entry.matchAll(/\{\{([^}]+)\}\}/g)) out.push(match[1].trim());
    } else {
      collectTemplates(entry, out, depth + 1);
    }
  }
  return out;
}

/**
 * A field is a path, or `{"$firstPresent": [path, …]}`.
 *
 * Only these two forms. A field that is neither cannot be read, and a spec
 * that cannot be read is a spec that returns nothing — silently, and for a
 * price.
 */
function checkField(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    checkPath(value, path, errors);
    return;
  }
  const record = asRecord(value);
  if (!record) {
    errors.push(`${path}: must be a path or {"$firstPresent": [...]}`);
    return;
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "$firstPresent") {
    errors.push(`${path}: unknown form — use a path, or {"$firstPresent": ["$.a", "$.b"]}`);
    return;
  }
  const candidates = record.$firstPresent;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push(`${path}.$firstPresent: must be a non-empty array of paths`);
    return;
  }
  candidates.forEach((candidate, index) => {
    checkPath(candidate, `${path}.$firstPresent[${index}]`, errors);
  });
}

/**
 * Does this value carry the search term?
 *
 * Exactly the two forms the engine can fill: the path `$.query` and the
 * template `{{$.query}}` (with or without text around it). A value that
 * merely *contains* the text — `$.queryText`, say — is not one of them, and
 * counting it as one would let a spec through that sends nothing.
 *
 * The whole tree is walked, because the engine resolves nested values too.
 */
function carriesQuery(value: unknown): boolean {
  if (typeof value === "string") {
    if (value === "$.query") return true;
    return value.includes("{{$.query}}");
  }
  if (Array.isArray(value)) return value.some(carriesQuery);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(carriesQuery);
  }
  return false;
}

/**
 * Parse and check a spec.
 *
 * The result is either a usable spec or a list of what is wrong with it. There
 * is no third outcome, and no "parsed with warnings" that quietly drops a
 * field: an operator who saved a broken spec has to be told which part is
 * broken.
 */
export function parseSearchSpec(raw: unknown): SearchSpecParse {
  const errors: string[] = [];
  const warnings: string[] = [];

  const root = asRecord(raw);
  if (!root) {
    return { ok: false, errors: ["spec must be a JSON object"], warnings };
  }
  rejectUnknownKeys(root, SPEC_KEYS, "spec", errors);

  if (root.specVersion !== SEARCH_SPEC_VERSION) {
    errors.push(`specVersion: must be ${SEARCH_SPEC_VERSION}`);
  }

  const transportRaw = asRecord(root.transport);
  if (!transportRaw) {
    errors.push("transport: is required and must be an object");
  } else {
    rejectUnknownKeys(transportRaw, TRANSPORT_KEYS, "transport", errors);

    const method = transportRaw.method;
    if (method !== "GET" && method !== "POST") {
      errors.push('transport.method: must be "GET" or "POST"');
    }

    const path = transportRaw.path;
    if (typeof path !== "string") {
      errors.push(
        'transport.path: is required, e.g. "/search" — or "" when the address is the whole endpoint',
      );
    } else if (path.trim() !== "" && !path.startsWith("/")) {
      errors.push(`transport.path: "${path}" must start with "/"`);
    }

    if (transportRaw.headers !== undefined) {
      const headers = asRecord(transportRaw.headers);
      if (!headers) {
        errors.push("transport.headers: must be an object of header names to values");
      } else {
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value !== "string") {
            errors.push(`transport.headers.${name}: must be a string`);
          }
        }
      }
    }

    if (transportRaw.query !== undefined) {
      const query = asRecord(transportRaw.query);
      if (!query) {
        errors.push("transport.query: must be an object of parameter names to values");
      } else {
        for (const [name, value] of Object.entries(query)) {
          if (typeof value !== "string") {
            errors.push(`transport.query.${name}: must be a string`);
          }
        }
      }
    }

    if (transportRaw.body !== undefined) {
      if (!asRecord(transportRaw.body)) {
        errors.push("transport.body: must be an object");
      }
    }

    if (method === "GET" && transportRaw.body !== undefined) {
      errors.push("transport.body: a GET request has no body — put the parameters in transport.query");
    }
  }

  if (root.auth !== undefined) {
    const authRaw = asRecord(root.auth);
    if (!authRaw) {
      errors.push("auth: must be an object");
    } else {
      rejectUnknownKeys(authRaw, AUTH_KEYS, "auth", errors);
      const type = authRaw.type;
      if (type !== "bearer" && type !== "header" && type !== "query" && type !== "none") {
        errors.push('auth.type: must be "bearer", "header", "query" or "none"');
      }
      if ((type === "header" || type === "query") && (typeof authRaw.name !== "string" || !authRaw.name.trim())) {
        errors.push(`auth.name: is required when auth.type is "${type}"`);
      }
      if (authRaw.prefix !== undefined && typeof authRaw.prefix !== "string") {
        errors.push("auth.prefix: must be a string");
      }
      if (authRaw.required !== undefined && typeof authRaw.required !== "boolean") {
        errors.push("auth.required: must be true or false");
      }
    }
  }

  const responseRaw = asRecord(root.response);
  if (!responseRaw) {
    errors.push("response: is required and must be an object");
  } else {
    rejectUnknownKeys(responseRaw, RESPONSE_KEYS, "response", errors);
    checkPath(responseRaw.items, "response.items", errors);

    const fieldsRaw = asRecord(responseRaw.fields);
    if (!fieldsRaw) {
      errors.push("response.fields: is required and must be an object");
    } else {
      rejectUnknownKeys(fieldsRaw, FIELD_KEYS, "response.fields", errors);
      for (const key of ["title", "url", "snippet"]) {
        if (!(key in fieldsRaw)) {
          errors.push(`response.fields.${key}: is required`);
          continue;
        }
        checkField(fieldsRaw[key], `response.fields.${key}`, errors);
      }
    }
  }

  if (root.limits !== undefined) {
    const limitsRaw = asRecord(root.limits);
    if (!limitsRaw) {
      errors.push("limits: must be an object");
    } else {
      rejectUnknownKeys(limitsRaw, LIMITS_KEYS, "limits", errors);
      if (limitsRaw.timeoutMs !== undefined) {
        const value = limitsRaw.timeoutMs;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 600_000) {
          errors.push("limits.timeoutMs: must be an integer between 1 and 600000");
        }
      }
      if (limitsRaw.maxResults !== undefined) {
        const value = limitsRaw.maxResults;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
          errors.push("limits.maxResults: must be an integer between 1 and 100");
        }
      }
    }
  }

  if (root.baseUrl !== undefined) {
    if (typeof root.baseUrl !== "string" || !root.baseUrl.trim()) {
      errors.push("baseUrl: must be a non-empty string");
    } else if (!isHttpUrl(root.baseUrl.trim())) {
      errors.push("baseUrl: must be an http(s) address");
    }
  }

  if (root.vendor !== undefined && (typeof root.vendor !== "string" || !root.vendor.trim())) {
    errors.push("vendor: must be a non-empty string");
  }

  // The placeholders. Every one of them has to be one the engine can fill.
  for (const name of collectTemplates(root)) {
    if (!(SEARCH_TEMPLATE_PATHS as readonly string[]).includes(name)) {
      errors.push(
        `{{${name}}}: unknown placeholder — the engine can fill ` +
          `${SEARCH_TEMPLATE_PATHS.map((n) => `{{${n}}}`).join(" and ")}`,
      );
    }
  }

  // A spec that sends the query nowhere cannot answer a search.
  //
  // The check walks the whole tree, because the engine does: a vendor that
  // wants the query inside an envelope (`{"opts": {"q": "…"}}`) is a vendor
  // whose spec says so, and a placeholder nested in there used to pass this
  // check while reaching the vendor as the literal text `{{$.query}}`.
  const transport = asRecord(root.transport);
  const sendsQuery =
    carriesQuery(transport?.query) || carriesQuery(transport?.body);
  if (transport && !sendsQuery) {
    errors.push(
      "transport: no parameter carries $.query — the search term has to reach the vendor somewhere",
    );
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const spec: SearchSpec = {
    specVersion: SEARCH_SPEC_VERSION,
    ...(typeof root.displayName === "string" ? { displayName: root.displayName } : {}),
    ...(typeof root.baseUrl === "string" ? { baseUrl: root.baseUrl.trim() } : {}),
    ...(typeof root.vendor === "string" ? { vendor: root.vendor.trim() } : {}),
    transport: transportRaw as unknown as SearchTransport,
    ...(root.auth !== undefined ? { auth: root.auth as SearchAuth } : {}),
    response: responseRaw as unknown as SearchResponse,
    ...(root.limits !== undefined ? { limits: root.limits as SearchLimits } : {}),
  };

  return { ok: true, spec, warnings };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The same check, in the shape the admin API and the proposal checker want.
 *
 * Both doors into the database call this, which is the point: a rule that
 * exists on one side only is a rule that is validated in the panel and not in
 * the assistant, or the other way round — and that has already happened once
 * in this codebase (`statusMap`).
 */
export function validateSearchSpec(raw: unknown): { errors: string[]; warnings: string[] } {
  const result = parseSearchSpec(raw);
  return result.ok
    ? { errors: [], warnings: result.warnings }
    : { errors: result.errors, warnings: result.warnings };
}

/**
 * Read one field of one hit.
 *
 * `{"$firstPresent": [...]}` takes the first path the vendor actually
 * answered; an empty string counts as absent, so a vendor that returns a
 * blank description does not blank out a good one.
 */
export function readSearchField(hit: unknown, field: SearchFieldSelector): string {
  if (typeof field === "string") {
    const value = getPath(hit, field);
    return value === undefined || value === null ? "" : String(value);
  }
  const candidates = field?.$firstPresent;
  if (!Array.isArray(candidates)) return "";
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = getPath(hit, candidate);
    if (value === undefined || value === null || value === "") continue;
    return String(value);
  }
  return "";
}
