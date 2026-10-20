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
import { OPENAI_COMPATIBLE_TEMPLATE } from "./templates";

/**
 * The user's own backend, or null when they have not configured one.
 *
 * Null is the answer for "no own service", not an error: the caller falls
 * back to the deployment's providers, which is what every user has today.
 */
export async function userSearchBackend(userId: string): Promise<SearchBackend | null> {
  if (!userId) return null;

  const settings = await getAssistantSettings(userId);
  const baseUrl = settings?.searchBaseUrl?.trim();
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
    // The user's own service has no row in the deployment's provider table,
    // so there is no provider id to point a usage row at. Nothing is written
    // for a call through it anyway — their key paid their vendor.
    usageProviderId: `user:${userId}`,
    describe: "自己的搜索服务",
    credentialHint: "你自己的搜索服务 API 密钥",
  });
}
