/**
 * app/api/anthropic/v1/messages/route.ts
 *
 * Anthropic Messages API compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, messages, max_tokens, ... }
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp } from "@/lib/auth/apikey";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";
// Long generations must not be cut off at 60s.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const requestedModel =
    typeof body === "object" && body !== null && "model" in body
      ? String((body as Record<string, unknown>).model ?? "")
      : "";
  // Anthropic SDKs (and MiniMax's Anthropic-compatible endpoint) send the key
  // in `x-api-key`; OpenAI-style clients use `Authorization: Bearer`.
  const authHeader =
    req.headers.get("Authorization") ??
    (req.headers.get("x-api-key") ? `Bearer ${req.headers.get("x-api-key")}` : null);
  const auth = await authenticateBearer({
    authHeader,
    requestedModel,
  });

  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return NextResponse.json(
      { ok: false, error: { code: http.code, message: http.message } },
      { status: http.status },
    );
  }

  // The owner record carries the quota pool and the model whitelist.
  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "user_not_found", message: "The account owning this key no longer exists" },
      },
      { status: 403 },
    );
  }

  const result = await proxyAnthropicMessage({
    req: body as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data, { status: result.status });
}
