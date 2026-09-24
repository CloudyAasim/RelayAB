/**
 * src/lib/proxy/anthropic-route.ts
 *
 * Shared request handler for the Anthropic Messages API compatible surface.
 *
 * Two paths reach it, and both must behave identically:
 *
 *   POST /anthropic/v1/messages  — explicit provider-style prefix
 *   POST /v1/messages            — Anthropic's own convention
 *
 * The second one matters for ONLYOFFICE: its built-in Anthropic template is
 * configured as `super("Anthropic", "https://api.anthropic.com", "", "v1")`,
 * i.e. the base URL is the bare origin and the SDK-style path `/v1/messages`
 * is appended. A user who mirrors that shape with the relay origin
 * (`https://api.aasim.l.cd`) would otherwise POST to `/v1/messages` and get a
 * 404 even though `/v1/models` right next to it works.
 *
 * Keeping one implementation here means the two routes cannot drift.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export async function handleAnthropicMessages(req: Request): Promise<Response> {
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
  // Anthropic SDKs (and OnlyOffice's Anthropic template) send the key in
  // `x-api-key`; OpenAI-style clients use `Authorization: Bearer`. Both
  // carriers are normalised by `resolveAuthHeader`, which also honours the
  // legacy `?api_key=` query-param style.
  const authHeader = resolveAuthHeader(req);
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

  const requestedStream =
    typeof body === "object" && body !== null && "stream" in body &&
    Boolean((body as Record<string, unknown>).stream);
  const result = await proxyAnthropicMessage({
    req: body as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    // Let a client disconnect settle the usage row instead of dropping it.
    signal: req.signal,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }
  return proxyResultToResponse(result, { streamRequest: requestedStream });
}
