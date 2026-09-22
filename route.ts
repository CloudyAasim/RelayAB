/**
 * POST /api/admin/providers/probe
 * 
 * Probe endpoint for testing provider connection and fetching models
 * before creating a provider. This doesn't require an existing provider.
 * 
 * Body: { baseUrl, apiKey, kind?, path? }
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

  let body: { baseUrl?: string; apiKey?: string; kind?: string; path?: string } = {};
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
  
  // Determine the models path based on provider kind or use provided path
  let path = body.path;
  if (!path) {
    // Providers that don't support auto model listing
    if (body.kind === "anthropic" || body.kind === "azure" || body.kind === "custom-openai") {
      // These providers don't have standard models list endpoints
      return NextResponse.json({
        ok: true,
        status: 200,
        latencyMs: 0,
        models: [],
        notice: body.kind === "anthropic" 
          ? "Anthropic does not support automatic model listing. Please add models manually."
          : body.kind === "azure"
          ? "Azure OpenAI does not support automatic model listing. Please add models manually."
          : "Custom OpenAI-compatible providers may not support automatic model listing. Please add models manually.",
      });
    } else {
      // Default to OpenAI-compatible /v1/models or /models
      path = "/v1/models";
    }
  }

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

  const models = extractModelIds(result.body);
  
  return NextResponse.json({
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    models,
  });
}
