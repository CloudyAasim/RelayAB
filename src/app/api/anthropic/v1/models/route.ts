/**
 * app/api/anthropic/v1/models/route.ts
 *
 * Model catalogue for the Anthropic surface.
 *
 * ONLYOFFICE's built-in Anthropic provider does not implement `getModels()`,
 * so the editor always calls `GET {url}/{addon}/models` when the user presses
 * "load models". Configuring the relay as `https://api.aasim.l.cd/anthropic`
 * therefore targets this route — without it every Anthropic attempt ended in
 * "cannot load models" while the chat endpoint was actually fine.
 *
 * Auth: `x-api-key: sk-relay-...` or `Authorization: Bearer sk-relay-...`.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { anthropicModelList, listClientModelIds } from "@/lib/proxy/model-catalog";

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
  const data = anthropicModelList(ids, new Date());

  return NextResponse.json({
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  });
}
