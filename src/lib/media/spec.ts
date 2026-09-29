/**
 * src/lib/media/spec.ts
 *
 * The declarative **media adapter protocol** (specVersion 1).
 *
 * A spec is data, not code: an operator edits it in the admin panel (or
 * imports an exported one) and the generic engine in ./engine executes it.
 * Nothing here is vendor-specific, which is the whole point — adding a vendor
 * must never require a code change or a redeploy.
 *
 * A spec is scoped to one `capability` and lives under one media provider that
 * supplies the base URL, credentials and the client→upstream model names.
 *
 * Mapping trees (`request` / `response`) are a small, closed set of shapes the
 * engine understands. Anything else is rejected at validation time so a typo
 * surfaces in the admin panel instead of at 3am on a request.
 */
import { z } from "zod";

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

/** Authentication the engine attaches to the upstream call. */
export type MediaAuth =
  | { type: "bearer" }
  | { type: "header"; name: string; prefix?: string }
  | { type: "query"; name: string }
  | { type: "none" };

export interface MediaTransport {
  method: "POST" | "GET";
  /** Path relative to the provider base URL, e.g. "/v1/image_generation". */
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  contentType?: "application/json" | "multipart/form-data";
}

export interface MediaErrorRule {
  /** A mapping expression; when it resolves truthy the rule fires. */
  when?: MediaMapping;
  status: number;
  code: string;
  message?: string;
}

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
    successValues?: string[];
    failureValues?: string[];
  };
}

export interface MediaLimits {
  /** Largest `n` the upstream accepts; requests above it are rejected. */
  maxN?: number;
  timeoutMs?: number;
}

export interface MediaSpec {
  specVersion: 1;
  capability: MediaCapability;
  displayName?: string;
  transport: MediaTransport;
  auth: MediaAuth;
  request?: MediaMapping;
  response?: MediaMapping;
  /**
   * How to read the upstream body.
   *
   * - `json` (default): the `response` mapping applies.
   * - `binary`: bytes are passed straight through (TTS-style audio).
   * - `stream`: the upstream body is streamed through without buffering.
   */
  responseMode?: "json" | "binary" | "stream";
  errors?: MediaErrorRule[];
  async?: MediaAsync;
  limits?: MediaLimits;
  /** Free-form hints surfaced through `/v1/models` under `relay`. */
  metadata?: Record<string, unknown>;
}

/**
 * A node in a mapping tree. `unknown` on purpose: the shape is checked
 * structurally by `parseMediaSpec`, and a recursive zod union would reject
 * perfectly valid operator input for reasons that are hard to explain.
 */
export type MediaMapping = unknown;

const CONTENT_TYPES = ["application/json", "multipart/form-data"] as const;

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
  | { ok: true; spec: MediaSpec }
  | { ok: false; errors: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function validateStringMap(
  value: unknown,
  path: string,
  errors: string[],
): void {
  const record = asRecord(value);
  if (!record) {
    errors.push(`${path}: expected an object of string values`);
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") errors.push(`${path}.${key}: expected a string`);
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
  const root = asRecord(raw);
  if (!root) return { ok: false, errors: ["spec: expected a JSON object"] };

  if (root.specVersion !== 1) {
    errors.push("specVersion: only 1 is supported");
  }
  if (!isMediaCapability(root.capability)) {
    errors.push(`capability: must be one of ${MEDIA_CAPABILITIES.join(", ")}`);
  }

  const transport = asRecord(root.transport);
  if (!transport) {
    errors.push("transport: required object");
  } else {
    if (transport.method !== "POST" && transport.method !== "GET") {
      errors.push("transport.method: must be POST or GET");
    }
    if (typeof transport.path !== "string" || !transport.path.startsWith("/")) {
      errors.push('transport.path: must be a string starting with "/"');
    }
    if (transport.headers !== undefined) {
      validateStringMap(transport.headers, "transport.headers", errors);
    }
    if (transport.query !== undefined) {
      validateStringMap(transport.query, "transport.query", errors);
    }
    if (
      transport.contentType !== undefined &&
      !(CONTENT_TYPES as readonly unknown[]).includes(transport.contentType)
    ) {
      errors.push(
        `transport.contentType: must be one of ${CONTENT_TYPES.join(", ")}`,
      );
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
  if (root.response !== undefined) validateMapping(root.response, "response", errors);
  if (
    root.responseMode !== undefined &&
    !["json", "binary", "stream"].includes(String(root.responseMode))
  ) {
    errors.push("responseMode: must be json, binary or stream");
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
        if (typeof poll.path !== "string" || !poll.path.startsWith("/")) {
          errors.push('async.poll.path: must be a string starting with "/"');
        }
        if (poll.method !== undefined && poll.method !== "GET" && poll.method !== "POST") {
          errors.push("async.poll.method: must be GET or POST");
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
    }
  }

  if (root.metadata !== undefined && !asRecord(root.metadata)) {
    errors.push("metadata: expected an object");
  }

  if (errors.length > 0) return { ok: false, errors };

  // `transport` is only null on the error path we just returned from.
  const transportRecord = transport as Record<string, unknown>;

  return {
    ok: true,
    spec: {
      specVersion: 1,
      capability: root.capability as MediaCapability,
      ...(typeof root.displayName === "string" ? { displayName: root.displayName } : {}),
      transport: {
        method: transportRecord.method as MediaTransport["method"],
        path: transportRecord.path as string,
        ...(transportRecord.headers
          ? { headers: transportRecord.headers as Record<string, string> }
          : {}),
        ...(transportRecord.query
          ? { query: transportRecord.query as Record<string, string> }
          : {}),
        ...(transportRecord.contentType
          ? { contentType: transportRecord.contentType as MediaTransport["contentType"] }
          : {}),
      },
      auth: auth as MediaAuth,
      ...(root.request !== undefined ? { request: root.request } : {}),
      ...(root.response !== undefined ? { response: root.response } : {}),
      ...(["json", "binary", "stream"].includes(String(root.responseMode))
        ? { responseMode: root.responseMode as MediaSpec["responseMode"] }
        : {}),
      ...(Array.isArray(root.errors) ? { errors: root.errors as MediaErrorRule[] } : {}),
      ...(root.async !== undefined ? { async: root.async as MediaAsync } : {}),
      ...(root.limits !== undefined ? { limits: root.limits as MediaLimits } : {}),
      ...(asRecord(root.metadata) ? { metadata: root.metadata as Record<string, unknown> } : {}),
    },
  };
}
