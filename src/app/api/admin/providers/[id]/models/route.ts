/**
 * POST /api/admin/providers/[id]/models
 *
 * Body: { baseUrl?: string, encryptedApiKey?: string, path?: string }
 *
 * If body fields are omitted, the persisted provider's stored values are used.
 * Returns { ok, models: string[], status, latencyMs, error? }.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getProviderById } from "@/lib/db/providers";
import { callUpstream, extractModelIds, decryptProviderKey } from "@/lib/providers/upstream";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  const provider = await getProviderById(id);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Provider not found" } },
      { status: 404 },
    );
  }

  let body: { baseUrl?: string; encryptedApiKey?: string; path?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body — fine, use persisted values.
  }

  const baseUrl = body.baseUrl ?? provider.baseUrl ?? "";
  const path = body.path ?? "/v1/models";
  const encryptedApiKey = body.encryptedApiKey ?? provider.encryptedApiKey;

  // Quick sanity: keys decrypt OK.
  try {
    decryptProviderKey(encryptedApiKey);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "decrypt_failed",
          message: err instanceof Error ? err.message : "Cannot decrypt API key",
        },
      },
      { status: 500 },
    );
  }

  const result = await callUpstream({ baseUrl, encryptedApiKey, path });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: result.status,
        latencyMs: result.latencyMs,
        error: result.error ?? `Upstream returned HTTP ${result.status}`,
      },
      { status: 200 }, // 200 so the client always gets the body
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    models: extractModelIds(result.body),
  });
}
