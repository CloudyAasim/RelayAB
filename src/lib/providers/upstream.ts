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
  const a = base.replace(/\/$/, "");
  const b = path.startsWith("/") ? path : "/" + path;
  return a + b;
}

/**
 * Normalize the model list returned by various upstreams to a common shape.
 *
 * OpenAI-compatible /v1/models returns:  { data: [{ id: "...", ... }] }
 * Anthropic /v1/models returns:           { data: [{ id: "claude-...", ... }] }
 * Some upstreams return:                  ["model-a", "model-b"]
 */
export function extractModelIds(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((m) => (typeof m === "string" ? m : m?.id ?? ""))
      .filter(Boolean);
  }
  const obj = raw as { data?: unknown; models?: unknown };
  if (Array.isArray(obj?.data)) return extractModelIds(obj.data);
  if (Array.isArray(obj?.models)) return extractModelIds(obj.models);
  return [];
}

void getMasterKey; // exported for symmetry
