/**
 * app/api/v1/models/route.ts
 *
 * OpenAI /v1/models compatible endpoint.
 *
 * Returns the list of client-visible models the authenticated key
 * is allowed to call, intersected with what providers actually support.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { listClientModelEntries } from "@/lib/proxy/model-catalog";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const entries = await listClientModelEntries(auth.key);
  // The owner comes back with the validation result, so the balance is available
  // here without a second lookup — a client polling the catalogue gets its
  // remaining quota from the same call.
  return NextResponse.json(
    { object: "list", data: entries },
    { headers: auth.user ? quotaHeaders(auth.user) : undefined },
  );
}
