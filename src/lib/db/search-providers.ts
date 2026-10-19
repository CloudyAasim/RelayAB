/**
 * src/lib/db/search-providers.ts
 *
 * Repository for **web-search backends** — the search analogue of
 * `media-providers`, and deliberately the same shape: one row is one vendor
 * endpoint plus its credential, with `enabled` and `priority` deciding which
 * one serves a request.
 *
 * Why a table instead of more environment variables: changing a search vendor
 * used to require editing Dokku config and redeploying. It is the same class of
 * decision as adding a chat or media provider, so it belongs in the same place,
 * with the same add/edit/disable/priority/test controls.
 *
 * The environment is not removed. A deployment with **zero rows** keeps using
 * `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `SEARXNG_URL`, so upgrading does
 * not turn search off. Once a row exists the table is authoritative — a
 * disabled row is skipped, and disabling every row means search is unconfigured
 * rather than silently falling back to whatever the environment still holds.
 */
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";
import { getAll, getOne, run, toDbBool, fromDbBool } from "./sqlite";

export const SEARCH_PROVIDER_KINDS = ["tavily", "brave", "searxng"] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDER_KINDS)[number];

export function isSearchProviderKind(value: unknown): value is SearchProviderKind {
  return typeof value === "string" && (SEARCH_PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface SearchProviderRecord {
  id: string;
  name: string;
  kind: SearchProviderKind;
  baseUrl: string;
  encryptedApiKey: string;
  enabled: boolean;
  priority: number;
  /** Whole credits charged per call through this backend. */
  creditsPerCall: number;
  createdAt: string;
  updatedAt: string;
}

export type PublicSearchProvider = Omit<SearchProviderRecord, "encryptedApiKey"> & {
  /** Whether a key is stored, without exposing it. */
  hasApiKey: boolean;
};

export interface CreateSearchProviderInput {
  name: string;
  kind: SearchProviderKind;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  creditsPerCall?: number;
}

export interface UpdateSearchProviderInput {
  name?: string;
  kind?: SearchProviderKind;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  creditsPerCall?: number;
}

/** A sanity ceiling, not an economic statement. */
export const MAX_CREDITS_PER_CALL = 1_000_000;

export class SearchProviderValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid search provider: ${issues.join("; ")}`);
    this.name = "SearchProviderValidationError";
  }
}

function rowToSearchProvider(row: Record<string, unknown>): SearchProviderRecord {
  const kind = isSearchProviderKind(row.kind) ? row.kind : "searxng";
  return {
    id: String(row.id),
    name: String(row.name),
    kind,
    baseUrl: String(row.base_url ?? ""),
    encryptedApiKey: String(row.encrypted_api_key ?? ""),
    enabled: fromDbBool(row.enabled),
    priority: Number(row.priority ?? 1),
    creditsPerCall: Number(row.credits_per_call ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Never hand the ciphertext out. */
export function toPublicSearchProvider(provider: SearchProviderRecord): PublicSearchProvider {
  const { encryptedApiKey, ...rest } = provider;
  return { ...rest, hasApiKey: encryptedApiKey.length > 0 };
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
 * The rules that make a row usable.
 *
 * A SearXNG row needs an address and nothing else. Tavily and Brave are keyed
 * APIs: without a key they can never answer, so a row that cannot answer is
 * refused at save time rather than discovered by a failing search later.
 */
function validate(input: {
  name: string;
  kind: SearchProviderKind;
  baseUrl: string;
  apiKey: string;
  creditsPerCall: number;
}): string[] {
  const issues: string[] = [];
  if (!input.name.trim()) issues.push("name is required");
  if (input.name.length > 120) issues.push("name is too long");
  if (input.kind === "searxng") {
    if (!input.baseUrl.trim()) issues.push("SearXNG requires a base URL");
    else if (!isHttpUrl(input.baseUrl.trim())) issues.push("base URL must be http(s)");
  } else if (!input.apiKey.trim()) {
    issues.push(`${input.kind} requires an API key`);
  }
  if (input.baseUrl.trim() && !isHttpUrl(input.baseUrl.trim())) {
    issues.push("base URL must be http(s)");
  }
  // Zero is a deliberate "free", so the range starts there; a negative price
  // would credit the caller on every search.
  if (!Number.isInteger(input.creditsPerCall) || input.creditsPerCall < 0) {
    issues.push("credits per call must be a non-negative integer");
  } else if (input.creditsPerCall > MAX_CREDITS_PER_CALL) {
    issues.push(`credits per call must be at most ${MAX_CREDITS_PER_CALL}`);
  }
  return issues;
}

export async function createSearchProvider(
  input: CreateSearchProviderInput,
): Promise<SearchProviderRecord> {
  const key = input.apiKey?.trim() ?? "";
  const baseUrl = input.baseUrl?.trim() ?? "";
  const creditsPerCall = input.creditsPerCall ?? 1;
  const issues = validate({
    name: input.name,
    kind: input.kind,
    baseUrl,
    apiKey: key,
    creditsPerCall,
  });
  if (issues.length) throw new SearchProviderValidationError(issues);

  const now = new Date().toISOString();
  const record: SearchProviderRecord = {
    id: generateId(),
    name: input.name.trim(),
    kind: input.kind,
    baseUrl,
    encryptedApiKey: key ? encryptSecret(key) : "",
    enabled: input.enabled ?? true,
    priority: Number.isInteger(input.priority) ? Math.trunc(input.priority!) : 1,
    creditsPerCall: Math.trunc(creditsPerCall),
    createdAt: now,
    updatedAt: now,
  };

  run(
    `INSERT INTO search_providers
       (id, name, kind, base_url, encrypted_api_key, enabled, priority,
        credits_per_call, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.name,
      record.kind,
      record.baseUrl,
      record.encryptedApiKey,
      toDbBool(record.enabled),
      record.priority,
      record.creditsPerCall,
      record.createdAt,
      record.updatedAt,
    ],
  );
  return record;
}

export async function getSearchProviderById(id: string): Promise<SearchProviderRecord | null> {
  return getOne("SELECT * FROM search_providers WHERE id = ?", [id], rowToSearchProvider);
}

/** Priority first, then name — the same order the runtime resolver uses. */
export async function listSearchProviders(
  opts: { enabledOnly?: boolean } = {},
): Promise<SearchProviderRecord[]> {
  const where = opts.enabledOnly ? "WHERE enabled = 1" : "";
  return getAll(
    `SELECT * FROM search_providers ${where} ORDER BY priority ASC, name ASC, id ASC`,
    [],
    rowToSearchProvider,
  );
}

export async function updateSearchProvider(
  id: string,
  patch: UpdateSearchProviderInput,
): Promise<SearchProviderRecord | null> {
  const existing = await getSearchProviderById(id);
  if (!existing) return null;

  const kind = patch.kind ?? existing.kind;
  const baseUrl = patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl.trim();
  const newKey = patch.apiKey?.trim() ?? "";
  // A blank key on edit means "keep the stored one", exactly like media
  // providers: the form never has to hold the secret again.
  const encryptedApiKey = newKey ? encryptSecret(newKey) : existing.encryptedApiKey;
  const name = patch.name === undefined ? existing.name : patch.name.trim();
  const creditsPerCall =
    patch.creditsPerCall === undefined ? existing.creditsPerCall : Math.trunc(patch.creditsPerCall);

  // Validation needs to know whether a usable key exists after the merge, not
  // just whether this patch carried one.
  const keyPresent = Boolean(newKey || existing.encryptedApiKey);
  const issues = validate({
    name,
    kind,
    baseUrl,
    apiKey: keyPresent ? "present" : "",
    creditsPerCall,
  });
  if (issues.length) throw new SearchProviderValidationError(issues);

  const merged: SearchProviderRecord = {
    ...existing,
    name,
    kind,
    baseUrl,
    encryptedApiKey: newKey ? encryptedApiKey : existing.encryptedApiKey,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    priority:
      patch.priority === undefined ? existing.priority : Math.trunc(patch.priority),
    creditsPerCall,
    updatedAt: new Date().toISOString(),
  };

  run(
    `UPDATE search_providers
        SET name = ?, kind = ?, base_url = ?, encrypted_api_key = ?,
            enabled = ?, priority = ?, credits_per_call = ?, updated_at = ?
      WHERE id = ?`,
    [
      merged.name,
      merged.kind,
      merged.baseUrl,
      merged.encryptedApiKey,
      toDbBool(merged.enabled),
      merged.priority,
      merged.creditsPerCall,
      merged.updatedAt,
      id,
    ],
  );
  return merged;
}

export async function deleteSearchProvider(id: string): Promise<boolean> {
  return run("DELETE FROM search_providers WHERE id = ?", [id]) > 0;
}
