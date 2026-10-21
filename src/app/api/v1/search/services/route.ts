/**
 * app/api/v1/search/services/route.ts
 *
 * The catalogue of search services, the way `GET /v1/models` is the catalogue of
 * models.
 *
 * A relay publishes what it can serve and lets the caller choose. The search
 * services used to be the one thing it did not publish: there could be several
 * rows, but only the first one by priority ever answered, and a client had no
 * way to find out that the others existed.
 *
 * So each search service now carries a **client-visible name**, the same job a
 * model name does, and this endpoint is where a client reads them.
 *
 * **Only the services that can answer are listed.** The list is a promise: a
 * service in it can be named and will work. A service that is switched off, or
 * that is missing its key, is not in the list — and asking for it by name is
 * refused by name rather than answered by searching somewhere else.
 *
 * The endpoint's own address, the credential and the price stay private: those
 * are the operator's business, and a client naming a service has no need for
 * them.
 */
import { NextResponse } from "next/server";

import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { listSearchProviders } from "@/lib/db/search-providers";
import { searchServices } from "@/lib/search/resolve";
import { proxyError } from "@/lib/proxy/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    // Listing is a read: an account that cannot afford a search can still ask
    // what there is to search with.
    skipQuotaCheck: true,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const rows = await listSearchProviders();
  const data = searchServices(rows).map((service) => ({
    id: service.id,
    object: "search_service" as const,
    /** The operator's own name for it. */
    name: service.name,
    /** The vendor it talks to. */
    kind: service.kind,
    /** Whether this is the one a caller gets when it does not name one. */
    default: service.default,
  }));

  return NextResponse.json({ object: "list", data });
}
