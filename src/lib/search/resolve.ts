/**
 * src/lib/search/resolve.ts
 *
 * Which search backend serves a request.
 *
 * The rule is one sentence: **the provider table wins once it has a row.**
 *
 *  - Zero rows: the environment path (Tavily → Brave → SearXNG), unchanged
 *    from before providers existed. An upgrade must not silently turn search
 *    off.
 *  - One or more rows: the first enabled, usable row by `priority ASC,
 *    name ASC, id ASC`. Invalid rows are skipped. If rows exist but none is
 *    usable, the answer is "unconfigured" — **not** a fallback to the
 *    environment. Otherwise disabling every provider would not actually
 *    disable anything.
 *
 * Kept out of `web-search.ts` so the HTTP adapters stay free of database
 * imports and can be unit-tested with an injected environment.
 */
import { decryptSecret } from "../crypto/secrets";
import { listSearchProviders, type SearchProviderRecord } from "../db/search-providers";
import {
  createSearchBackend,
  resolveSearchBackend,
  searchWeb,
  type SearchBackend,
  type SearchOutcome,
  type SearchProvider,
} from "../assistant/web-search";

export interface ActiveBackendInfo {
  configured: boolean;
  name: string | null;
  kind: SearchProvider | null;
  /** Only shown to administrators. */
  baseUrl: string | null;
  source: "db" | "env" | null;
  usageProviderId: string | null;
  /** The row's own price; null when the environment fallback is in use. */
  creditsPerCall: number | null;
}

/**
 * Build the backend for one stored provider, regardless of `enabled`.
 *
 * Exported for the per-provider test route: diagnosing a provider that is
 * currently switched off is the whole point of that button.
 */
export function backendForSearchProvider(row: SearchProviderRecord): SearchBackend | null {
  let apiKey = "";
  if (row.encryptedApiKey) {
    try {
      apiKey = decryptSecret(row.encryptedApiKey);
    } catch {
      // A key encrypted under a rotated master key cannot be used. Skip the
      // row rather than failing every search with "decryption failed".
      return null;
    }
  }
  return createSearchBackend({
    kind: row.kind,
    baseUrl: row.baseUrl || undefined,
    apiKey: apiKey || undefined,
    // The row id, so a usage row points at the exact provider that served it.
    usageProviderId: row.id,
    source: "db",
    describe: row.name,
    creditsPerCall: row.creditsPerCall,
  });
}

function backendFromRows(rows: readonly SearchProviderRecord[]): SearchBackend | null {
  for (const row of rows) {
    if (!row.enabled) continue;
    const backend = backendForSearchProvider(row);
    if (backend) return backend;
  }
  return null;
}

export async function resolveActiveSearchBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchBackend | null> {
  const rows = await listSearchProviders();
  if (rows.length === 0) return resolveSearchBackend(env);
  return backendFromRows(rows);
}

export async function activeSearchBackendInfo(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActiveBackendInfo> {
  const rows = await listSearchProviders();
  const backend = rows.length === 0 ? resolveSearchBackend(env) : backendFromRows(rows);
  if (!backend) {
    return {
      configured: false,
      name: null,
      kind: null,
      baseUrl: null,
      source: null,
      usageProviderId: null,
      creditsPerCall: null,
    };
  }
  return {
    configured: true,
    name: backend.describe,
    kind: backend.provider,
    baseUrl: backend.baseUrl ?? null,
    source: backend.source,
    usageProviderId: backend.usageProviderId,
    creditsPerCall: backend.creditsPerCall ?? null,
  };
}

/**
 * Search through whichever backend is active.
 *
 * Wraps `searchWeb` so every caller — the public endpoint, the assistant tool,
 * the admin test — resolves providers the same way and attributes the call the
 * same way.
 */
export async function searchActive(
  query: string,
  opts: { limit?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SearchOutcome> {
  const backend = await resolveActiveSearchBackend(opts.env);
  return searchWeb(query, { ...opts, ...(backend ? { backend } : {}) });
}
