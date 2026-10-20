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
 * Kept out of `web-search.ts` so the HTTP layer stays free of database
 * imports and can be unit-tested with an injected environment.
 */
import { decryptSecret } from "../crypto/secrets";
import { listSearchProviders, type SearchProviderRecord } from "../db/search-providers";
import { effectiveSearchConfig } from "./effective";
import { userSearchBackend } from "./user";
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
  /** Where the backend came from: the provider table, the environment, or a user's own. */
  source: "db" | "env" | "user" | null;
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
  const config = effectiveSearchConfig(row);
  if (!config) return null;

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
    spec: config.spec,
    baseUrl: config.baseUrl,
    // Only the operator's own address is worth showing an administrator.
    ...(config.operatorAddress ? { operatorAddress: config.operatorAddress } : {}),
    apiKey: apiKey || undefined,
    // The row id, so a usage row points at the exact provider that served it.
    usageProviderId: row.id,
    provider: config.spec.vendor ?? row.kind,
    source: "db",
    describe: row.name,
    creditsPerCall: row.creditsPerCall,
    credentialHint: "该提供商的 API 密钥",
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

/**
 * The backend that answers for **this** account.
 *
 * The user's own search service comes first, and the reason is money: a user
 * who brought their own service is paying that vendor themselves, and the
 * deployment's provider is not theirs to spend. With no service of their own,
 * the deployment's providers answer exactly as they always have.
 *
 * The administrator's switch still governs: the deployment's search being off
 * is a statement about the deployment, and it is not a user's to overrule.
 */
export async function resolveSearchBackendForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchBackend | null> {
  const own = await userSearchBackend(userId);
  if (own) return own;
  return resolveActiveSearchBackend(env);
}

export async function activeSearchBackendInfo(
  env: NodeJS.ProcessEnv = process.env,
  rows?: readonly SearchProviderRecord[],
): Promise<ActiveBackendInfo> {
  const list = rows ?? (await listSearchProviders());
  const backend = list.length === 0 ? resolveSearchBackend(env) : backendFromRows(list);
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
