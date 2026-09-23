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
import { listProviders } from "@/lib/db/providers";

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

  const allProviders = await listProviders({ enabledOnly: true });
  const clientModels = new Set<string>();
  for (const p of allProviders) {
    for (const clientModel of Object.keys(p.modelMapping)) {
      // Apply the key's allowedModels whitelist.
      if (auth.key.allowedModels.length === 0 || auth.key.allowedModels.includes(clientModel)) {
        clientModels.add(clientModel);
      }
    }
  }

  const data = Array.from(clientModels).map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "relayab",
  }));

  return NextResponse.json({ object: "list", data });
}
