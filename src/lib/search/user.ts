/**
 * src/lib/search/user.ts
 *
 * The user's **own** search service.
 *
 * The assistant used to be able to search only through the deployment's
 * providers — the ones an administrator configured and pays for. That is a
 * reasonable default and an incomplete one: a user who already has a search
 * service (another instance of this gateway, an AI-搜索 中转, anything that
 * speaks the OpenAI-compatible search shape) should be able to point the
 * assistant at it and keep their own vendor's bill.
 *
 * ## Why it is not a row in the provider table
 *
 * The provider table is the **deployment's** list: its rows carry the
 * deployment's credentials, its prices and its priorities, and it is read by
 * every account at once. A user's own service is none of those — it is
 * per-account, it is paid for by the user, and it must never be visible to
 * anybody else. So it lives on the user's own settings row.
 *
 * ## The shape
 *
 * The OpenAI-compatible search shape, which is the one this gateway already
 * speaks on `/v1/search`:
 *
 *   POST <地址>
 *   Authorization: Bearer <密钥>
 *   {"query": "搜索词", "limit": 6}
 *   → {"results": [{"title", "url", "snippet"}]}
 *
 * The address is the **whole endpoint**: nothing is appended to it, because
 * what a user pastes from a vendor's documentation is the endpoint itself.
 *
 * ## What it costs
 *
 * Nothing, to the account. The user's own key pays their own vendor; the
 * gateway is a relay here, not a reseller. The deployment's own providers
 * are charged, because the deployment pays those vendors.
 */
import { decryptSecret } from "../crypto/secrets";
import { getAssistantSettings } from "../db/assistant";
import { createSearchBackend, type SearchBackend } from "../assistant/web-search";
import { isPrivateAddress } from "../assistant/web-fetch";
import { isIP } from "node:net";
import { OPENAI_COMPATIBLE_TEMPLATE } from "./templates";

/**
 * Whether an address points inside the deployment — checked **without** a DNS
 * round trip.
 *
 * Only the literal cases, on purpose. An address written as `127.0.0.1` or
 * `localhost` is refused where the person who typed it is looking at the
 * message, which is the cheapest place to refuse it. A name that resolves to a
 * private address is caught when the request is actually made, because that is
 * the check that cannot be side-stepped by a rebind and the only one that
 * sees the address the request really goes to.
 */
export function isPrivateSearchAddress(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // The two names a container network and an office DNS hand out.
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // Only a literal address can be judged without a lookup. A name is left
  // alone here and judged when the request is made, where the check sees the
  // address the request really goes to.
  if (isIP(host) === 0) return false;
  return isPrivateAddress(host);
}

/**
 * Whether this account's own service is the one to search with.
 *
 * Three answers, and the third one is the rule this feature started with:
 *
 *  - `own` — the user said so.
 *  - `deployment` — the user said so, and it wins over an address they have
 *    stored: their own service is down for a while and they still want the
 *    assistant to search, and the address should not have to be thrown away to
 *    get there.
 *  - `null` — nobody said: the old rule, "own service when there is an
 *    address, the deployment's otherwise". Every row written before the choice
 *    existed is in this state, and it keeps working exactly as it did.
 */
export function useOwnSearchService(
  settings: { searchSource?: "deployment" | "own" | null; searchBaseUrl?: string | null } | null,
): boolean {
  if (!settings) return false;
  if (settings.searchSource === "deployment") return false;
  // "own" still needs an address to be usable, so a row that says "own" with no
  // address does not use the own service — the save refuses to create that
  // state, and this is the second line of defence for a row written by
  // something else.
  return Boolean(settings.searchBaseUrl?.trim());
}

/**
 * The user's own backend, or null when they have not configured one.
 *
 * Null is the answer for "no own service", not an error: the caller falls
 * back to the deployment's providers, which is what every user has today.
 */
export async function userSearchBackend(userId: string): Promise<SearchBackend | null> {
  if (!userId) return null;

  const settings = await getAssistantSettings(userId);
  if (!useOwnSearchService(settings)) return null;

  const baseUrl = settings!.searchBaseUrl?.trim();
  if (!baseUrl) return null;

  let apiKey: string | undefined;
  if (settings?.encryptedSearchApiKey) {
    try {
      apiKey = decryptSecret(settings.encryptedSearchApiKey);
    } catch {
      // A key encrypted under a rotated master key cannot be used. The row is
      // skipped — the deployment's provider answers instead — rather than
      // failing every search with "decryption failed".
      return null;
    }
  }

  return createSearchBackend({
    spec: OPENAI_COMPATIBLE_TEMPLATE.spec,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    source: "user",
    /**
     * The address is a stranger's text, and the gateway is the thing that would
     * make the request.
     *
     * So it is held to the rule `fetch_page` already applies: the host has to
     * resolve to public addresses, and a redirect is not followed off the
     * public internet. Without this, any logged-in account could point the
     * gateway at the cloud metadata endpoint or at the gateway's own port and
     * read the answer back out of the search results.
     *
     * The operator's own provider rows are not held to it — a self-hosted
     * SearXNG on a private network is a normal thing to run.
     */
    publicOnly: true,
    // The user's own service has no row in the deployment's provider table,
    // so there is no provider id to point a usage row at. Nothing is written
    // for a call through it anyway — their key paid their vendor.
    usageProviderId: `user:${userId}`,
    describe: "自己的搜索服务",
    credentialHint: "你自己的搜索服务 API 密钥",
  });
}
