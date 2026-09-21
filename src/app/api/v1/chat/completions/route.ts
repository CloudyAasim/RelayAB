/**
 * app/api/v1/chat/completions/route.ts
 *
 * OpenAI Chat Completions compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, messages, stream?, ... }
 *
 * Flow: parse Bearer → look up key → validate → forward → record usage.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp } from "@/lib/auth/apikey";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import type { ApiKey } from "@/lib/db/types";

export const runtime = "nodejs";
// Allow longer-running streaming responses on Vercel Pro (60s).
// On Hobby the limit is 30s for streaming.
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  // 1. Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  // 2. Authenticate.
  const requestedModel =
    typeof body === "object" && body !== null && "model" in body
      ? String((body as Record<string, unknown>).model ?? "")
      : "";
  const auth = await authenticateBearer({
    authHeader: req.headers.get("Authorization"),
    requestedModel,
  });

  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return NextResponse.json(
      { ok: false, error: { code: http.code, message: http.message } },
      { status: http.status },
    );
  }

  // 3. Forward.
  const result = await proxyChatCompletion({
    req: body as Parameters<typeof proxyChatCompletion>[0]["req"],
    apiKey: auth.key as ApiKey,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data, { status: result.status });
}
