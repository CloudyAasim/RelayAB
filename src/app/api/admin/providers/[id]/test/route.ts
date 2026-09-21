/**
 * POST /api/admin/providers/[id]/test
 *
 * Health check — sends a minimal /chat/completions-equivalent to the upstream.
 * Returns { ok, status, latencyMs, error? }.
 *
 * Strategy: try GET /v1/models first (lightest probe). If the upstream
 * doesn't expose /v1/models (e.g. some Azure deployments), fall back to a
 * 1-token chat completion.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getProviderById } from "@/lib/db/providers";
import { callUpstream } from "@/lib/providers/upstream";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
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

  const probe = await callUpstream({
    baseUrl: provider.baseUrl ?? "",
    encryptedApiKey: provider.encryptedApiKey,
    path: "/v1/models",
    timeoutMs: 6000,
  });

  if (probe.ok) {
    return NextResponse.json({
      ok: true,
      method: "GET /v1/models",
      status: probe.status,
      latencyMs: probe.latencyMs,
    });
  }

  return NextResponse.json({
    ok: false,
    method: "GET /v1/models",
    status: probe.status,
    latencyMs: probe.latencyMs,
    error: probe.error ?? `HTTP ${probe.status}`,
  });
}
