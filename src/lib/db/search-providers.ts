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
 *
 * ## The `spec` column
 *
 * A row may carry a **search spec** — the declarative description of how to
 * talk to that vendor (`src/lib/search/spec.ts`). With one, the row describes
 * a vendor this build has never heard of, and adding it needs no code change
 * and no redeploy.
 *
 * A row **without** a spec is a row written before the protocol existed. Its
 * `kind` selects a built-in template and its address is read the old way; see
 * `src/lib/search/effective.ts` for exactly how, and why the old way is kept.
 */
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";
import { getAll, getOne, run, toDbBool, fromDbBool } from "./sqlite";
import { parseSearchSpec, type SearchSpec } from "../search/spec";
import { searchTemplateByKind } from "../search/templates";

/**
 * The vendors that ship with a built-in template.
 *
 * Not a closed set: a row that carries its own spec may name any vendor. The
 * list is what the panel offers as a starting point, and what a row without a
 * spec is matched against.
 */
export const SEARCH_PROVIDER_KINDS = ["tavily", "brave", "searxng"] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDER_KINDS)[number];

export function isSearchProviderKind(value: unknown): value is SearchProviderKind {
  return typeof value === "string" && (SEARCH_PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface SearchProviderRecord {
  id: string;
  name: string;
  /**
   * Which template this row uses when it carries no spec of its own, and a
   * label for it in the panel and in usage rows.
   */
  kind: string;
  baseUrl: string;
  encryptedApiKey: string;
  enabled: boolean;
  priority: number;
  /** Whole credits charged per call through this backend. */
  creditsPerCall: number;
  /**
   * The row's own spec, when it has one.
   *
   * Null means "use the template this row's `kind` names" — which is every
   * row written before the protocol existed.
   */
  spec: SearchSpec | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicSearchProvider = Omit<SearchProviderRecord, "encryptedApiKey"> & {
  /** Whether a key is stored, without exposing it. */
  hasApiKey: boolean;
};

export interface CreateSearchProviderInput {
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  creditsPerCall?: number;
  /** The row's own spec, when it describes a vendor this build has no template for. */
  spec?: unknown;
}

export interface UpdateSearchProviderInput {
  name?: string;
  kind?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  creditsPerCall?: number;
  /** The row's own spec. `null` clears it and returns the row to its template. */
  spec?: unknown;
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
  const kind = isSearchProviderKind(row.kind) ? row.kind : String(row.kind ?? "searxng");
  return {
    id: String(row.id),
    name: String(row.name),
    kind,
    baseUrl: String(row.base_url ?? ""),
    encryptedApiKey: String(row.encrypted_api_key ?? ""),
    enabled: fromDbBool(row.enabled),
    priority: Number(row.priority ?? 1),
    creditsPerCall: Number(row.credits_per_call ?? 1),
    spec: parseStoredSpec(row.spec),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Read the stored spec back.
 *
 * A corrupt column must not take down the read. The row then reads as "no
 * spec", which means "use the template this row's kind names" — the same
 * behaviour a row written before the protocol had.
 */
function parseStoredSpec(raw: unknown): SearchSpec | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") {
    const parsed = parseSearchSpec(raw);
    return parsed.ok ? parsed.spec : null;
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed = parseSearchSpec(JSON.parse(raw));
    return parsed.ok ? parsed.spec : null;
  } catch {
    return null;
  }
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
 * A row that carries a spec is checked by the **protocol's own validator**,
 * not by a second set of rules here. That is the whole point of
 * `parseSearchSpec`: a rule that exists in one place and not the other is a
 * rule that is checked in the panel and not in the assistant, and that has
 * already happened once in this codebase (`statusMap`).
 *
 * A row without a spec falls back to its template's rules, which is what the
 * three built-in vendors need: a keyed API without a key can never answer, so
 * a row that cannot answer is refused at save time rather than discovered by a
 * failing search later.
 */
function validate(input: {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  creditsPerCall: number;
  spec: unknown;
}): string[] {
  const issues: string[] = [];
  if (!input.name.trim()) issues.push("name is required");
  if (input.name.length > 120) issues.push("name is too long");
  if (!input.kind.trim()) issues.push("kind is required");
  if (input.kind.length > 60) issues.push("kind is too long");

  let spec: SearchSpec | null = null;
  if (input.spec !== undefined && input.spec !== null) {
    const parsed = parseSearchSpec(input.spec);
    if (!parsed.ok) {
      issues.push(...parsed.errors);
    } else {
      spec = parsed.spec;
    }
  }

  if (input.baseUrl.trim() && !isHttpUrl(input.baseUrl.trim())) {
    issues.push("base URL must be http(s)");
  }

  if (spec) {
    // The spec's own address, unless the row has one.
    const address = input.baseUrl.trim() || spec.baseUrl?.trim() || "";
    if (!address) {
      issues.push("base URL is required: 这个 spec 没有自带地址");
    }
    const auth = spec.auth;
    if (auth && auth.type !== "none" && auth.required !== false && !input.apiKey.trim()) {
      issues.push(`${spec.displayName ?? spec.vendor ?? "该提供商"} requires an API key`);
    }
  } else {
    const template = searchTemplateByKind(input.kind);
    if (!template) {
      issues.push(
        `kind "${input.kind}" 没有内置模板 — 请给它一份 spec，或者用 ${SEARCH_PROVIDER_KINDS.join(" / ")}`,
      );
    } else {
      const address = input.baseUrl.trim() || template.spec.baseUrl?.trim() || "";
      if (!address) {
        issues.push(`${template.name} requires a base URL`);
      }
      const auth = template.spec.auth;
      if (auth && auth.type !== "none" && auth.required !== false && !input.apiKey.trim()) {
        issues.push(`${template.name} requires an API key`);
      }
    }
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
    spec: input.spec,
  });
  if (issues.length) throw new SearchProviderValidationError(issues);

  const parsedSpec = input.spec === undefined || input.spec === null ? null : parseStoredSpec(input.spec);
  const now = new Date().toISOString();
  const record: SearchProviderRecord = {
    id: generateId(),
    name: input.name.trim(),
    kind: input.kind.trim(),
    baseUrl,
    encryptedApiKey: key ? encryptSecret(key) : "",
    enabled: input.enabled ?? true,
    priority: Number.isInteger(input.priority) ? Math.trunc(input.priority!) : 1,
    creditsPerCall: Math.trunc(creditsPerCall),
    spec: parsedSpec,
    createdAt: now,
    updatedAt: now,
  };

  run(
    `INSERT INTO search_providers
       (id, name, kind, base_url, encrypted_api_key, enabled, priority,
        credits_per_call, spec, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.name,
      record.kind,
      record.baseUrl,
      record.encryptedApiKey,
      toDbBool(record.enabled),
      record.priority,
      record.creditsPerCall,
      record.spec ? JSON.stringify(record.spec) : "",
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
  const spec =
    patch.spec === undefined ? existing.spec : patch.spec === null ? null : parseStoredSpec(patch.spec);

  // Validation needs to know whether a usable key exists after the merge, not
  // just whether this patch carried one.
  const keyPresent = Boolean(newKey || existing.encryptedApiKey);
  const issues = validate({
    name,
    kind,
    baseUrl,
    apiKey: keyPresent ? "present" : "",
    creditsPerCall,
    spec: patch.spec === undefined ? existing.spec : patch.spec,
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
    spec,
    updatedAt: new Date().toISOString(),
  };

  run(
    `UPDATE search_providers
        SET name = ?, kind = ?, base_url = ?, encrypted_api_key = ?,
            enabled = ?, priority = ?, credits_per_call = ?, spec = ?, updated_at = ?
      WHERE id = ?`,
    [
      merged.name,
      merged.kind,
      merged.baseUrl,
      merged.encryptedApiKey,
      toDbBool(merged.enabled),
      merged.priority,
      merged.creditsPerCall,
      merged.spec ? JSON.stringify(merged.spec) : "",
      merged.updatedAt,
      id,
    ],
  );
  return merged;
}

export async function deleteSearchProvider(id: string): Promise<boolean> {
  return run("DELETE FROM search_providers WHERE id = ?", [id]) > 0;
}
