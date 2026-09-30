/**
 * src/lib/media/spec.ts
 *
 * The declarative **media adapter protocol** (specVersion 2).
 *
 * A spec is data, not code: an operator edits it in the admin panel (or
 * imports an exported one) and the generic engine in ./engine executes it.
 * Nothing here is vendor-specific, which is the whole point — adding a vendor
 * must never require a code change or a redeploy.
 *
 * A spec lives under one media provider (base URL, credentials, client→upstream
 * model names) and serves exactly one `capability`.
 *
 * ## Why v2
 *
 * v1 was validated by replaying four independently written MiniMax specs
 * through the real engine. Every recurring failure came from one of five
 * protocol gaps, and each is now closed here:
 *
 *  1. **Two vendor API versions of the same capability could not coexist.**
 *     Specs were picked by `capability` alone and the first match won, so a
 *     V2 spec silently shadowed by a V1 one. → `spec.models` scopes a spec to
 *     named client models, and `validateMediaSpecs` rejects ambiguous sets.
 *  2. **`$.response_format` vs `$.responseFormat`.** Endpoints normalized some
 *     fields and passed the raw body through for others, so the same spec key
 *     worked on one endpoint and silently defaulted on another. → every
 *     endpoint passes the raw body through, and `buildMediaScope` exposes every
 *     key under both its snake_case and camelCase spelling.
 *  3. **Upstream encodings had to be guessed.** A `hex` payload mapped as
 *     `base64` produced garbage with no error anywhere. → `items[].encoding`
 *     states what the upstream returned and the engine normalizes it.
 *  4. **Error vocabularies differ per vendor *and* per version.** MiniMax V1
 *     answers HTTP 200 with a non-zero `base_resp.status_code`; V2 answers a
 *     real HTTP status with `error.type`. → error rules can match
 *     `httpStatus` as well as `when`.
 *  5. **A success could look like a hang.** Async status vocabularies are
 *     inconsistently cased across a vendor's own pages. → status matching is
 *     case-insensitive by default, `statusMap` normalizes whole vocabularies,
 *     and a timeout reports the last status actually observed.
 *
 * Mapping trees (`request` / `response`) are a closed set of shapes the engine
 * understands. Anything else is rejected at validation time so a typo surfaces
 * in the admin panel instead of at 3am on a live request.
 */

/** Normalized media capabilities this protocol can describe. */
export const MEDIA_CAPABILITIES = [
  "image.generate",
  "image.edit",
  "video.generate",
  "audio.tts",
  "audio.stt",
  "music.generate",
] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

export function isMediaCapability(value: unknown): value is MediaCapability {
  return (
    typeof value === "string" &&
    (MEDIA_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Capabilities that must produce at least one item to be considered a success. */
const ITEM_PRODUCING_CAPABILITIES: ReadonlySet<string> = new Set<MediaCapability>([
  "image.generate",
  "image.edit",
  "video.generate",
  "audio.tts",
  "music.generate",
]);

/** Authentication the engine attaches to the upstream call. */
export type MediaAuth =
  | { type: "bearer" }
  | { type: "header"; name: string; prefix?: string }
  | { type: "query"; name: string }
  | { type: "none" };

export interface MediaTransport {
  /** `GET` is only useful for a stateless retrieve-style endpoint. */
  method: "POST" | "GET" | "PUT" | "PATCH";
  /**
   * Path relative to the base URL, e.g. "/v1/image_generation".
   *
   * May contain `{{model}}` (the URL-encoded upstream model name) for
   * path-style APIs. `{{taskId}}` is only valid on `async.poll.path`.
   */
  path: string;
  /**
   * Extra request headers. Values are mappings, so a value can come from the
   * client request (MiniMax's ASR takes `language` as a header); a mapping
   * that resolves to `undefined` drops the header.
   */
  headers?: Record<string, MediaMapping>;
  /** Query parameters; same mapping rules as `headers`. */
  query?: Record<string, MediaMapping>;
  contentType?:
    | "application/json"
    | "multipart/form-data"
    | "application/x-www-form-urlencoded";
}

export interface MediaErrorRule {
  /** A mapping expression; when it resolves `true` the rule fires. */
  when?: MediaMapping;
  /**
   * Upstream HTTP status (or statuses) that fire this rule.
   *
   * Needed for vendors that signal failures with a real status code instead of
   * an in-body code (OpenAI, MiniMax video V2, most modern APIs).
   */
  httpStatus?: number | number[];
  /** Status returned to the client. */
  status: number;
  code: string;
  message?: string;
}

/** Canonical terminal state a `statusMap` entry can normalize to. */
export type MediaTaskState = "ok" | "fail" | "wait";

export interface MediaAsync {
  /** Path to the submitted task id, e.g. "$.task_id". */
  submitTaskId: string;
  poll: {
    method: "GET" | "POST";
    /** May contain {{taskId}}. */
    path: string;
    intervalMs?: number;
    timeoutMs?: number;
    /** Path to the task status inside the (mapped) poll payload. */
    statusPath?: string;
    /** Terminal states that mean success. */
    successValues?: string[];
    /** Terminal states that mean failure. */
    failureValues?: string[];
    /**
     * Normalizes a whole vendor vocabulary in one shot, e.g.
     * `{"Success":"ok","Fail":"fail","Preparing":"wait","Queueing":"wait"}`.
     * Takes precedence over `successValues` / `failureValues`.
     */
    statusMap?: Record<string, MediaTaskState>;
    /**
     * `caseInsensitive` (default) because a single vendor documents the same
     * state as both `Success` and `success`; `exact` restores v1 behaviour.
     */
    statusMatch?: "exact" | "caseInsensitive";
  };
}

export interface MediaLimits {
  /** Largest `n` the upstream accepts; requests above it are rejected. */
  maxN?: number;
  timeoutMs?: number;
}

export interface MediaSpec {
  specVersion: 2;
  capability: MediaCapability;
  displayName?: string;
  /**
   * Client model names (`models` keys of this provider) this spec serves.
   *
   * Omit it to serve every model of this capability. Required in practice once
   * a provider has two specs of the same capability — a vendor that ships both
   * a v1 and a v2 API cannot be described without it.
   */
  models?: string[];
  /** Overrides the provider base URL (e.g. a different region per API version). */
  baseUrl?: string;
  transport: MediaTransport;
  auth: MediaAuth;
  request?: MediaMapping;
  response?: MediaMapping;
  /**
   * How to read the upstream body.
   *
   * - `json` (default): the `response` mapping applies.
   * - `sse`: the body is a text/event-stream; the mapping is applied to every
   *   `data:` event and the url items are concatenated.
   * - `binary`: bytes are passed straight through (TTS-style audio).
   * - `stream`: the upstream body is streamed through without buffering.
   */
  responseMode?: "json" | "binary" | "stream" | "sse";
  errors?: MediaErrorRule[];
  async?: MediaAsync;
  limits?: MediaLimits;
  /**
   * Escape hatch for a mapped 2xx that legitimately yields no items — a
   * content-filtered image, a vendor that returns a placeholder while the real
   * work happens asynchronously. Without it such a response is reported as
   * `upstream_contract_mismatch` instead of silently succeeding and charging 0.
   */
  allowEmpty?: boolean;
  /** Free-form hints surfaced through `/v1/models` under `relay`. */
  metadata?: Record<string, unknown>;
}

/**
 * A node in a mapping tree. `unknown` on purpose: the shape is checked
 * structurally by `parseMediaSpec`: a recursive schema union would reject
 * perfectly valid operator input for reasons that are hard to explain.
 */
export type MediaMapping = unknown;

/** What the upstream actually returned for an item, and how to normalize it. */
export const MEDIA_ITEM_ENCODINGS = ["plain", "base64", "hex", "dataUrl"] as const;

const CONTENT_TYPES = [
  "application/json",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
] as const;

/** Top-level spec keys, so a typo like `respone` is reported at save time. */
const SPEC_KEYS = new Set([
  "specVersion",
  "capability",
  "displayName",
  "models",
  "baseUrl",
  "transport",
  "auth",
  "request",
  "response",
  "responseMode",
  "errors",
  "async",
  "limits",
  "allowEmpty",
  "metadata",
]);

/** Keys the engine interprets; a mapping object may only use these. */
const TRANSFORM_KEYS = [
  "$const",
  "$ifPresent",
  "$enum",
  "$mapSize",
  "$dataUrl",
  "$from",
  "$to",
  "$merge",
  "$eq",
  "$file",
  "$fetch",
  "$firstPresent",
  "$toString",
] as const;

export interface MediaModelConfig {
  /** Upstream model name sent to the vendor. */
  upstreamId: string;
  /**
   * **Whole 积分 charged per successfully produced media item** (0 = free).
   *
   * This is the number the operator types, so 100 means "100 积分 per image".
   * Storage uses 0.001-积分 units; `computeMediaCredits` performs the ×1000
   * conversion, so never pre-scale this field.
   */
  pricePerItem: number;
  enabled: boolean;
}

export interface MediaProvider {
  id: string;
  name: string;
  /** Base URL every spec's `transport.path` is resolved against. */
  baseUrl: string;
  encryptedApiKey: string;
  enabled: boolean;
  priority: number;
  models: Record<string, MediaModelConfig>;
  specs: MediaSpec[];
  createdAt: string;
  updatedAt: string;
}

export type PublicMediaProvider = Omit<MediaProvider, "encryptedApiKey">;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SpecParse =
  | { ok: true; spec: MediaSpec; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An array of strings, or an empty list (so validation can report the problem). */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function validateMapping(
  node: MediaMapping,
  path: string,
  errors: string[],
): void {
  if (node === null || node === undefined) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => validateMapping(item, `${path}[${index}]`, errors));
    return;
  }
  const record = asRecord(node);
  if (!record) {
    errors.push(`${path}: unsupported mapping value`);
    return;
  }

  const keys = Object.keys(record);
  const transformKeys = keys.filter((key) =>
    (TRANSFORM_KEYS as readonly string[]).includes(key),
  );

  if (transformKeys.length > 0) {
    // A transform node: every key must be one the engine knows, and the values
    // they carry are themselves mappings (so a nested mistake is reported with
    // a path rather than blowing up at request time).
    for (const key of keys) {
      if (!(TRANSFORM_KEYS as readonly string[]).includes(key)) {
        errors.push(`${path}.${key}: not a transform (found ${key}) in a transform node`);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "object") validateMapping(value, `${path}.${key}`, errors);
    }
    return;
  }

  // A plain object: every value must itself be a mapping.
  for (const [key, value] of Object.entries(record)) {
    validateMapping(value, `${path}.${key}`, errors);
  }
}

/** `headers` / `query` take string literals or mappings as values. */
function validateMappingMap(
  value: unknown,
  path: string,
  errors: string[],
): void {
  const record = asRecord(value);
  if (!record) {
    errors.push(`${path}: expected an object of string or mapping values`);
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      validateMapping(entry, `${path}.${key}`, errors);
      continue;
    }
    errors.push(`${path}.${key}: expected a string or a mapping`);
  }
}

/**
 * Parse and structurally validate an operator-authored spec.
 *
 * Deliberately permissive about *values* (the engine ignores what it does not
 * recognise) and strict about *shape*, so a broken spec is rejected in the
 * admin panel rather than mid-traffic.
 */
export function parseMediaSpec(raw: unknown): SpecParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = asRecord(raw);
  if (!root) return { ok: false, errors: ["spec: expected a JSON object"], warnings };

  for (const key of Object.keys(root)) {
    if (!SPEC_KEYS.has(key)) {
      errors.push(`${key}: unknown spec field (typo?)`);
    }
  }

  if (root.specVersion !== 2) {
    errors.push(
      root.specVersion === 1
        ? "specVersion: this relay speaks version 2 only — re-import the spec from /admin/docs/media (v1 could not scope a spec to a model, match errors by HTTP status, or declare upstream encoding)"
        : "specVersion: only 2 is supported",
    );
  }
  if (!isMediaCapability(root.capability)) {
    errors.push(`capability: must be one of ${MEDIA_CAPABILITIES.join(", ")}`);
  }

  if (root.models !== undefined) {
    const list = Array.isArray(root.models) ? root.models : null;
    if (!list || list.length === 0) {
      errors.push("models: must be a non-empty array of client model names (omit the field to serve every model)");
    } else if (list.some((entry) => typeof entry !== "string" || !entry)) {
      errors.push("models: every entry must be a non-empty string");
    }
  }

  if (root.baseUrl !== undefined) {
    if (typeof root.baseUrl !== "string" || !/^https?:\/\//.test(root.baseUrl)) {
      errors.push("baseUrl: must be an http(s) URL");
    }
  }

  const transport = asRecord(root.transport);
  if (!transport) {
    errors.push("transport: required object");
  } else {
    if (!["POST", "GET", "PUT", "PATCH"].includes(String(transport.method))) {
      errors.push("transport.method: must be POST, GET, PUT or PATCH");
    }
    if (typeof transport.path === "string" && transport.path.includes("{{taskId}}")) {
      errors.push(
        "transport.path: {{taskId}} is only substituted on `async.poll.path`, never on the submit request",
      );
    }
    if (typeof transport.path === "string") {
      // `{{model}}` is the only placeholder allowed here; anything left over
      // once it is removed is a typo rather than a feature.
      const leftover = transport.path.replace(/\{\{\s*model\s*\}\}/g, "");
      if (leftover.includes("{{") || leftover.includes("}}")) {
        errors.push(
          "transport.path: the only placeholder allowed on the submit path is {{model}}",
        );
      }
    }
    if (typeof transport.path !== "string" || !transport.path.startsWith("/")) {
      errors.push('transport.path: must be a string starting with "/"');
    }
    if (transport.headers !== undefined) {
      validateMappingMap(transport.headers, "transport.headers", errors);
    }
    if (transport.query !== undefined) {
      validateMappingMap(transport.query, "transport.query", errors);
    }
    if (
      transport.contentType !== undefined &&
      !(CONTENT_TYPES as readonly unknown[]).includes(transport.contentType)
    ) {
      errors.push(
        `transport.contentType: must be one of ${CONTENT_TYPES.join(", ")}`,
      );
    }
    if (
      String(transport.method) === "GET" &&
      transport.contentType === "multipart/form-data"
    ) {
      errors.push("transport.contentType: a GET request cannot carry a body");
    }
  }

  const auth = asRecord(root.auth);
  if (!auth) {
    errors.push("auth: required object");
  } else {
    const type = auth.type;
    if (!["bearer", "header", "query", "none"].includes(String(type))) {
      errors.push("auth.type: must be bearer, header, query or none");
    }
    if (type === "header" || type === "query") {
      if (typeof auth.name !== "string" || !auth.name) {
        errors.push(`auth.name: required for auth.type=${String(type)}`);
      }
    }
  }

  if (root.request !== undefined) validateMapping(root.request, "request", errors);
  if (root.response !== undefined) {
    validateMapping(root.response, "response", errors);
    const response = asRecord(root.response);
    if (response && response.allowEmpty !== undefined) {
      errors.push("response.allowEmpty: put `allowEmpty` at the spec top level, not inside `response`");
    }
    if (response && response.items === undefined && response.text === undefined) {
      warnings.push(
        "response: declares neither `items` nor `text`, so the client will always get an empty result",
      );
    }
  }
  if (root.request === undefined && String(root.responseMode ?? "json") !== "json") {
    warnings.push("request: absent, so the upstream receives an empty body");
  }
  if (
    root.responseMode !== undefined &&
    !["json", "binary", "stream", "sse"].includes(String(root.responseMode))
  ) {
    errors.push("responseMode: must be json, binary, stream or sse");
  }

  if (root.errors !== undefined) {
    const list = Array.isArray(root.errors) ? root.errors : null;
    if (!list) {
      errors.push("errors: expected an array");
    } else {
      list.forEach((rule, index) => {
        const record = asRecord(rule);
        if (!record) {
          errors.push(`errors[${index}]: expected an object`);
          return;
        }
        if (typeof record.status !== "number") {
          errors.push(`errors[${index}].status: required number`);
        }
        if (typeof record.code !== "string" || !record.code) {
          errors.push(`errors[${index}].code: required string`);
        }
        const hasWhen = record.when !== undefined;
        const hasHttp = record.httpStatus !== undefined;
        if (!hasWhen && !hasHttp) {
          errors.push(
            `errors[${index}]: needs \`when\` (a mapping over the raw payload) and/or \`httpStatus\` — without either the rule can never fire`,
          );
        }
        if (record.httpStatus !== undefined) {
          const value = record.httpStatus;
          const list = Array.isArray(value) ? value : [value];
          if (list.length === 0 || list.some((entry) => typeof entry !== "number")) {
            errors.push(`errors[${index}].httpStatus: must be a number or an array of numbers`);
          }
        }
        if (record.when !== undefined) {
          validateMapping(record.when, `errors[${index}].when`, errors);
        }
      });
    }
  }

  if (root.async !== undefined) {
    const asyncBlock = asRecord(root.async);
    if (!asyncBlock) {
      errors.push("async: expected an object");
    } else {
      if (typeof asyncBlock.submitTaskId !== "string") {
        errors.push("async.submitTaskId: required string");
      }
      const poll = asRecord(asyncBlock.poll);
      if (!poll) {
        errors.push("async.poll: required object");
      } else {
        const pollPath = typeof poll.path === "string" ? poll.path : "";
        const successValues = asStringList(poll.successValues);
        const failureValues = asStringList(poll.failureValues);

        if (!pollPath.startsWith("/")) {
          errors.push('async.poll.path: must be a string starting with "/"');
        } else if (!pollPath.includes("{{taskId}}")) {
          warnings.push(
            "async.poll.path: has no {{taskId}}, so every poll would query the same URL",
          );
        }
        if (poll.method !== undefined && poll.method !== "GET" && poll.method !== "POST") {
          errors.push("async.poll.method: must be GET or POST");
        }
        const map = poll.statusMap === undefined ? null : asRecord(poll.statusMap);
        if (poll.statusMap !== undefined && !map) {
          errors.push("async.poll.statusMap: expected an object of vendor state -> ok|fail|wait");
        }
        if (map) {
          for (const [state, target] of Object.entries(map)) {
            if (!["ok", "fail", "wait"].includes(String(target))) {
              errors.push(
                `async.poll.statusMap.${state}: must be "ok", "fail" or "wait" (got ${JSON.stringify(target)})`,
              );
            }
          }
          if (map[""] === undefined) {
            errors.push(
              'async.poll.statusMap: add a `""` entry as the catch-all, otherwise an unseen state can hang the poll until timeout',
            );
          }
        }
        if (!map && successValues.length === 0 && failureValues.length === 0) {
          errors.push(
            "async.poll: needs successValues + failureValues, or a statusMap — without either, no status can ever terminate the poll",
          );
        }
        if (poll.statusMatch !== undefined && poll.statusMatch !== "exact" && poll.statusMatch !== "caseInsensitive") {
          errors.push('async.poll.statusMatch: must be "exact" or "caseInsensitive"');
        }
      }
    }
  }

  if (root.limits !== undefined) {
    const limits = asRecord(root.limits);
    if (!limits) {
      errors.push("limits: expected an object");
    } else {
      for (const key of ["maxN", "timeoutMs"]) {
        const value = limits[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
          errors.push(`limits.${key}: expected a finite number`);
        }
      }
      const timeout = limits.timeoutMs;
      if (typeof timeout === "number" && timeout > 300_000) {
        errors.push(
          "limits.timeoutMs: 300000 is the serverless ceiling — a longer timeout can never be honoured",
        );
      }
    }
  }

  if (root.metadata !== undefined && !asRecord(root.metadata)) {
    errors.push("metadata: expected an object");
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const transportRecord = transport as Record<string, unknown>;

  return {
    ok: true,
    warnings,
    spec: {
      specVersion: 2,
      capability: root.capability as MediaCapability,
      ...(typeof root.displayName === "string" ? { displayName: root.displayName } : {}),
      ...(Array.isArray(root.models) ? { models: root.models as string[] } : {}),
      ...(typeof root.baseUrl === "string" ? { baseUrl: root.baseUrl } : {}),
      transport: {
        method: transportRecord.method as MediaTransport["method"],
        path: transportRecord.path as string,
        ...(transportRecord.headers
          ? { headers: transportRecord.headers as Record<string, MediaMapping> }
          : {}),
        ...(transportRecord.query
          ? { query: transportRecord.query as Record<string, MediaMapping> }
          : {}),
        ...(transportRecord.contentType
          ? { contentType: transportRecord.contentType as MediaTransport["contentType"] }
          : {}),
      },
      auth: auth as MediaAuth,
      ...(root.request !== undefined ? { request: root.request } : {}),
      ...(root.response !== undefined ? { response: root.response } : {}),
      ...(["json", "binary", "stream", "sse"].includes(String(root.responseMode))
        ? { responseMode: root.responseMode as MediaSpec["responseMode"] }
        : {}),
      ...(Array.isArray(root.errors) ? { errors: root.errors as MediaErrorRule[] } : {}),
      ...(root.async !== undefined ? { async: root.async as MediaAsync } : {}),
      ...(root.limits !== undefined ? { limits: root.limits as MediaLimits } : {}),
      ...(root.allowEmpty === true ? { allowEmpty: true } : {}),
      ...(asRecord(root.metadata) ? { metadata: root.metadata as Record<string, unknown> } : {}),
    },
  };
}

/**
 * Cross-spec validation, run by the admin API before a provider is stored.
 *
 * The important rule: a provider may hold several specs of the same capability
 * (a vendor with both a v1 and a v2 API), but then **every** one of them must
 * say which models it serves. Otherwise spec selection — which is by capability
 * first — would silently pick the first match and send, say, a v2 model to the
 * v1 endpoint.
 */
export function validateMediaSpecs(specs: unknown): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = Array.isArray(specs) ? specs : [];
  const parsed: { capability: MediaCapability; models?: string[]; index: number }[] = [];

  list.forEach((entry, index) => {
    const result = parseMediaSpec(entry);
    if (!result.ok) {
      errors.push(...result.errors);
      return;
    }
    warnings.push(...result.warnings);
    parsed.push({
      capability: result.spec.capability,
      ...(result.spec.models ? { models: result.spec.models } : {}),
      index,
    });
  });

  const byCapability = new Map<MediaCapability, typeof parsed>();
  for (const entry of parsed) {
    const bucket = byCapability.get(entry.capability) ?? [];
    bucket.push(entry);
    byCapability.set(entry.capability, bucket);
  }

  for (const [capability, bucket] of byCapability) {
    if (bucket.length < 2) continue;
    const unscoped = bucket.filter((entry) => !entry.models);
    if (unscoped.length > 0) {
      errors.push(
        `specs[${unscoped.map((e) => e.index).join("],[")}]: ${bucket.length} specs serve "${capability}" but ` +
          `${unscoped.length} of them do not list \`models\`, so only the first would ever run — add a \`models\` array to each`,
      );
    }
    const seen = new Map<string, number>();
    for (const entry of bucket) {
      for (const model of entry.models ?? []) {
        const previous = seen.get(model);
        if (previous !== undefined) {
          errors.push(
            `specs[${entry.index}].models: "${model}" is already served by specs[${previous}] for "${capability}"`,
          );
        }
        seen.set(model, entry.index);
      }
    }
  }

  for (const entry of parsed) {
    if (!ITEM_PRODUCING_CAPABILITIES.has(entry.capability)) continue;
    const spec = asRecord(list[entry.index]);
    const response = asRecord(spec?.response);
    if (response && response.items === undefined && response.text === undefined) {
      errors.push(
        `specs[${entry.index}].response: "${entry.capability}" must map \`items\` (or opt out with the top-level \`allowEmpty\`)`,
      );
    }
  }

  return { errors, warnings };
}
