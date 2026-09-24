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
import { listClientModelIds, openAIModelList } from "@/lib/proxy/model-catalog";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return NextResponse.json(
      { ok: false, error: { code: http.code, message: http.message } },
      { status: http.status },
    );
  }

  const ids = await listClientModelIds(auth.key);
  return NextResponse.json({
    object: "list",
    data: openAIModelList(ids, Math.floor(Date.now() / 1000)),
  });
}
