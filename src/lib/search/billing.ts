/**
 * src/lib/search/billing.ts
 *
 * One search, one settlement.
 *
 * A search costs **one call's price** — whole 积分, fixed, independent of how
 * many results came back — and it is charged to the account that asked for it.
 * The public endpoint, the assistant's tool and the panel's test buttons all
 * have to agree on that, because a path that charges differently is a path
 * whose price nobody can quote.
 *
 * So the money is settled in **one place**, and the test buttons go through it
 * too. A test that ran the upstream for free was a free ride on a paid API —
 * the operator paid the vendor and the account paid nothing, and the only way
 * to find that out was to read the vendor's invoice.
 *
 * ## What is charged, and what is not
 *
 * - **A search that failed is not charged.** A request that never reached the
 *   vendor, or that the vendor refused, produced nothing to bill for, and
 *   charging for it would make an outage look like usage.
 * - **The price comes from the backend that served the call** — a provider row
 *   carries its own, and the environment fallback carries the feature-wide one.
 *   Two backends can have very different economics; one global number would
 *   overcharge the cheap one or lose money on the expensive one.
 * - **The pool belongs to the user**, not to a key: every key an account holds
 *   draws down the same balance.
 */
import { listApiKeyIdsForUsage, touchApiKeyLastUsed } from "@/lib/db/keys";
import { getUserById, incrementUserQuotaUsed } from "@/lib/db/users";
import { recordUsage } from "@/lib/db/usage";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import type { User } from "@/lib/db/types";
import { WebSearchError, searchWeb, type SearchOutcome } from "@/lib/assistant/web-search";
import { backendForSearchProvider, resolveActiveSearchBackend } from "@/lib/search/resolve";
import { getSearchProviderById } from "@/lib/db/search-providers";
import { loadSearchConfig } from "@/lib/search/config";
import { WEB_SEARCH_CAPABILITY, WEB_SEARCH_MODEL } from "@/lib/search/usage";

export interface BilledSearchArgs {
  query: string;
  /** How many results to ask for. */
  limit: number;
  /** Whose pool pays for the call. */
  user: User;
  /**
   * The key the usage row is attributed to.
   *
   * Empty when the caller is not using a key — a test run from the panel. The
   * row still names the user, so the spend shows up in the account's totals;
   * it simply does not belong to any key's breakdown.
   */
  apiKeyId?: string;
  /**
   * Whether the key's `lastUsedAt` should be touched.
   *
   * True for a client call, where "was this key used?" is a real question.
   * False for a panel-initiated test: no key was used — a person pressed a
   * button — and marking a key as used by that would be a lie.
   */
  touchKey?: boolean;
  /**
   * A specific provider row to use, whether or not it is the active one.
   *
   * This is what makes the per-row test button possible: a diagnostic has to
   * be able to ask "does *this* backend work?", which is a different question
   * from "what would a client get right now?".
   */
  providerId?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface BilledSearchResult {
  outcome: SearchOutcome;
  /** Whole 积分 charged for the call. */
  credits: number;
  /** Storage units (0.001 积分) actually drawn down. */
  creditsUsed: number;
  /** The user record after the charge, for the quota headers. */
  user: User | null;
}

/** The wording the assistant's tool uses for the same situation. */
const NO_BACKEND_MESSAGE =
  "没有可用的搜索后端。请到「管理 → 网页搜索」添加一个提供商，" +
  "或在环境变量里设置 TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_URL" +
  "（SearXNG 需要开启 JSON 输出）。没配置之前不要声称自己「搜索过」。";

/**
 * The wording for a provider row that exists but cannot answer.
 *
 * Different from "there is no backend at all": the row is there, and the
 * reason it cannot answer is a missing address, a missing key, or a key that
 * no longer decrypts — three things the operator can act on.
 */
const PROVIDER_INCOMPLETE_MESSAGE =
  "这个提供商的配置不完整（缺少地址、密钥，或密钥无法解密）。";

/**
 * Run a search and settle it.
 *
 * The failure path is deliberately the same for every caller: a refused
 * credential, a throttled vendor and an unreachable host all throw the
 * provider's own error, and none of them charges.
 */
export async function runBilledSearch(args: BilledSearchArgs): Promise<BilledSearchResult> {
  const backend = args.providerId
    ? await backendForProvider(args.providerId)
    : await resolveActiveSearchBackend(args.env);

  if (!backend) {
    throw new WebSearchError(
      args.providerId ? PROVIDER_INCOMPLETE_MESSAGE : NO_BACKEND_MESSAGE,
      "not_configured",
    );
  }

  // The price of the backend that will answer. A row carries its own; the
  // environment fallback has no row, so it uses the feature-wide price — and
  // only then is the configuration worth reading.
  const credits = backend.creditsPerCall ?? (await loadSearchConfig()).creditsPerCall;

  /**
   * The balance has to cover the call, or the call does not happen.
   *
   * Two ways to be unable to pay: the pool is empty (the same refusal the
   * chat proxy gives), or the pool holds something but not enough for *this*
   * call's price — a search costs a fixed number of credits, so "a bit left"
   * is not "enough". Either way the request is refused **before** the vendor is
   * called: a search that cannot be paid for must not be free, and it must not
   * cost the operator a call it is not going to be billed for either.
   *
   * The check is here, in the shared settlement, so that the public endpoint
   * and the panel's test buttons cannot drift apart on it — one rule, one
   * place, and the same answer whichever door the call came through.
   */
  assertCanPay(args.user, credits);

  const results = await searchWeb(args.query, {
    limit: args.limit,
    fetchImpl: args.fetchImpl,
    backend,
  });

  const creditsUsed = credits * CREDIT_SCALE;

  // The repository hands back the fresh row, so the balance the caller reports
  // is the one after the charge and not a second read that might disagree.
  const updated =
    creditsUsed > 0
      ? await incrementUserQuotaUsed(args.user.id, creditsUsed)
      : await getUserById(args.user.id);

  // Touched on every settled call, billed or not: "was this key used?" and
  // "was the user charged?" are different questions. A panel-initiated test
  // used no key, so it touches none.
  if (args.apiKeyId && args.touchKey !== false) {
    await touchApiKeyLastUsed(args.apiKeyId);
  }

  await recordUsage({
    apiKeyId: args.apiKeyId ?? "",
    userId: args.user.id,
    providerId: backend.usageProviderId,
    model: WEB_SEARCH_MODEL,
    upstreamModel: backend.provider,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed,
    capability: WEB_SEARCH_CAPABILITY,
    status: "success",
  });

  const outcome: SearchOutcome = {
    provider: backend.provider,
    providerId: backend.usageProviderId,
    backend: backend.describe,
    query: results.query,
    results: results.results,
  };

  return { outcome, credits, creditsUsed, user: updated };
}

/**
 * The backend of one named provider row, whether or not it is enabled.
 *
 * A diagnostic has to be able to test a backend that is currently switched
 * off — that is usually *why* somebody is testing it.
 */
async function backendForProvider(providerId: string) {
  const row = await getSearchProviderById(providerId);
  if (!row) return null;
  return backendForSearchProvider(row);
}

/**
 * Refuse a call the account cannot pay for.
 *
 * A free call (price 0) is never refused — there is nothing to pay.
 *
 * The two sides are in different units on purpose and are converted here: the
 * price is **whole 积分** (what an operator types into the panel), while the
 * account's balance is stored in **0.001-积分 units**. Comparing them
 * directly would read a 0.5-积分 balance as "500 credits left" and let the
 * call through.
 */
function assertCanPay(user: User, credits: number): void {
  if (!Number.isFinite(credits) || credits <= 0) return;

  const remainingUnits = user.quotaLimit - user.quotaUsed;
  const priceUnits = credits * CREDIT_SCALE;
  if (remainingUnits >= priceUnits) return;

  throw new WebSearchError(
    `积分余额不足：这次搜索需要 ${credits} 积分，账号余额 ${(Math.max(0, remainingUnits) / CREDIT_SCALE).toFixed(3)} 积分。` +
      "请先在「我的密钥与额度」里充值，或请管理员调整额度。",
    "quota_exceeded",
  );
}

/**
 * The key a panel-initiated call is charged against.
 *
 * The account's own first key, from the set its balance can be charged
 * through — the same set the usage pages read, so the spend appears next to
 * the balance it moved. That set includes the assistant credential, which is
 * a real key row the account owns even though it is not in its management
 * list, so an account whose only key is that one still gets its test spend
 * on the page where the balance is.
 *
 * **Empty means the account has no key at all**, and then there is nowhere to
 * put the usage row: `api_key_id` is not optional, because a credit that
 * cannot be seen in any report is a credit nobody can audit. The caller
 * refuses the call in that case rather than charging for something nobody
 * would see.
 */
export async function attributionKeyFor(userId: string): Promise<string> {
  const keyIds = await listApiKeyIdsForUsage(userId);
  return keyIds[0] ?? "";
}
