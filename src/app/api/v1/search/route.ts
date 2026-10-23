/**
 * app/api/v1/search/route.ts
 *
 * Web search as a gateway endpoint: `POST /v1/search`, `GET /v1/search?q=`.
 *
 * The same `searchWeb()` the assistant's `web_search` tool calls. Exposing it
 * separately is the point: a client that only needs the links should not have
 * to pay a language model to ask for them. Searching costs no tokens, and the
 * response here is the search result list, not a generated answer.
 *
 * Authentication, quotas and usage recording are the same as every other paid
 * endpoint. The price is **per call**, not per result: the upstream work is
 * the same whether the query matched nine pages or none, and a price that
 * varies with the result count would be unreadable on a usage bill. The admin
 * panel (`/admin/search`) sets it; `SEARCH_CREDITS_PER_CALL` is the fallback,
 * and 1 whole credit is the default.
 *
 * Failures are not charged. A search that never reached SearXNG, or that
 * SearXNG refused, produced nothing to bill for — and charging for it would
 * make an outage look like usage.
 */
import { NextResponse } from "next/server";

import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById } from "@/lib/db/users";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";
import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  WebSearchError,
} from "@/lib/assistant/web-search";
import { runBilledSearch } from "@/lib/search/billing";
import { loadSearchConfig } from "@/lib/search/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A search failure, in the shape the gateway already uses for upstream errors.
 *
 * `not_configured` is 503 rather than 500: the deployment is missing a
 * backend, not failing at a request. A caller can retry later; nothing about
 * the request was wrong.
 */
function searchErrorResponse(err: WebSearchError, headers?: Record<string, string>): Response {
  const map: Record<WebSearchError["code"], { status: number; code: string }> = {
    not_configured: { status: 503, code: "search_unavailable" },
    bad_key: { status: 502, code: "search_auth_failed" },
    rate_limited: { status: 429, code: "rate_limited" },
    upstream_error: { status: 502, code: "search_upstream_error" },
    unreachable: { status: 502, code: "search_unreachable" },
    // The account cannot pay for this call. 429, like the proxy's
    // `quota_exceeded_credits`: the request was fine, the balance was not, and
    // the client should top up rather than retry.
    quota_exceeded: { status: 429, code: "quota_exceeded_credits" },
  };
  const mapped = map[err.code];
  return proxyError(mapped.status, mapped.code, err.message, headers);
}

interface SearchBody {
  query?: unknown;
  q?: unknown;
  limit?: unknown;
  /**
   * The **client-visible name** of the search service to use, the way a chat
   * request names a model.
   *
   * Omitted means "the deployment's default service". A name that does not
   * exist, or that names a service which is switched off or cannot answer, is
   * refused **by name** — the request is never answered by searching through
   * some other service, because those carry their own price and a quiet
   * substitution would change what the account is charged as well as which
   * vendor answered.
   */
  service?: unknown;
}

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_SEARCH_RESULTS);
}

async function handle(req: Request, body: SearchBody): Promise<Response> {
  const auth = await authenticateBearer({ authHeader: resolveAuthHeader(req) });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }
  const owner = auth.user ?? (await getUserById(auth.key.userId));
  if (!owner) {
    return proxyError(403, "user_not_found", "The account owning this key no longer exists");
  }

  const config = await loadSearchConfig();
  if (!config.enabled) {
    // The same switch the assistant's tool reads, so "off" means off rather
    // than "off for this door".
    return proxyError(
      503,
      "search_disabled",
      "Web search is disabled by the administrator",
      quotaHeaders(owner),
    );
  }

  const rawQuery = body.query ?? body.q;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) {
    return proxyError(400, "invalid_request", "query is required");
  }
  if (query.length > MAX_QUERY_CHARS) {
    return proxyError(
      400,
      "invalid_request",
      `query is too long (${query.length} characters, maximum ${MAX_QUERY_CHARS})`,
    );
  }
  const limit = parseLimit(body.limit);

  /**
   * The service to search with.
   *
   * Blank means the deployment's default. Anything else is a name the caller
   * chose, and the resolver refuses a name it cannot honour rather than
   * quietly using another service.
   */
  const serviceId = typeof body.service === "string" ? body.service.trim() : "";

  /**
   * One call to the shared settlement, so the public endpoint and the panel's
   * test buttons price a search the same way and charge it the same way.
   */
  let settled;
  try {
    settled = await runBilledSearch({
      query,
      limit,
      user: owner,
      apiKeyId: auth.key.id,
      ...(serviceId ? { serviceId } : {}),
    });
  } catch (err) {
    if (err instanceof WebSearchError) return searchErrorResponse(err, quotaHeaders(owner));
    return proxyError(
      502,
      "search_failed",
      `search failed: ${err instanceof Error ? err.message : String(err)}`,
      quotaHeaders(owner),
    );
  }

  const { outcome, credits, user } = settled;

  return NextResponse.json(
    {
      object: "search",
      query: outcome.query,
      provider: outcome.provider,
      // The service that answered, so a caller that named one can see that it
      // got the one it asked for.
      ...(outcome.serviceId ? { service: outcome.serviceId } : {}),
      results: outcome.results,
      // Whole 积分, the same unit an operator types into the panel.
      credits,
    },
    { headers: quotaHeaders(user ?? owner) },
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: SearchBody;
  try {
    body = ((await req.json()) ?? {}) as SearchBody;
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }
  return handle(req, body);
}

/**
 * `GET` as well as `POST`.
 *
 * Search is a read, and `GET /v1/search?q=…` is what a browser, a curl one-liner
 * and most SDKs reach for first. The query is in the URL either way, so this
 * adds no exposure that `POST` did not already have.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return handle(req, {
    query: url.searchParams.get("q") ?? url.searchParams.get("query"),
    limit: url.searchParams.get("limit"),
    service: url.searchParams.get("service") ?? undefined,
  });
}
