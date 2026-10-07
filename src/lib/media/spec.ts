/**
 * src/lib/media/spec.ts
 *
 * The declarative **media adapter protocol** (specVersion 1 — the first and only version).
 *
 * A spec is data, not code: an operator edits it in the admin panel (or
 * imports an exported one) and the generic engine in ./engine executes it.
 * Nothing here is vendor-specific, which is the whole point — adding a vendor
 * must never require a code change or a redeploy.
 *
 * A spec lives under one media provider (base URL, credentials, client→upstream
 * model names) and serves exactly one `capability`.
 *
 * ## The mechanisms, and the failure each one closes
 *
 * Every mechanism below exists because a real spec, written by hand against a
 * real vendor's docs, failed in exactly that way. There is no version history to
 * read: this is the first version. The list is the specification's rationale.
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
     * state as both `Success` and `success`; `exact` restores strict matching.
     */
    statusMatch?: "exact" | "caseInsensitive";
    /**
     * Body for a `POST` poll. Some vendors take the task id in the body rather
     * than the path; mappings are evaluated with the request scope plus
     * `taskId`, so `{"task_ids": ["$.taskId"]}` works.
     */
    request?: MediaMapping;
    /** Overrides `transport.contentType` for the poll request. */
    contentType?: string;
  };
}

export interface MediaLimits {
  /** Largest `n` the upstream accepts; requests above it are rejected. */
  maxN?: number;
  timeoutMs?: number;
}

/** One voice, as a provider states it. */
export interface MediaVoiceEntry {
  /** The value to send as `voice`. Required — a voice you cannot name is not one. */
  id: string;
  /** Human-readable label. Shown when the vendor supplies one; never invented. */
  name?: string;
  description?: string;
  /**
   * The client models this voice works with.
   *
   * Absent means "not narrowed" — it applies to every model this spec serves.
   * That is different from "unknown", which is why the catalogue reports
   * `narrowed_by` alongside it: a vendor that says nothing about models and an
   * operator who has not looked are not the same claim.
   */
  models?: string[];
}

/**
 * How to read a vendor's voice list, if it has an endpoint for one.
 *
 * The response mapping is a `MediaMapping` producing
 * `{ voices: [ …MediaVoiceEntry | string ] }`. Entries may be the full object
 * or a bare id string, because vendors differ on how much they return and a
 * spec should not have to invent fields to satisfy the shape.
 */
export interface MediaVoiceRemote {
  transport: MediaTransport;
  auth?: MediaAuth;
  request?: MediaMapping;
  response: MediaMapping;
  limits?: MediaLimits;
}

/**
 * The voices this deployment can offer, from whatever the vendor makes
 * available.
 *
 * A vendor either has a voice endpoint, has a fixed set baked into its request
 * schema, or both — and none of those is the fallback for the others. OpenAI
 * has no voice endpoint at all: its thirteen voices live in the `voice`
 * parameter's type. For such a vendor a declaration *is* the correct source,
 * and calling it a fallback would be describing a first-class answer as a
 * consolation prize.
 *
 * Both sources may be present; entries are merged by id and keep the strongest
 * provenance available (see `narrowedBy` in the catalogue).
 */
export interface MediaVoiceCatalogue {
  remote?: MediaVoiceRemote;
  declared?: MediaVoiceEntry[];
}

export interface MediaSpec {
  specVersion: 1;
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
  /**
   * The voices this spec's models can be spoken with.
   *
   * Not under `metadata`: that is free-form passthrough, and a mistyped voice id
   * is a value the gateway would forward to a vendor on a live call. This is a
   * validated field for the same reason `request` and `response` are.
   */
  voices?: MediaVoiceCatalogue;
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

/** Content types the engine encodes structurally; anything else is sent raw. */
export const STRUCTURED_CONTENT_TYPES = [
  "application/json",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
] as const;

/** `type/subtype`, so raw bodies (`audio/wav`, `image/png`) are expressible. */
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * Allowed keys per level.
 *
 * Rejecting unknown keys only at the top level let every other typo through
 * silently: `transport.contenttype`, `limits.max_n` and `async.poll.body` all
 * parsed "successfully" and were then ignored, so the operator believed a
 * setting had taken effect when it had not. Silent acceptance of a typo is worse
 * than a loud rejection — that is the whole thesis of this protocol.
 */
const TRANSPORT_KEYS = new Set(["method", "path", "headers", "query", "contentType"]);
const AUTH_KEYS = new Set(["type", "name", "prefix"]);
const LIMITS_KEYS = new Set(["maxN", "timeoutMs"]);
const ASYNC_KEYS = new Set(["submitTaskId", "poll"]);
const POLL_KEYS = new Set([
  "method",
  "path",
  "intervalMs",
  "timeoutMs",
  "statusPath",
  "successValues",
  "failureValues",
  "statusMap",
  "statusMatch",
  "request",
  "contentType",
]);
const ERROR_RULE_KEYS = new Set(["when", "httpStatus", "status", "code", "message"]);
/**
 * Keys the engine actually reads out of a `response` mapping. Anything else is
 * a typo (`itemz`), which would otherwise surface much later as an empty result.
 */
const RESPONSE_KEYS = new Set([
  "items",
  "itemsB64",
  "successCount",
  "taskId",
  "status",
  "text",
  "errorCode",
  "errorMessage",
]);

/** Report every key that the engine will not read. */
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
  "voices",
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

/** Every `$.…` path string anywhere in a spec tree. */
function collectPaths(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 14 || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectPaths(entry, out, depth + 1);
    return out;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.startsWith("$.")) out.push(entry);
    else collectPaths(entry, out, depth + 1);
  }
  return out;
}

/**
 * The "`$file` outside multipart" error, or null when the request is fine.
 *
 * `$file` resolves to a File, and only a multipart form field has anywhere to put
 * one; in a JSON or urlencoded body the mapping serializes the File *object* into
 * the payload, so the upstream receives a stringified blob and nothing downstream
 * notices. An absent contentType means JSON (the engine's `?? "application/json"`),
 * so "unset" has to be judged too rather than skipped.
 *
 * Deliberately a standalone function: inlined into `parseMediaSpec`'s very long
 * condition chain, the minifier emitted a named function expression whose name
 * collided with a sibling binding and the whole server chunk failed to parse.
 */
function fileOutsideMultipartError(contentType: unknown, request: unknown): string | null {
  const body = typeof contentType === "string" ? contentType : "application/json";
  if (!(STRUCTURED_CONTENT_TYPES as readonly string[]).includes(body)) return null;
  if (body === "multipart/form-data") return null;
  if (!containsFileNode(request)) return null;
  const shown = contentType === undefined ? "(unset, defaults to application/json)" : `"${contentType}"`;
  return (
    `transport.contentType ${shown}: ` +
    "$file produces a file, which only multipart can carry " +
    "(it would be serialized into the body as an object). " +
    'Use "multipart/form-data", or drop the $file node'
  );
}

/** True if any node in the mapping tree is a `$file` transform. */
function containsFileNode(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsFileNode(entry, depth + 1));
  const record = value as Record<string, unknown>;
  if (typeof record.$file === "object" && record.$file !== null) return true;
  if (Array.isArray(record.$firstPresent)) {
    return record.$firstPresent.some((entry) => containsFileNode(entry, depth + 1));
  }
  return Object.values(record).some((entry) => containsFileNode(entry, depth + 1));
}

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
    // `$ifPresent` additionally accepts an ordered list of single-key branches
    // (pick the first whose key resolves), so it is checked separately.
    if ("$ifPresent" in record && Array.isArray(record.$ifPresent)) {
      record.$ifPresent.forEach((branch, index) => {
        const candidate = asRecord(branch);
        const keys = candidate ? Object.keys(candidate) : [];
        if (keys.length !== 1) {
          errors.push(
            `${path}.$ifPresent[${index}]: each branch must be an object with exactly one path key, e.g. { "$.url": <mapping> }`,
          );
          return;
        }
        validateMapping(candidate![keys[0]], `${path}.$ifPresent[${index}].${keys[0]}`, errors);
      });
      return;
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
 * `$enum.byModel` / `$mapSize.byModel`: an override table keyed by the *upstream*
 * model name, so one spec can serve model tiers with different capabilities
 * (MiniMax `MiniMax-H3` accepts `2K`, `MiniMax-H3-Max` does not).
 */
function validateByModel(
  params: Record<string, unknown>,
  tableKey: "map" | "table",
  path: string,
  errors: string[],
): void {
  const byModel = params.byModel;
  if (byModel === undefined) return;
  const record = asRecord(byModel);
  if (!record) {
    errors.push(`${path}.byModel: expected an object keyed by upstream model name`);
    return;
  }
  const declared = asRecord(params[tableKey]);
  for (const [model, override] of Object.entries(record)) {
    if (!model) {
      errors.push(`${path}.byModel: model names must be non-empty`);
      continue;
    }
    const table = asRecord(override);
    if (!table) {
      errors.push(`${path}.byModel.${model}: expected an object of ${tableKey} entries`);
      continue;
    }
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        errors.push(`${path}.byModel.${model}.${key}: expected a string value`);
        continue;
      }
      // An override that silently re-maps a key the shared table does not know
      // is almost always a typo in one of the two.
      if (declared && !(key in declared)) {
        errors.push(
          `${path}.byModel.${model}.${key}: not present in the shared ${tableKey} — override keys must exist there`,
        );
      }
    }
  }
}

/** Walk a mapping tree looking for `$enum` / `$mapSize` nodes to check `byModel`. */
function validateByModelTables(
  node: unknown,
  path: string,
  errors: string[],
): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => validateByModelTables(item, `${path}[${index}]`, errors));
    return;
  }
  const record = asRecord(node);
  if (!record) return;
  for (const key of ["$enum", "$mapSize"] as const) {
    if (key in record) {
      const params = asRecord(record[key]);
      if (params) validateByModel(params, key === "$enum" ? "map" : "table", `${path}.${key}`, errors);
    }
  }
  for (const [childKey, child] of Object.entries(record)) {
    if (typeof child === "object") validateByModelTables(child, `${path}.${childKey}`, errors);
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

  if (root.specVersion !== 1) {
    errors.push("specVersion: must be 1");
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
    rejectUnknownKeys(transport, TRANSPORT_KEYS, "transport", errors);
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
      (typeof transport.contentType !== "string" || !MEDIA_TYPE.test(transport.contentType))
    ) {
      errors.push(
        `transport.contentType: must be a media type such as ${STRUCTURED_CONTENT_TYPES.join(", ")}`,
      );
    }
    if (
      String(transport.method) === "GET" &&
      transport.contentType === "multipart/form-data"
    ) {
      errors.push("transport.contentType: a GET request cannot carry a body");
    }
    // A non-structural media type means "the body *is* the file", so the request
    // mapping has to be a single `$file` node — otherwise there is nothing to
    // send and the upstream would receive an empty body.
    if (
      typeof transport.contentType === "string" &&
      MEDIA_TYPE.test(transport.contentType) &&
      !(STRUCTURED_CONTENT_TYPES as readonly string[]).includes(transport.contentType)
    ) {
      if (String(transport.method) === "GET") {
        errors.push("transport.contentType: a GET request cannot carry a body");
      }
      const request = asRecord(root.request);
      const keys = request ? Object.keys(request) : [];
      const isSingleFile = keys.length === 1 && keys[0] === "$file";
      if (!isSingleFile) {
        errors.push(
          `transport.contentType "${transport.contentType}": a raw media type sends the file bytes as the whole body, so \`request\` must be a single \`$file\` node`,
        );
      }
    }
    // The mirror image of the raw-media-type rule above.
    const fileError = fileOutsideMultipartError(transport.contentType, root.request);
    if (fileError) errors.push(fileError);
  }

  // Wildcard paths are the quietest failure in the protocol: `$.data[*].url`
  // parses and resolves to `undefined`, so the symptom surfaces far away as
  // "upstream returned no items" and reads like a vendor schema change. `getPath`
  // only understands numeric indices.
  for (const path of new Set(collectPaths(root))) {
    if (!path.includes("[*]")) continue;
    errors.push(
      `path ${path}: 通配符 [*] 取不到值（路径只认数字下标，如 ${path.replaceAll("[*]", "[0]")}）。` +
        "要「数组里每个元素的某个字段」请用 items 的 $from/$to，让数组本身成为 scope",
    );
  }

  const auth = asRecord(root.auth);
  if (!auth) {
    errors.push("auth: required object");
  } else {
    rejectUnknownKeys(auth, AUTH_KEYS, "auth", errors);
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

  if (root.request !== undefined) {
    validateMapping(root.request, "request", errors);
    validateByModelTables(root.request, "request", errors);
  }
  if (root.response !== undefined) {
    validateMapping(root.response, "response", errors);
    const response = asRecord(root.response);
    // A transform node (`$merge`, …) has no contract keys to typo.
    if (response && !Object.keys(response).some((key) => key.startsWith("$"))) {
      rejectUnknownKeys(response, RESPONSE_KEYS, "response", errors);
    }
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
        rejectUnknownKeys(record, ERROR_RULE_KEYS, `errors[${index}]`, errors);
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
      rejectUnknownKeys(asyncBlock, ASYNC_KEYS, "async", errors);
      if (typeof asyncBlock.submitTaskId !== "string") {
        errors.push("async.submitTaskId: required string");
      }
      const poll = asRecord(asyncBlock.poll);
      if (!poll) {
        errors.push("async.poll: required object");
      } else {
        rejectUnknownKeys(poll, POLL_KEYS, "async.poll", errors);
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
        if (poll.intervalMs !== undefined) {
          const interval = poll.intervalMs;
          if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
            errors.push(
              "async.poll.intervalMs: must be a positive number — 0 would busy-loop against the upstream for the whole timeout",
            );
          }
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
      rejectUnknownKeys(limits, LIMITS_KEYS, "limits", errors);
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

  const voices = parseVoices(root, errors, warnings);

  if (errors.length > 0) return { ok: false, errors, warnings };

  const transportRecord = transport as Record<string, unknown>;

  return {
    ok: true,
    warnings,
    spec: {
      specVersion: 1,
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
      ...(voices ? { voices } : {}),
      ...(asRecord(root.metadata) ? { metadata: root.metadata as Record<string, unknown> } : {}),
    },
  };
}

/**
 * Read and check the voice catalogue.
 *
 * Returns undefined for an absent one, and pushes onto the caller's `errors` /
 * `warnings` for a broken one — a mistyped id here becomes a value forwarded to
 * a vendor on a live call, so it is validated the same way `transport` and
 * `response` are rather than being passed through.
 */
function parseVoices(
  root: Record<string, unknown>,
  errors: string[],
  warnings: string[],
): MediaVoiceCatalogue | undefined {
  if (root.voices === undefined) return undefined;
  const catalogue = asRecord(root.voices);
  if (!catalogue) {
    errors.push("voices: expected an object with `remote` and/or `declared`");
    return undefined;
  }

  const out: MediaVoiceCatalogue = {};

  if (catalogue.remote !== undefined) {
    const remote = asRecord(catalogue.remote);
    if (!remote) {
      errors.push("voices.remote: expected an object");
    } else {
      const transport = asRecord(remote.transport);
      if (!transport || typeof transport.method !== "string" || typeof transport.path !== "string") {
        errors.push("voices.remote.transport: needs `method` and `path`");
      }
      if (!asRecord(remote.response)) {
        errors.push("voices.remote.response: expected a mapping");
      }
      if (remote.auth !== undefined && !asRecord(remote.auth)) {
        errors.push("voices.remote.auth: expected an object");
      }
      if (transport && asRecord(remote.response)) {
        out.remote = {
          transport: transport as unknown as MediaTransport,
          ...(asRecord(remote.auth) ? { auth: remote.auth as MediaAuth } : {}),
          ...(remote.request !== undefined ? { request: remote.request as MediaMapping } : {}),
          response: remote.response as MediaMapping,
          ...(asRecord(remote.limits) ? { limits: remote.limits as MediaLimits } : {}),
        };
      }
    }
  }

  if (catalogue.declared !== undefined) {
    if (!Array.isArray(catalogue.declared)) {
      errors.push("voices.declared: expected an array");
    } else {
      const seen = new Set<string>();
      const entries: MediaVoiceEntry[] = [];
      catalogue.declared.forEach((raw, i) => {
        const entry = asRecord(raw);
        const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) {
          errors.push(`voices.declared[${i}]: needs a non-empty string \`id\``);
          return;
        }
        if (seen.has(id)) {
          warnings.push(`voices.declared: "${id}" is listed more than once`);
          return;
        }
        seen.add(id);
        const models = entry!.models;
        if (models !== undefined && !Array.isArray(models)) {
          errors.push(`voices.declared[${i}].models: expected an array of client model names`);
          return;
        }
        entries.push({
          id,
          ...(typeof entry!.name === "string" ? { name: entry!.name } : {}),
          ...(typeof entry!.description === "string" ? { description: entry!.description } : {}),
          ...(Array.isArray(models)
            ? { models: models.filter((m): m is string => typeof m === "string") }
            : {}),
        });
      });
      out.declared = entries;
    }
  }

  if (out.remote === undefined && (out.declared?.length ?? 0) === 0) {
    warnings.push(
      "voices: declared but neither a usable `remote` nor any `declared` entry — this spec contributes no voices",
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

  // Scoping is per *provider*, not per capability. With two unscoped specs the
  // model catalog cannot tell them apart: `specServingModel` falls back to "the
  // first unscoped spec", so a model served by the second one is advertised with
  // the first one's capability, modes and async flag. The request path still works
  // (it is capability-first), so nothing errors — the catalog is simply wrong,
  // which is the failure mode this project treats as worst. Observed in practice
  // while configuring MiniMax: four capabilities, one spec each, none scoped.
  const unscopedAll = parsed.filter((entry) => !entry.models);
  if (unscopedAll.length > 1) {
    errors.push(
      `specs[${unscopedAll.map((e) => e.index).join("],[")}]: ` +
        `${unscopedAll.length} specs do not list \`models\`. Every model would eagerly match all of them, ` +
        `so the model catalog labels it with whichever comes first — give every spec a \`models\` array ` +
        `(one spec per provider may stay unscoped)`,
    );
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
    // `responseMode` other than `json` returns bytes/stream without consulting
    // `response`, so the items rule only applies to JSON-mode specs.
    if (String(spec?.responseMode ?? "json") !== "json") continue;
    if (spec?.allowEmpty === true) continue;
    const response = asRecord(spec?.response);
    if (!response) {
      errors.push(
        `specs[${entry.index}]: "${entry.capability}" has no \`response\` mapping, so every call would return nothing and be charged 0 — add it, or set "allowEmpty": true if an empty result is legitimate`,
      );
      continue;
    }
    if (response.items === undefined && response.itemsB64 === undefined && response.text === undefined) {
      errors.push(
        `specs[${entry.index}].response: "${entry.capability}" must map \`items\` (or \`itemsB64\`) — or opt out with the top-level \`allowEmpty\``,
      );
    }
  }

  return { errors, warnings };
}
