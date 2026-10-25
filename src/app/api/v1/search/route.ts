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
import { searchErrorHttp } from "@/lib/search/types";
import type { WebSearchResult } from "@/lib/search/types";
import { runBilledSearch } from "@/lib/search/billing";
import { loadSearchConfig } from "@/lib/search/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A search failure, in the shape the gateway already uses for upstream errors.
 *
 * The status and the code come from one shared table, so this door and the
 * chat proxy's hosted search cannot answer the same failure two different
 * ways.
 */
function searchErrorResponse(err: WebSearchError, headers?: Record<string, string>): Response {
  const mapped = searchErrorHttp(err.code);
  return proxyError(mapped.status, mapped.code, err.message, headers);
}

interface SearchBody {
  query?: unknown;
  q?: unknown;
  limit?: unknown;
  /**
   * How many results to ask for — the other name for it.
   *
   * `count` is what the other search APIs call it, and a client that was
   * written against one of them sends `count` and nothing else. Both spellings
   * are accepted; `limit` wins when both are there, because it is the one this
   * endpoint has always documented.
   */
  count?: unknown;
  /**
   * Whether the page bodies come with the results.
   *
   * It is a request, not a promise: a vendor that returns no body simply does
   * not send one, and the answer carries the shorter text instead. The fetch
   * endpoint is the way to ask for a whole page.
   */
  need_content?: unknown;
  /**
   * The **client-visible name** of the search service to use, the way a chat
   * request names a model.
   *
   * Omitted means the deployment's default service. A name that does not
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

function parseNeedContent(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return false;
}

/**
 * One hit, in the shape a client reads.
 *
 * The three that are always there, and the rest **when the vendor answered
 * them**: a relay cannot invent a relevance score, and a made-up one is worse
 * than a missing one.
 */
function publicResult(result: WebSearchResult): Record<string, unknown> {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.content ? { content: result.content } : {}),
    ...(result.score !== undefined ? { score: result.score } : {}),
    ...(result.date ? { date: result.date } : {}),
    ...(result.siteName ? { site_name: result.siteName } : {}),
  };
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
  const limit = parseLimit(body.limit ?? body.count);
  const needContent = parseNeedContent(body.need_content);

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
      ...(needContent ? { needContent: true } : {}),
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
      results: outcome.results.map(publicResult),
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
    limit: url.searchParams.get("limit") ?? url.searchParams.get("count") ?? undefined,
    need_content: url.searchParams.get("need_content") ?? undefined,
    service: url.searchParams.get("service") ?? undefined,
  });
}
