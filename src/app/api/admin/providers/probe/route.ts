/**
 * POST /api/admin/providers/probe
 * 
 * Probe endpoint for testing provider connection and fetching models
 * before creating a provider. This doesn't require an existing provider.
 * 
 * Body: { baseUrl, apiKey, path? }
 */
import { NextResponse } from "next/server";
import { callUpstream, extractModelIds } from "@/lib/providers/upstream";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const me = await import("@/lib/auth/session").then(m => m.getCurrentUser());
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  let body: { baseUrl?: string; apiKey?: string; path?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
      { status: 400 },
    );
  }

  if (!body.baseUrl) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_baseUrl", message: "baseUrl is required" } },
      { status: 400 },
    );
  }

  if (!body.apiKey) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_apiKey", message: "apiKey is required" } },
      { status: 400 },
    );
  }

  // Encrypt a temporary key for callUpstream
  const { encryptSecret } = await import("@/lib/crypto/secrets");
  const encryptedKey = encryptSecret(body.apiKey);
  const path = body.path ?? "/v1/models";

  const result = await callUpstream({
    baseUrl: body.baseUrl,
    encryptedApiKey: encryptedKey,
    path,
  });

  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error ?? `Upstream returned HTTP ${result.status}`,
    });
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    models: extractModelIds(result.body),
  });
}
