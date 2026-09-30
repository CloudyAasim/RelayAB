/**
 * src/lib/media/engine.ts
 *
 * The generic executor for the media adapter protocol (specVersion 2).
 *
 * Everything vendor-specific lives in a spec (see ./spec.ts); this file only
 * knows how to *interpret* it. Adding a provider therefore means shipping a
 * JSON document, never a code change and never a redeploy.
 *
 * Contract the engine expects a spec's `response` mapping to produce:
 *
 *   { status?, items?, successCount?, taskId?, text?, errorCode?, errorMessage? }
 *
 *   items    → [{ kind: "url" | "base64" | "text", value: string }]
 *              optionally with `encoding: "hex" | "dataUrl" | …`, which tells
 *              the engine how to normalize what the upstream actually sent.
 *   status   → compared against the async rule's success/failure states
 */
import { decryptSecret } from "../crypto/secrets";
import type {
  MediaErrorRule,
  MediaMapping,
  MediaProvider,
  MediaSpec,
  MediaTaskState,
} from "./spec";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface MediaItem {
  kind: "url" | "base64" | "text";
  value: string;
}

export interface MediaResult {
  items: MediaItem[];
  successCount: number;
  taskId?: string;
  durationMs: number;
  /**
   * Present when the spec's `responseMode` is `binary` (buffered) or
   * `stream` (pass-through). Audio generation must not be buffered or JSON
   * parsed, so the bytes go straight back to the client.
   */
  binary?: {
    body: ArrayBuffer;
    stream?: ReadableStream<Uint8Array>;
    contentType?: string;
  };
  /** Present when the response mapping produced a `text` field (transcription). */
  text?: string;
}

export interface MediaEngineError {
  status: number;
  code: string;
  message: string;
}

export type MediaExecuteResult =
  | { ok: true; result: MediaResult }
  | { ok: false; error: MediaEngineError };

export interface ExecuteMediaArgs {
  spec: MediaSpec;
  provider: MediaProvider;
  /** Normalized request fields (`model`, `prompt`, `n`, `size`, `image`, …). */
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Request scope
// ---------------------------------------------------------------------------

const toSnakeCase = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();

const toCamelCase = (key: string): string =>
  key
    .replace(/[-_\s]+(.)?/g, (_m, char: string | undefined) =>
      char ? char.toUpperCase() : "",
    )
    .replace(/^(.)/, (_m, char: string) => char.toLowerCase());

/**
 * The scope a spec's `request` mapping is evaluated against.
 *
 * Every key is exposed under **both** its snake_case and camelCase spelling.
 * That is deliberate: it is the difference between a spec that silently
 * downgrades a client's `response_format: "b64_json"` to the default and one
 * that works whichever way the operator spells it. The normalized fields win
 * over the raw passthrough, and any spelling collision keeps the first value.
 */
export function buildMediaScope(input: Record<string, unknown>): Record<string, unknown> {
  const { extra, ...normalized } = input as { extra?: Record<string, unknown> };

  // Real keys first, normalized ones above the raw passthrough. Absent optionals
  // are dropped so `$ifPresent` and a plain `$.missing` lookup agree.
  const scope: Record<string, unknown> = {};
  const taken = new Set<string>();
  for (const layer of [normalized, extra ?? {}]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || taken.has(key)) continue;
      scope[key] = value;
      taken.add(key);
    }
  }

  // Then fill in the spellings nobody used. A real key always beats an alias —
  // otherwise a passthrough `response_format` could shadow the route's
  // normalized `responseFormat` and silently downgrade the request.
  for (const key of [...taken]) {
    const value = scope[key];
    for (const alias of [toSnakeCase(key), toCamelCase(key)]) {
      if (taken.has(alias)) continue;
      scope[alias] = value;
      taken.add(alias);
    }
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Path + template resolution
// ---------------------------------------------------------------------------

/** Read a dotted/indexed path such as `$.a.b[0].c` out of a value. */
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

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

function resolveTemplate(text: string, scope: unknown): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const resolved = getPath(scope, path.trim());
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// Upstream encodings
// ---------------------------------------------------------------------------

/** `"49443304…"` → base64. Vendors that return hex must say so in the spec. */
function hexToBase64(hex: string): string {
  const clean = hex.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  const padded = clean.length % 2 === 1 ? `0${clean}` : clean;
  if (padded.length === 0) return "";
  if (!/^[0-9a-fA-F]+$/.test(padded)) return hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `data:audio/mpeg;base64,QUJD` → `QUJD` (the inverse of `$dataUrl`). */
function stripDataUrl(value: string): string {
  const commaAt = value.indexOf(",");
  return value.startsWith("data:") && commaAt >= 0 ? value.slice(commaAt + 1) : value;
}

/**
 * Turn a raw upstream string into what the client asked for.
 *
 * `encoding` declares what the upstream sent; `kind` is what the client gets.
 * Without it we can only pass bytes through, which is why a hex payload mapped
 * as base64 used to reach the client as undecodable garbage.
 */
function normalizeItemValue(value: string, encoding: unknown, kind: MediaItem["kind"]): string {
  const declared = typeof encoding === "string" ? encoding : "plain";
  switch (declared) {
    case "hex":
      return kind === "base64" ? hexToBase64(value) : value;
    case "dataUrl":
      return kind === "base64" ? stripDataUrl(value) : value;
    case "base64":
    case "plain":
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Follow-up fetch ($fetch)
// ---------------------------------------------------------------------------

/** Key used to mark a value that still needs one follow-up GET. */
const FETCH_MARKER = "__fetch";

/**
 * Hard cap on follow-up GETs per media call. A spec is operator-authored data,
 * but an accidental cycle or a wide array should never turn one request into an
 * unbounded number of upstream calls.
 */
const MAX_FETCH_MARKERS = 8;

const FETCH_TIMEOUT_MS = 30_000;

/** `{{ $.a.b }}` → the value, URL-encoded (for query strings). */
function interpolateUrl(template: string, scope: unknown): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path: string) => {
    const value = getPath(scope, path.trim());
    return value === undefined || value === null ? "" : encodeURIComponent(String(value));
  });
}

async function resolveFetches(
  value: unknown,
  fetchJson: ((url: string) => Promise<unknown>) | null,
  budget = { left: MAX_FETCH_MARKERS },
): Promise<unknown> {
  if (!fetchJson || budget.left <= 0) return value;
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveFetches(item, fetchJson, budget)));
  }
  const record = asRecord(value);
  if (!record) return value;
  if (FETCH_MARKER in record) {
    const spec = asRecord(record[FETCH_MARKER]) ?? {};
    budget.left -= 1;
    const data = await fetchJson(String(spec.url ?? ""));
    return spec.pick ? getPath(data, String(spec.pick)) : data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    out[key] = await resolveFetches(child, fetchJson, budget);
  }
  return out;
}

function makeFetcher(
  spec: MediaSpec,
  provider: MediaProvider,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): (url: string) => Promise<unknown> {
  return async (path: string) => {
    const url = buildUrl(spec, provider, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: buildHeaders(spec, provider),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`$fetch got HTTP ${response.status} from ${url.pathname}`);
      }
      return decodeJson(await response.text());
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Evaluate a mapping tree against a scope.
 *
 * `undefined` results propagate so the caller can drop the key entirely — that
 * is how a spec expresses "only send this when the client provided it".
 */
export function applyMapping(node: MediaMapping, scope: unknown): unknown {
  if (node === undefined) return undefined;
  if (node === null) return null;
  if (typeof node === "string") {
    if (node === "$") return scope;
    if (node.startsWith("$")) return getPath(scope, node);
    if (node.includes("{{")) return resolveTemplate(node, scope);
    return node;
  }
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (Array.isArray(node)) {
    return node.map((item) => applyMapping(item, scope));
  }

  const record = asRecord(node);
  if (!record) return undefined;
  const keys = Object.keys(record);

  if ("$const" in record) return record.$const;

  if ("$ifPresent" in record) {
    // Two forms:
    //   {"$ifPresent": {"$.voice": <mapping>}}            — one branch
    //   {"$ifPresent": [{"$.url": …}, {"$.b64_json": …}]}  — ordered branches,
    //   the first whose key resolves wins. Needed when a vendor returns items
    //   that are *either* shape, e.g. OpenAI's `data[]` entries carry `url` or
    //   `b64_json` but never both.
    if (Array.isArray(record.$ifPresent)) {
      for (const branch of record.$ifPresent) {
        const candidate = asRecord(branch);
        if (!candidate) continue;
        const [[path, mapping]] = Object.entries(candidate);
        if (getPath(scope, String(path)) === undefined) continue;
        const evaluated = applyMapping(mapping, scope);
        if (evaluated !== undefined) return evaluated;
      }
      return undefined;
    }
    const inner = asRecord(record.$ifPresent);
    if (!inner) return undefined;
    const [[path, mapping]] = Object.entries(inner);
    if (getPath(scope, String(path)) === undefined) return undefined;
    return applyMapping(mapping, scope);
  }

  if ("$enum" in record) {
    const params = asRecord(record.$enum);
    if (!params) return undefined;
    const raw = getPath(scope, String(params.path ?? "$"));
    const table = asRecord(params.map) ?? {};
    if (raw === undefined || raw === null) {
      return params.default === undefined ? undefined : params.default;
    }
    const mapped = table[String(raw)];
    return mapped !== undefined ? mapped : params.default ?? raw;
  }

  if ("$mapSize" in record) {
    const params = asRecord(record.$mapSize);
    if (!params) return undefined;
    const raw = getPath(scope, String(params.path ?? "$.size"));
    if (raw === undefined || raw === null) return params.default;
    const table = asRecord(params.table) ?? {};
    return table[String(raw)] ?? params.default ?? raw;
  }

  if ("$dataUrl" in record) {
    const raw = getPath(scope, String(record.$dataUrl));
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    // Already usable as-is: data URLs, and public URLs (vendors that accept
    // subject references by URL will fetch it themselves).
    if (raw.startsWith("data:") || /^https?:\/\//.test(raw)) return raw;
    // Raw base64 from an uploaded file → wrap it in a data URL.
    return `data:image/png;base64,${raw}`;
  }

  if ("$file" in record) {
    // Builds a file part for a multipart upstream: a data URL becomes a real
    // multipart file instead of a long text field.
    const params = asRecord(record.$file) ?? {};
    const raw = getPath(scope, String(params.path ?? "$.image"));
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const commaAt = raw.indexOf(",");
    const isDataUrl = raw.startsWith("data:");
    const base64 = isDataUrl
      ? raw.slice(commaAt + 1)
      : raw.replace(/^base64:/, "");
    const headerType = isDataUrl ? raw.slice(5, commaAt) : "application/octet-stream";
    return {
      __file: true,
      filename: params.filename ? String(getPath(scope, String(params.filename)) ?? "upload") : "upload",
      contentType: params.contentType
        ? String(params.contentType)
        : String(headerType),
      base64,
    };
  }

  if ("$from" in record) {
    const source = getPath(scope, String(record.$from));
    if (!Array.isArray(source)) return undefined;
    const projector = "$to" in record ? record.$to : "$";
    return source.map((item) => applyMapping(projector, item));
  }

  if ("$merge" in record) {
    const parts = Array.isArray(record.$merge) ? record.$merge : [record.$merge];
    const merged: Record<string, unknown> = {};
    for (const part of parts) {
      const evaluated = applyMapping(part, scope);
      const partRecord = asRecord(evaluated);
      if (partRecord) Object.assign(merged, partRecord);
    }
    return merged;
  }

  /**
   * Follow-up GET against the same provider, e.g. MiniMax returns a `file_id`
   * that has to be exchanged for a download URL.
   *
   * Evaluation stays synchronous: the node resolves to a marker that
   * `executeMedia` expands after mapping (one network round-trip at most a few
   * times per call), which keeps `applyMapping` pure and unit-testable.
   */
  if ("$fetch" in record) {
    const params = asRecord(record.$fetch);
    const template = params ? String(params.url ?? "") : "";
    if (!template) return undefined;
    return {
      [FETCH_MARKER]: {
        url: interpolateUrl(template, scope),
        ...(params?.pick ? { pick: String(params.pick) } : {}),
      },
    };
  }

  if ("$eq" in record) {
    const pair = Array.isArray(record.$eq) ? record.$eq : [];
    return sameValue(applyMapping(pair[0], scope), applyMapping(pair[1], scope));
  }

  /** First path that actually resolves — vendors differ per account tier/region. */
  if ("$firstPresent" in record) {
    const paths = Array.isArray(record.$firstPresent) ? record.$firstPresent : [];
    for (const candidate of paths) {
      const value = applyMapping(candidate, scope);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  /** Some vendors want `"4"` where the client sent `4`. */
  if ("$toString" in record) {
    const value = applyMapping(record.$toString, scope);
    return value === undefined || value === null ? undefined : String(value);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const evaluated = applyMapping(value, scope);
    if (evaluated !== undefined) out[key] = evaluated;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

/** Base URL a spec talks to: its own override, else the provider's. */
function specOrigin(spec: MediaSpec, provider: MediaProvider): URL {
  return new URL(spec.baseUrl ?? provider.baseUrl);
}

/**
 * Absolute URL for a spec path, with the spec's static query parameters and
 * query-style auth attached.
 *
 * The submit path is resolved separately by `resolveRequestTarget` because it
 * additionally substitutes `{{model}}` and maps query values from the request
 * scope; this one serves `$fetch` and the poll path, neither of which has a
 * request scope.
 */
function buildUrl(spec: MediaSpec, provider: MediaProvider, path: string): URL {
  const base = specOrigin(spec, provider);
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  for (const [key, value] of Object.entries(spec.transport.query ?? {})) {
    const resolved = applyMapping(value, {});
    if (resolved === undefined || resolved === null) continue;
    url.searchParams.set(key, String(resolved));
  }
  if (spec.auth.type === "query" && typeof spec.auth.name === "string") {
    url.searchParams.set(spec.auth.name, decryptSecret(provider.encryptedApiKey));
  }
  // A spec may only ever talk to its own provider: both the base URL and the
  // transport path are operator config, so re-assert the origin to keep a
  // malformed spec from turning the relay into an open proxy.
  if (url.origin !== base.origin) {
    throw new Error("spec target escapes the provider origin");
  }
  return url;
}

function buildHeaders(
  spec: MediaSpec,
  provider: MediaProvider,
  scope: Record<string, unknown> = {},
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(spec.transport.headers ?? {})) {
    const resolved = applyMapping(value, scope);
    if (resolved === undefined || resolved === null) continue;
    headers.set(key, String(resolved));
  }
  if (spec.transport.contentType !== "multipart/form-data") {
    headers.set("Content-Type", spec.transport.contentType ?? "application/json");
  }
  if (spec.auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${decryptSecret(provider.encryptedApiKey)}`);
  } else if (spec.auth.type === "header" && typeof spec.auth.name === "string") {
    const prefix = spec.auth.prefix ?? "";
    headers.set(spec.auth.name, `${prefix}${decryptSecret(provider.encryptedApiKey)}`);
  }
  return headers;
}

/** Submit URL + headers, with `{{model}}` and scope-driven query/header values. */
function resolveRequestTarget(
  spec: MediaSpec,
  provider: MediaProvider,
  scope: Record<string, unknown>,
): { url: URL; headers: Headers } {
  const base = specOrigin(spec, provider);
  const path = spec.transport.path.replace(/\{\{\s*model\s*\}\}/g, () =>
    encodeURIComponent(String(scope.model ?? "")),
  );
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  for (const [key, value] of Object.entries(spec.transport.query ?? {})) {
    const resolved = applyMapping(value, scope);
    if (resolved === undefined || resolved === null) continue;
    url.searchParams.set(key, String(resolved));
  }
  if (spec.auth.type === "query" && typeof spec.auth.name === "string") {
    url.searchParams.set(spec.auth.name, decryptSecret(provider.encryptedApiKey));
  }
  if (url.origin !== base.origin) {
    throw new Error("spec target escapes the provider origin");
  }
  return { url, headers: buildHeaders(spec, provider, scope) };
}

function collectItems(payload: unknown): MediaItem[] {
  const record = asRecord(payload);
  if (!record) return [];
  const items: MediaItem[] = [];
  const push = (raw: unknown, forcedKind?: MediaItem["kind"]) => {
    const item = asRecord(raw);
    if (!item || typeof item.value !== "string" || item.value.length === 0) return;
    const kind: MediaItem["kind"] =
      forcedKind ??
      (item.kind === "base64" || item.kind === "text" || item.kind === "url" ? item.kind : "url");
    items.push({ kind, value: normalizeItemValue(item.value, item.encoding, kind) });
  };
  // A single object is accepted too, so a spec can map a lone result without
  // wrapping it in `$from`.
  if (Array.isArray(record.items)) record.items.forEach((raw) => push(raw));
  else if (record.items !== undefined) push(record.items);
  // `itemsB64` is the older spelling for "a second array of base64 items"
  // (vendors that return urls and base64 in separate arrays). It is always
  // forced to kind "base64" — dropping it silently would turn a working spec
  // into an empty result.
  if (Array.isArray(record.itemsB64)) record.itemsB64.forEach((raw) => push(raw, "base64"));
  else if (record.itemsB64 !== undefined) push(record.itemsB64, "base64");
  return items;
}

function errorFromMapped(payload: unknown, fallback: MediaEngineError): MediaEngineError {
  const record = asRecord(payload);
  const message = record && typeof record.errorMessage === "string" ? record.errorMessage : "";
  const code = record && record.errorCode !== undefined ? String(record.errorCode) : "";
  return {
    status: fallback.status,
    code: fallback.code,
    message: message || fallback.message,
  };
}

/**
 * A vendor error rule fired.
 *
 * The rule's own `message` wins; otherwise the spec's `response.errorMessage`
 * mapping is consulted, because a vendor's own `status_msg` ("image description
 * contains sensitive content") tells the caller far more than our error code.
 */
function ruleError(
  spec: MediaSpec,
  rule: MediaErrorRule,
  rawPayload: unknown,
): MediaEngineError {
  if (rule.message) return { status: rule.status, code: rule.code, message: rule.message };
  const mapped = spec.response ? asRecord(applyMapping(spec.response, rawPayload)) : null;
  const vendorMessage = mapped && typeof mapped.errorMessage === "string" ? mapped.errorMessage : "";
  return { status: rule.status, code: rule.code, message: vendorMessage || rule.code };
}

function httpStatusError(spec: MediaSpec, status: number, rawPayload: unknown): MediaEngineError | null {
  for (const rule of spec.errors ?? []) {
    if (rule.httpStatus === undefined) continue;
    const wanted = Array.isArray(rule.httpStatus) ? rule.httpStatus : [rule.httpStatus];
    if (wanted.includes(status)) return ruleError(spec, rule, rawPayload);
  }
  return null;
}

function matchesRule(spec: MediaSpec, rawPayload: unknown): MediaEngineError | null {
  for (const rule of spec.errors ?? []) {
    if (rule.when === undefined) continue;
    if (applyMapping(rule.when, rawPayload) === true) {
      return ruleError(spec, rule, rawPayload);
    }
  }
  return null;
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Split a `text/event-stream` body into its decoded `data:` payloads. */
function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const parsed = decodeJson(data);
    if (parsed !== null) events.push(parsed);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function executeMedia(args: ExecuteMediaArgs): Promise<MediaExecuteResult> {
  const { spec, provider, input } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => Date.now());
  const startedAt = now();

  const maxN = spec.limits?.maxN;
  const requestedN = typeof input.n === "number" ? input.n : 1;
  if (typeof maxN === "number" && requestedN > maxN) {
    return {
      ok: false,
      error: { status: 400, code: "n_too_large", message: `n must be <= ${maxN}` },
    };
  }

  const upstreamBody = applyMapping(spec.request, input) ?? {};
  let target: { url: URL; headers: Headers };
  try {
    target = resolveRequestTarget(spec, provider, input);
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 500,
        code: "bad_spec",
        message: err instanceof Error ? err.message : "invalid spec transport",
      },
    };
  }

  const contentType = spec.transport.contentType ?? "application/json";
  let response: Response;
  try {
    response = await fetchImpl(target.url.toString(), {
      method: spec.transport.method,
      headers: target.headers,
      ...(spec.transport.method === "GET"
        ? {}
        : { body: encodeBody(upstreamBody, contentType) }),
      signal: args.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 502,
        code: "upstream_unreachable",
        message: err instanceof Error ? err.message : "upstream request failed",
      },
    };
  }

  const responseMode = spec.responseMode ?? "json";
  const fetcher = makeFetcher(spec, provider, fetchImpl, args.signal);

  // Audio-style capabilities return bytes; hand them back untouched instead of
  // buffering + JSON-parsing what is not JSON.
  if (responseMode === "binary" || responseMode === "stream") {
    if (!response.ok) {
      return {
        ok: false,
        error: {
          status: 502,
          code: "upstream_error",
          message: `upstream returned HTTP ${response.status}`,
        },
      };
    }
    const contentTypeHeader = response.headers.get("content-type") ?? undefined;
    if (responseMode === "stream") {
      if (!response.body) {
        return {
          ok: false,
          error: { status: 502, code: "empty_stream", message: "upstream returned an empty body" },
        };
      }
      return {
        ok: true,
        result: {
          items: [],
          successCount: 1,
          durationMs: now() - startedAt,
          binary: { body: new ArrayBuffer(0), stream: response.body, contentType: contentTypeHeader },
        },
      };
    }
    return {
      ok: true,
      result: {
        items: [],
        successCount: 1,
        durationMs: now() - startedAt,
        binary: { body: await response.arrayBuffer(), contentType: contentTypeHeader },
      },
    };
  }

  const rawText = await response.text();

  // SSE upstream: map every event and concatenate what the spec produced.
  if (responseMode === "sse") {
    if (!response.ok) {
      return {
        ok: false,
        error: { status: 502, code: "upstream_error", message: `upstream returned HTTP ${response.status}` },
      };
    }
    const merged = await mergeSseEvents(spec, parseSseEvents(rawText), fetcher);
    return finish(spec, merged, { now, startedAt, taskId: undefined });
  }

  const rawPayload = decodeJson(rawText);

  // Two error vocabularies, both supported: an in-body vendor code (MiniMax V1
  // answers HTTP 200 with a non-zero `base_resp.status_code`) and a real HTTP
  // status (OpenAI, MiniMax V2).
  const statusError = httpStatusError(spec, response.status, rawPayload);
  if (statusError) return { ok: false, error: statusError };
  const vendorRuleError = matchesRule(spec, rawPayload);
  if (vendorRuleError) return { ok: false, error: vendorRuleError };

  if (!response.ok) {
    const mapped = spec.response ? applyMapping(spec.response, rawPayload) : undefined;
    return {
      ok: false,
      error: errorFromMapped(mapped, {
        status: 502,
        code: "upstream_error",
        message: `upstream returned HTTP ${response.status}`,
      }),
    };
  }

  const mappedSubmit = spec.response
    ? await resolveFetches(applyMapping(spec.response, rawPayload), fetcher)
    : undefined;
  const submitRecord = asRecord(mappedSubmit);

  // ---- async providers: submit, then poll until the task settles --------
  if (spec.async) {
    const taskId = submitRecord && typeof submitRecord.taskId === "string" ? submitRecord.taskId : null;
    if (!taskId) {
      return {
        ok: false,
        error: { status: 502, code: "no_task_id", message: "upstream did not return a task id" },
      };
    }
    const poll = await pollUntilDone({ spec, provider, taskId, fetchImpl, signal: args.signal, now });
    if (!poll.ok) return { ok: false, error: poll.error };
    return finish(spec, poll.payload, { now, startedAt, taskId });
  }

  return finish(spec, mappedSubmit, { now, startedAt, taskId: undefined });
}

/** Shared tail: count items, refuse silent emptiness, build the result. */
function finish(
  spec: MediaSpec,
  payload: unknown,
  ctx: { now: () => number; startedAt: number; taskId: string | undefined },
): MediaExecuteResult {
  const items = collectItems(payload);
  const text = textOf(payload);
  if (items.length === 0 && text === undefined && spec.allowEmpty !== true) {
    return {
      ok: false,
      error: {
        status: 502,
        code: "upstream_contract_mismatch",
        message:
          "upstream returned 2xx but the spec's response mapping produced no items — " +
          "check response.items paths (and that the model actually produced output); " +
          'set "allowEmpty": true on the spec if an empty result is legitimate',
      },
    };
  }
  return {
    ok: true,
    result: {
      items,
      successCount: countOf(payload),
      ...(text !== undefined ? { text } : {}),
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      durationMs: ctx.now() - ctx.startedAt,
    },
  };
}

async function mergeSseEvents(
  spec: MediaSpec,
  events: unknown[],
  fetcher: (url: string) => Promise<unknown>,
): Promise<unknown> {
  const merged: Record<string, unknown> = { items: [] as unknown[] };
  let last: Record<string, unknown> = {};
  for (const event of events) {
    if (spec.errors) {
      const ruleError = matchesRule(spec, event);
      if (ruleError) return last;
    }
    const mapped = spec.response ? await resolveFetches(applyMapping(spec.response, event), fetcher) : undefined;
    const record = asRecord(mapped);
    if (!record) continue;
    const items = collectItems(record);
    if (items.length > 0) {
      (merged.items as unknown[]).push(...items);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "items" || key === "itemsB64") continue;
      if (value !== undefined) last[key] = value;
      merged[key] = value;
    }
  }
  // Several SSE events usually repeat the same final URL; keep one of each.
  const seen = new Map<string, MediaItem>();
  for (const item of merged.items as MediaItem[]) {
    seen.set(`${item.kind}\u0000${item.value}`, item);
  }
  merged.items = [...seen.values()];
  return merged;
}

function countOf(payload: unknown): number {
  const record = asRecord(payload);
  if (record && typeof record.successCount === "number" && record.successCount > 0) {
    return record.successCount;
  }
  const items = collectItems(payload).length;
  return items > 0 ? items : 1;
}

function textOf(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return record && typeof record.text === "string" ? record.text : undefined;
}

function encodeBody(body: unknown, contentType: string): BodyInit {
  if (contentType === "multipart/form-data") return toFormData(body);
  if (contentType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams();
    const record = asRecord(body) ?? {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

function toFormData(body: unknown): FormData {
  const form = new FormData();
  const record = asRecord(body) ?? {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    // A `$file` node becomes a real multipart file part.
    const file = asRecord(value);
    if (file && file.__file === true && typeof file.base64 === "string") {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      form.append(
        key,
        new File([bytes], String(file.filename ?? "upload"), {
          type: String(file.contentType ?? "application/octet-stream"),
        }),
      );
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, String(item));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

// ---------------------------------------------------------------------------
// Async polling
// ---------------------------------------------------------------------------

type PollSettled = { ok: true; payload?: unknown } | { ok: false; error: MediaEngineError };

/** Resolve a raw status string to a canonical state via the spec's rules. */
function classifyStatus(
  status: string,
  poll: NonNullable<MediaSpec["async"]>["poll"],
): MediaTaskState | null {
  const caseInsensitive = poll.statusMatch !== "exact";
  const key = caseInsensitive ? status.toLowerCase() : status;
  const hit = (value: string) => (caseInsensitive ? value.toLowerCase() : value) === key;

  const map = poll.statusMap;
  if (map) {
    for (const [vendorState, canonical] of Object.entries(map)) {
      if (caseInsensitive ? vendorState.toLowerCase() === key : vendorState === key) {
        return canonical;
      }
    }
    return null;
  }
  if ((poll.failureValues ?? []).some(hit)) return "fail";
  if ((poll.successValues ?? []).some(hit)) return "ok";
  return null;
}

async function pollUntilDone(args: {
  spec: MediaSpec;
  provider: MediaProvider;
  taskId: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  now: () => number;
}): Promise<PollSettled> {
  const { spec, provider, taskId, fetchImpl, now } = args;
  const async_ = spec.async;
  if (!async_) return { ok: false, error: { status: 500, code: "no_async", message: "spec has no async block" } };

  const intervalMs = async_.poll.intervalMs ?? 3000;
  const timeoutMs = async_.poll.timeoutMs ?? 240_000;
  const deadline = now() + timeoutMs;
  const fetcher = makeFetcher(spec, provider, fetchImpl, args.signal);
  let lastStatus: string | undefined;

  for (;;) {
    const path = async_.poll.path.replace("{{taskId}}", encodeURIComponent(taskId));
    let url: URL;
    try {
      url = buildUrl(spec, provider, path);
    } catch (err) {
      return {
        ok: false,
        error: {
          status: 500,
          code: "bad_spec",
          message: err instanceof Error ? err.message : "invalid poll path",
        },
      };
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: async_.poll.method,
        headers: buildHeaders(spec, provider),
        signal: args.signal,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          status: 502,
          code: "upstream_unreachable",
          message: err instanceof Error ? err.message : "poll request failed",
        },
      };
    }
    const raw = decodeJson(await response.text());

    const statusError = httpStatusError(spec, response.status, raw);
    if (statusError) return { ok: false, error: statusError };
    const ruleError = matchesRule(spec, raw);
    if (ruleError) return { ok: false, error: ruleError };

    const mapped = spec.response
      ? await resolveFetches(applyMapping(spec.response, raw), fetcher)
      : undefined;
    const record = asRecord(mapped);
    const status = record && typeof record.status === "string" ? record.status : undefined;
    if (status) lastStatus = status;

    const state = status ? classifyStatus(status, async_.poll) : null;

    if (state === "fail") {
      return {
        ok: false,
        error: errorFromMapped(mapped, {
          status: 502,
          code: "upstream_task_failed",
          message: `task ${status}`,
        }),
      };
    }
    if (state === "ok" || (!status && collectItems(mapped).length > 0)) {
      if (!status && !response.ok) {
        return {
          ok: false,
          error: { status: 502, code: "upstream_error", message: `poll returned HTTP ${response.status}` },
        };
      }
      return { ok: true, payload: mapped };
    }
    if (now() >= deadline) {
      return {
        ok: false,
        error: {
          status: 504,
          code: "task_timeout",
          // Naming the status we actually saw is the difference between a
          // one-line fix and an afternoon of guessing.
          message: lastStatus
            ? `upstream task did not finish in time (last status "${lastStatus}" — check async.poll.statusMap / successValues)`
            : "upstream task did not finish in time and the poll response carried no status",
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
