/**
 * src/lib/providers/upstream.ts
 *
 * Small helper for making ad-hoc HTTP calls to upstream AI providers.
 * Used by:
 *   - POST /api/admin/providers/[id]/models  → fetch model list
 *   - POST /api/admin/providers/[id]/test    → health check
 *   - POST /api/admin/providers/probe       → test connection
 *
 * Not used by the proxy path itself (that uses Vercel AI SDK).
 */
import { decryptSecret } from "@/lib/crypto/secrets";
import { getMasterKey } from "@/lib/config";
import { loadConfig } from "@/lib/config";

export interface UpstreamFetchOptions {
  baseUrl: string;
  encryptedApiKey: string;
  path: string;            // e.g. "/v1/models"
  method?: "GET" | "POST";
  body?: unknown;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface UpstreamFetchResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
  latencyMs: number;
}

/** Decrypt an encrypted API key using the active master key. */
export function decryptProviderKey(encryptedApiKey: string): string {
  return decryptSecret(encryptedApiKey);
}

/**
 * Decrypt + call upstream in one step.
 * Always sets `Authorization: Bearer <key>` unless the caller overrides it.
 * Follows up to 3 redirects to handle API gateways that redirect.
 */
export async function callUpstream(opts: UpstreamFetchOptions): Promise<UpstreamFetchResult> {
  const start = Date.now();
  const cfg = loadConfig();
  void cfg;
  const key = decryptProviderKey(opts.encryptedApiKey);
  let url = joinUrl(opts.baseUrl, opts.path);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    ...opts.extraHeaders,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  // Follow up to 3 redirects
  let redirectCount = 0;
  const maxRedirects = 3;

  while (redirectCount <= maxRedirects) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        // Follow redirects for API calls (but cap at maxRedirects)
        redirect: redirectCount < maxRedirects ? "follow" : "manual",
      });

      // Handle redirect status codes
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("Location");
        if (!location) {
          return {
            ok: false,
            status: res.status,
            error: "Redirect response has no Location header",
            latencyMs: Date.now() - start,
          };
        }
        // Handle relative redirects
        url = new URL(location, url).toString();
        redirectCount++;
        continue;
      }

      let parsed: unknown;
      const text = await res.text();
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }

      return {
        ok: res.ok,
        status: res.status,
        body: parsed,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  // Too many redirects
  return {
    ok: false,
    status: 0,
    error: `Too many redirects (${maxRedirects + 1})`,
    latencyMs: Date.now() - start,
  };
}

function joinUrl(base: string, path: string): string {
  if (!path) return base.replace(/\/$/, "");
  if (path.startsWith("http")) return path;
  let a = base.replace(/\/$/, "");
  let b = path.startsWith("/") ? path.slice(1) : path;
  // Avoid double paths like /v1/v1/models - if base ends with same prefix as path starts with
  if (a.endsWith("/" + b.split("/")[0]) && b.includes("/")) {
    b = b.split("/").slice(1).join("/");
  }
  return a + "/" + b;
}

/**
 * Normalize the model list returned by various upstreams to a common shape.
 *
 * OpenAI-compatible /v1/models returns:  { data: [{ id: "...", ... }] }
 * Anthropic /v1/models returns:           { data: [{ id: "claude-...", ... }] }
 * Some upstreams return:                  ["model-a", "model-b"]
 */
export function extractModelIds(raw: unknown): string[] {
  return extractModelEntries(raw).map((e) => e.id);
}

/**
 * What one entry in a `/models` response says about the model, read past the id.
 *
 * The id is the only thing most upstreams publish, and it is all this function
 * used to keep — so a gateway that *does* report a context window or an output
 * cap had it discarded, and the operator was asked to type the same number by
 * hand. Every field here is optional and read from the spellings in use, because
 * a vendor that publishes one of these and the caller ignores it is worse than a
 * vendor that publishes none.
 *
 * **Nothing is inferred.** A missing field stays missing, and the editor shows
 * it as unset rather than filling a default that would then be stored as if the
 * operator had chosen it.
 */
export interface ModelEntryFacts {
  id: string;
  contextLength?: number;
  maxOutputTokens?: number;
  /**
   * The thinking levels this model publishes, as its own spelling of them.
   *
   * Read rather than invented because the list is a property of the model: some
   * publish four, some three, some an on/off pair, and some publish nothing
   * because they do not think. Absent means "the vendor said nothing", which the
   * editor keeps as a blank the operator can fill — a guessed list is a list
   * that is wrong for most of the models here, and wrong silently.
   */
  reasoningLevels?: string[];
  /** Anything else the vendor published, kept rather than dropped. */
  extra?: Record<string, unknown>;
}

/** The spellings in use for a declared context window. */
const CONTEXT_KEYS = [
  "context_length",
  "context_length_tokens",
  "max_context_tokens",
  "max_context_length",
  "max_input_tokens",
  "context_window",
  "context",
] as const;

/** …and for a declared output cap. */
const OUTPUT_KEYS = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "output_limit",
  "max_output",
] as const;

/**
 * Where a vendor publishes which thinking levels a model takes.
 *
 * Two shapes in the wild: a list of names (`["low", "high"]`) and a nested
 * object under `reasoning` or `thinking` with an `effort`/`levels` list. Both
 * are read, because a vendor that publishes levels at all publishes them in one
 * of them, and a miss here means the operator types them instead.
 */
const REASONING_KEYS = [
  "supported_reasoning_efforts",
  "reasoning_efforts",
  "reasoning_levels",
  "supported_efforts",
] as const;

const REASONING_NESTED_KEYS = ["reasoning", "thinking"] as const;
const REASONING_NESTED_LIST_KEYS = ["effort", "efforts", "levels", "supported"] as const;

function stringList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : // Some vendors publish an enum as `{"enum": ["low", "high"]}`.
      isPlainRecord(value) && Array.isArray((value as { enum?: unknown }).enum)
      ? ((value as { enum: unknown[] }).enum as unknown[])
      : undefined;
  if (!raw) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    // An effort can be a bare name or `{effort: "high", …}`; both are read and
    // normalised to the name, because the name is what goes on the wire.
    const name =
      typeof item === "string"
        ? item
        : isPlainRecord(item) && typeof item.effort === "string"
          ? item.effort
          : isPlainRecord(item) && typeof item.name === "string"
            ? item.name
            : "";
    const trimmed = name.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reasoningLevels(record: Record<string, unknown>): string[] | undefined {
  for (const key of REASONING_KEYS) {
    const list = stringList(record[key]);
    if (list) return list;
  }
  for (const nested of REASONING_NESTED_KEYS) {
    const inner = record[nested];
    if (!isPlainRecord(inner)) continue;
    for (const key of REASONING_NESTED_LIST_KEYS) {
      const list = stringList(inner[key]);
      if (list) return list;
    }
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const raw = source[k];
    if (typeof raw !== "number" && typeof raw !== "string") continue;
    // JSON is untyped in practice: gateways built on older stacks serialise
    // every number as a string, and a window of "200000" is a window, not
    // junk. Coerce rather than discard, but still refuse anything that is not
    // a finite positive number once coerced.
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return undefined;
}

export function extractModelEntries(raw: unknown): ModelEntryFacts[] {
  const rows = toRows(raw);
  const out: ModelEntryFacts[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim();
      if (id) out.push({ id });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const contextLength = firstNumber(record, CONTEXT_KEYS);
    const maxOutputTokens = firstNumber(record, OUTPUT_KEYS);
    const levels = reasoningLevels(record);
    const known = new Set<string>([
      "id",
      ...CONTEXT_KEYS,
      ...OUTPUT_KEYS,
      ...REASONING_KEYS,
      ...REASONING_NESTED_KEYS,
    ]);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (!known.has(k) && v !== null && v !== undefined) extra[k] = v;
    }
    out.push({
      id,
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(levels !== undefined ? { reasoningLevels: levels } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    });
  }
  return out;
}

/** The list itself, wherever the vendor put it. */
function toRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const obj = raw as { data?: unknown; models?: unknown } | null;
  if (Array.isArray(obj?.data)) return obj.data;
  if (Array.isArray(obj?.models)) return obj.models;
  return [];
}

void getMasterKey; // exported for symmetry
