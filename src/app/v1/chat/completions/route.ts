/**
 * app/v1/chat/completions/route.ts
 *
 * Root-level OpenAI Chat Completions endpoint (no /api prefix).
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp } from "@/lib/auth/apikey";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "The account owning this key no longer exists" } },
      { status: 403 },
    );
  }

  const result = await proxyChatCompletion({
    req: body as Parameters<typeof proxyChatCompletion>[0]["req"],
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
