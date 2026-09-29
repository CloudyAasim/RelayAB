/**
 * src/lib/media/engine.ts
 *
 * The generic executor for the media adapter protocol.
 *
 * Everything vendor-specific lives in a spec (see ./spec.ts); this file only
 * knows how to *interpret* it. Adding a provider therefore means shipping a
 * JSON document, never a code change and never a redeploy.
 *
 * Contract the engine expects a spec's `response` mapping to produce:
 *
 *   { status?, items?, itemsB64?, successCount?, taskId?, errorCode?, errorMessage? }
 *
 *   items    → [{ kind: "url" | "base64", value: string }]
 *   status   → compared against the async rule's success/failure values
 */
import { decryptSecret } from "../crypto/secrets";
import type { MediaMapping, MediaProvider, MediaSpec } from "./spec";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface MediaItem {
  kind: "url" | "base64";
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

/**
 * Expand every `$fetch` marker produced while mapping a response, fetching from
 * the same provider (origin-checked, auth-reused) and picking the final value.
 */
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

/**
 * Same-origin, authenticated GET used to resolve `$fetch` markers. Reuses the
 * spec's own transport/auth, so a spec can never be talked into calling a
 * third-party host.
 */
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

function buildUrl(spec: MediaSpec, provider: MediaProvider, pathOverride?: string): URL {
  const base = new URL(provider.baseUrl);
  const path = pathOverride ?? spec.transport.path;
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  for (const [key, value] of Object.entries(spec.transport.query ?? {})) {
    url.searchParams.set(key, value);
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

function buildHeaders(spec: MediaSpec, provider: MediaProvider): Headers {
  const headers = new Headers(spec.transport.headers ?? {});
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

function collectItems(payload: unknown): MediaItem[] {
  const record = asRecord(payload);
  if (!record) return [];
  const items: MediaItem[] = [];
  for (const raw of Array.isArray(record.items) ? record.items : []) {
    const item = asRecord(raw);
    if (item && typeof item.value === "string") {
      items.push({ kind: item.kind === "base64" ? "base64" : "url", value: item.value });
    }
  }
  for (const raw of Array.isArray(record.itemsB64) ? record.itemsB64 : []) {
    const item = asRecord(raw);
    if (item && typeof item.value === "string") {
      items.push({ kind: "base64", value: item.value });
    }
  }
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

function matchesRule(spec: MediaSpec, rawPayload: unknown): MediaEngineError | null {
  for (const rule of spec.errors ?? []) {
    if (rule.when === undefined) continue;
    if (applyMapping(rule.when, rawPayload) === true) {
      return { status: rule.status, code: rule.code, message: rule.message ?? rule.code };
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

  const timeoutMs = spec.limits?.timeoutMs ?? 120_000;
  const upstreamBody = applyMapping(spec.request, input) ?? {};
  const url = buildUrl(spec, provider);
  const headers = buildHeaders(spec, provider);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: spec.transport.method,
      headers,
      body: spec.transport.contentType === "multipart/form-data"
        ? toFormData(upstreamBody)
        : JSON.stringify(upstreamBody),
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

  // Audio-style capabilities return bytes; hand them back untouched instead of
  // buffering + JSON-parsing what is not JSON.
  if (responseMode !== "json") {
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
    const contentType = response.headers.get("content-type") ?? undefined;
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
          binary: { body: new ArrayBuffer(0), stream: response.body, contentType },
        },
      };
    }
    return {
      ok: true,
      result: {
        items: [],
        successCount: 1,
        durationMs: now() - startedAt,
        binary: { body: await response.arrayBuffer(), contentType },
      },
    };
  }

  const rawText = await response.text();
  const rawPayload = decodeJson(rawText);

  // Spec-declared vendor errors are matched against the *raw* payload, because
  // that is where vendor error codes live (MiniMax answers HTTP 200 with a
  // non-zero `base_resp.status_code`).
  const ruleError = matchesRule(spec, rawPayload);
  if (ruleError) return { ok: false, error: ruleError };

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
    ? await resolveFetches(
        applyMapping(spec.response, rawPayload),
        makeFetcher(spec, provider, fetchImpl, args.signal),
      )
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
    const poll = await pollUntilDone({
      spec,
      provider,
      taskId,
      fetchImpl,
      signal: args.signal,
      now,
    });
    if (!poll.ok) return { ok: false, error: poll.error };
    return {
      ok: true,
      result: {
        items: collectItems(poll.payload),
        successCount: countOf(poll.payload),
        text: textOf(poll.payload),
        taskId,
        durationMs: now() - startedAt,
      },
    };
  }

  return {
    ok: true,
    result: {
      items: collectItems(mappedSubmit),
      successCount: countOf(mappedSubmit),
      text: textOf(mappedSubmit),
      durationMs: now() - startedAt,
    },
  };
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

/** Failure carries the error; success carries the mapped poll payload. */
type PollSettled = { ok: true; payload?: unknown } | { ok: false; error: MediaEngineError };

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
  const successValues = async_.poll.successValues ?? ["SUCCESS", "SUCCEEDED", "succeeded", "success"];
  const failureValues = async_.poll.failureValues ?? ["FAILED", "FAILURE", "failed", "cancelled"];
  const fetcher = makeFetcher(spec, provider, fetchImpl, args.signal);

  for (;;) {
    const path = async_.poll.path.replace("{{taskId}}", taskId);
    const url = buildUrl(spec, provider, path);
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
    const ruleError = matchesRule(spec, raw);
    if (ruleError) return { ok: false, error: ruleError };

    const mapped = spec.response
      ? await resolveFetches(applyMapping(spec.response, raw), fetcher)
      : undefined;
    const record = asRecord(mapped);
    const status =
      record && typeof record.status === "string" ? record.status : undefined;

    if (status && failureValues.includes(status)) {
      return {
        ok: false,
        error: errorFromMapped(mapped, {
          status: 502,
          code: "upstream_task_failed",
          message: `task ${status}`,
        }),
      };
    }
    if (!status || successValues.includes(status)) {
      if (!status && collectItems(mapped).length === 0 && !response.ok) {
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
        error: { status: 504, code: "task_timeout", message: "upstream task did not finish in time" },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
