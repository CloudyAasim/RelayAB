/**
 * src/lib/search/resolve.ts
 *
 * Which search backend serves a request.
 *
 * The rule is now one sentence: **exactly one service answers.**
 *
 * ## The three cases
 *
 *  - **No rows at all**: the environment path (Tavily → Brave → SearXNG),
 *    unchanged from before providers existed. An upgrade must not silently turn
 *    search off.
 *  - **Rows exist**: the **default** row answers. The default is the row
 *    somebody marked as such, or — when nobody has — the first enabled row by
 *    `priority ASC, name ASC, id ASC`.
 *  - **A caller names a service**: that row answers, if it is enabled.
 *
 * ## What does *not* happen
 *
 * **A service that cannot answer is never quietly replaced by another one.**
 *
 * It used to be: the resolver walked the rows, skipped the ones that could not
 * work, and served from the first one that could. That is a silent substitution
 * of one vendor for another — and these rows carry **their own price**
 * (`creditsPerCall`), so the substitution changed not only which vendor
 * answered but what the account was charged. An operator reading "自建 SearXNG
 * is enabled" had no way to know that a row which could not answer was being
 * passed over, and the panel showed the skipped row as a perfectly healthy
 * green one.
 *
 * So: the service that was chosen is the service that answers. When it cannot,
 * the request fails with the reason, and the panel says so where the operator
 * can act on it. A disabled row is different — that is a deliberate "off", and
 * the next enabled row takes over.
 *
 * Kept out of `web-search.ts` so the HTTP layer stays free of database
 * imports and can be unit-tested with an injected environment.
 */
import { decryptSecret } from "../crypto/secrets";
import {
  listSearchProviders,
  type SearchProviderRecord,
} from "../db/search-providers";
import { getAssistantSettings } from "../db/assistant";
import { effectiveSearchConfig } from "./effective";
import { userSearchBackend } from "./user";
import {
  createSearchBackend,
  resolveSearchBackend,
  searchWeb,
  WebSearchError,
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
  /** The client-visible name of the service that answered. */
  serviceId: string | null;
  /**
   * Why the chosen service cannot answer, when it cannot.
   *
   * The reason a request will fail with, said where the operator can act on
   * it. Null when the service is fine.
   */
  unusableReason: string | null;
  /** The id of the row that was chosen, whether or not it can answer. */
  providerId: string | null;
}

/**
 * Whether a row can answer, and why not when it cannot.
 *
 * The reasons are the three things an operator can act on: no address, no
 * credential for a vendor that needs one, and a credential that no longer
 * decrypts.
 */
export function searchServiceUsability(
  row: SearchProviderRecord,
): { usable: boolean; reason: string | null } {
  const config = effectiveSearchConfig(row);
  if (!config) {
    return { usable: false, reason: "这个搜索服务没有可用的地址（也没有对应的内置模板）" };
  }

  const auth = config.spec.auth;
  const needsKey = Boolean(auth && auth.type !== "none" && auth.required !== false);
  if (needsKey && !row.encryptedApiKey) {
    return { usable: false, reason: "这个搜索服务需要 API 密钥，但没有填" };
  }

  if (row.encryptedApiKey) {
    try {
      decryptSecret(row.encryptedApiKey);
    } catch {
      // A key encrypted under a rotated master key cannot be used, and the
      // row is not "a little broken": it can never answer again until the
      // key is typed in again.
      return { usable: false, reason: "这个搜索服务的密钥无法解密（可能换过主密钥），请重新填写" };
    }
  }

  return { usable: true, reason: null };
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
    // The name a client uses to ask for this service.
    ...(row.serviceId ? { serviceId: row.serviceId } : {}),
    provider: config.spec.vendor ?? row.kind,
    source: "db",
    describe: row.name,
    creditsPerCall: row.creditsPerCall,
    credentialHint: "该提供商的 API 密钥",
  });
}

/**
 * The service a caller named, and whether it can answer.
 *
 * Two refusals, and they are different: a name nobody has is a mistake in the
 * request, and a name that is switched off is a service that is deliberately
 * not in use. Neither is answered by serving something else.
 */
export function namedSearchProvider(
  rows: readonly SearchProviderRecord[],
  serviceId: string,
): { row: SearchProviderRecord | null; problem: "unknown" | "disabled" | null } {
  const wanted = serviceId.trim();
  const row = rows.find((candidate) => candidate.serviceId === wanted);
  if (!row) return { row: null, problem: "unknown" };
  if (!row.enabled) return { row, problem: "disabled" };
  return { row, problem: null };
}

/**
 * The backend of the service that answers, or null with a reason.
 *
 * The reason is what makes the failure legible: "the service you asked for is
 * not usable because it has no key", "there is no service at all" and "there
 * are several and nobody chose" are different problems with different fixes.
 */
export function backendForRows(
  rows: readonly SearchProviderRecord[],
): { backend: SearchBackend | null; row: SearchProviderRecord | null; reason: string | null } {
  const usable = searchServices(rows);
  if (usable.length === 0) {
    // Nothing can answer. The reason is the most specific one available: a row
    // that is enabled but broken says which one and what is wrong with it.
    const enabled = rows.filter((row) => row.enabled);
    for (const row of enabled) {
      const usability = searchServiceUsability(row);
      if (!usability.usable) {
        return { backend: null, row, reason: usability.reason };
      }
    }
    return { backend: null, row: null, reason: "没有启用任何搜索服务" };
  }
  if (usable.length > 1) {
    return { backend: null, row: null, reason: unnamedSearchProvider(rows).problem };
  }
  const row = rows.find((candidate) => candidate.serviceId === usable[0].id) ?? null;
  if (!row) {
    return { backend: null, row: null, reason: "没有可用的搜索服务" };
  }
  const backend = backendForSearchProvider(row);
  if (!backend) {
    return { backend: null, row, reason: "这个搜索服务的配置不完整" };
  }
  return { backend, row, reason: null };
}

/**
 * The services that can answer, by their client-visible names.
 *
 * Only the ones that **can** answer: a service that is switched off, or
 * missing its key, is not offered — offering it would be a promise the
 * deployment cannot keep, and the whole point of the catalogue is that
 * everything in it can be named and will work.
 */
export function searchServices(
  rows: readonly SearchProviderRecord[],
): Array<{ id: string; name: string; kind: string }> {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({ row, usability: searchServiceUsability(row) }))
    .filter((entry) => entry.usability.usable)
    .map(({ row }) => ({
      id: row.serviceId,
      name: row.name,
      kind: row.kind,
    }));
}

/**
 * The service that answers when the caller did not name one.
 *
 * **There is no default.** A deployment may offer several, and the one that
 * answers is the one somebody chose — the client by name, the person in their
 * own settings. A hidden default would be precisely the invisible choice this
 * is here to remove: the account would be charged to one vendor's price and
 * served by another without anybody having said so.
 *
 * So there are only two answers here:
 *
 *  - **exactly one** service can answer → it answers. There was no choice to
 *    make, and the response says which one it was.
 *  - **more than one** can answer → nobody chose, so nobody is searched with.
 *    The request is refused, and the refusal names the services on offer.
 */
export function unnamedSearchProvider(
  rows: readonly SearchProviderRecord[],
): { row: SearchProviderRecord | null; problem: string | null } {
  const usable = searchServices(rows);
  if (usable.length === 0) {
    return { row: null, problem: null };
  }
  if (usable.length === 1) {
    const row = rows.find((candidate) => candidate.serviceId === usable[0].id) ?? null;
    return { row, problem: null };
  }
  const names = usable.map((service) => `「${service.id}」`).join("、");
  return {
    row: null,
    problem:
      `这个部署有多个搜索服务（${names}），请指定用哪一个` +
      "（GET /v1/search/services 可以看到全部）。",
  };
}

export async function resolveActiveSearchBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchBackend | null> {
  return (await resolveActiveSearchBackendWithReason(env)).backend;
}

/**
 * The same answer, with the reason attached.
 *
 * The reason is what a caller can be told when the answer is "no": "there is
 * no service" and "the service you have is missing its key" are different
 * problems, and the second one names the fix.
 */
export async function resolveActiveSearchBackendWithReason(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ backend: SearchBackend | null; row: SearchProviderRecord | null; reason: string | null }> {
  const rows = await listSearchProviders();
  if (rows.length === 0) {
    const backend = resolveSearchBackend(env);
    return {
      backend,
      row: null,
      // No rows and no environment: there is nothing specific to say, and the
      // caller has an actionable message of its own for exactly this case.
      reason: null,
    };
  }
  return backendForRows(rows);
}

/**
 * The backend of one **named** service.
 *
 * The point of naming: a client that asks for `tavily` gets `tavily`, or an
 * answer saying why it cannot. It never gets a different vendor.
 */
export async function resolveSearchBackendByServiceId(
  serviceId: string,
): Promise<{ backend: SearchBackend | null; row: SearchProviderRecord | null; problem: string | null }> {
  const rows = await listSearchProviders();
  const { row, problem } = namedSearchProvider(rows, serviceId);
  if (!row) {
    return { backend: null, row: null, problem: `没有叫「${serviceId}」的搜索服务` };
  }
  if (problem === "disabled") {
    return { backend: null, row, problem: `搜索服务「${row.serviceId}」已经停用` };
  }
  const usability = searchServiceUsability(row);
  if (!usability.usable) {
    return { backend: null, row, problem: usability.reason };
  }
  const backend = backendForSearchProvider(row);
  if (!backend) {
    return { backend: null, row, problem: "这个搜索服务的配置不完整" };
  }
  return { backend, row, problem: null };
}

/**
 * The backend that answers for **this** account.
 *
 * The user's own search service comes first, and the reason is money: a user
 * who brought their own service is paying that vendor themselves, and the
 * deployment's provider is not theirs to spend.
 *
 * Then the service **the user chose** out of the deployment's. If that choice
 * cannot be honoured — the row is gone, switched off, or broken — the answer
 * is a refusal that names it, not a different vendor: the user picked this one
 * knowingly, and quietly serving a different one would undo that.
 *
 * The administrator's switch still governs: the deployment's search being off
 * is a statement about the deployment, and it is not a user's to overrule.
 */
export async function resolveSearchBackendForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { serviceId?: string | null } = {},
): Promise<SearchBackend | null> {
  const own = await userSearchBackend(userId);
  if (own) return own;

  const wanted = opts.serviceId?.trim();
  if (wanted) {
    const named = await resolveSearchBackendByServiceId(wanted);
    if (named.backend) return named.backend;
    // The choice cannot be honoured. Say so, by name.
    throw new WebSearchError(
      `你选的搜索服务「${wanted}」现在用不了：${named.problem ?? "配置不完整"}。` +
        "请到「AI 助手 → 设置」里重新选一个。",
      "not_configured",
    );
  }

  return resolveActiveSearchBackend(env);
}

/**
 * The backend that answers for **this** account, read from the account's own
 * settings.
 *
 * The one place that knows all three: the user's own service (their bill), the
 * service they picked out of the deployment's, and — when they picked none and
 * the deployment has only one — that one.
 */
export async function resolveSearchBackendForAccount(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchBackend | null> {
  const settings = await getAssistantSettings(userId);
  return resolveSearchBackendForUser(userId, env, {
    serviceId: settings?.searchServiceId ?? null,
  });
}

export async function activeSearchBackendInfo(
  env: NodeJS.ProcessEnv = process.env,
  rows?: readonly SearchProviderRecord[],
): Promise<ActiveBackendInfo> {
  const list = rows ?? (await listSearchProviders());
  if (list.length === 0) {
    const backend = resolveSearchBackend(env);
    if (!backend) {
      return {
        configured: false,
        name: null,
        kind: null,
        baseUrl: null,
        source: null,
        usageProviderId: null,
        creditsPerCall: null,
        serviceId: null,
        unusableReason: null,
        providerId: null,
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
      serviceId: null,
      unusableReason: null,
      providerId: null,
    };
  }

  const { backend, row, reason } = backendForRows(list);
  if (!backend) {
    return {
      // No backend answered, so there is no backend to attribute one to. The
      // reason is what says why — "the service you have is missing its key" is
      // a different problem from "there is no service", and only one of them
      // is the operator's to fix.
      configured: false,
      name: row?.name ?? null,
      kind: null,
      baseUrl: null,
      source: null,
      usageProviderId: null,
      creditsPerCall: null,
      serviceId: row?.serviceId ?? null,
      unusableReason: reason,
      providerId: row?.id ?? null,
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
    serviceId: row?.serviceId ?? null,
    unusableReason: null,
    providerId: row?.id ?? null,
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
