/**
 * app/v1/chat/completions/responses/route.ts
 *
 * OpenAI Responses API compatible endpoint at /v1/chat/completions/responses.
 * This allows clients configured with base_url + "/responses" to work correctly
 * when the base_url is set to the chat completions endpoint.
 * 
 * If the upstream provider only supports Chat format, the request will be
 * converted to Chat Completions format and the response will be converted back.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp } from "@/lib/auth/apikey";
import { proxyOpenAIResponse, responsesToChatRequest, chatToResponsesResponse } from "@/lib/proxy/openai";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";
import { findProvidersForModel } from "@/lib/db/providers";

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

  const responseReq = body as Parameters<typeof proxyOpenAIResponse>[0]["req"];

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

  // Check if the provider supports Responses format
  const providers = await findProvidersForModel(requestedModel);
  const provider = providers[0];

  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "no_provider", message: `No provider found for model '${requestedModel}'` } },
      { status: 400 },
    );
  }

  if (provider.upstreamFormat !== "responses") {
    // Provider doesn't support Responses format - need to convert
    try {
      const { proxyChatCompletion } = await import("@/lib/proxy/openai");
      
      const chatReq = responsesToChatRequest(responseReq);
      const chatResult = await proxyChatCompletion({
        req: chatReq,
        apiKey: auth.key as ApiKey,
        user: owner,
      });

      if (!chatResult.ok) {
        return NextResponse.json(
          { ok: false, error: chatResult.error },
          { status: chatResult.status },
        );
      }

      // Convert Chat response back to Responses format
      const responsesData = chatToResponsesResponse(
        chatResult.data as any,
        responseReq,
      );

      return NextResponse.json(responsesData, { status: chatResult.status });
    } catch (err) {
      console.error("[v1/chat/completions/responses] conversion error:", err);
      return NextResponse.json(
        { ok: false, error: { code: "conversion_error", message: String(err) } },
        { status: 500 },
      );
    }
  }

  // Provider supports Responses format - use original flow
  let result;
  try {
    result = await proxyOpenAIResponse({
      req: responseReq,
      apiKey: auth.key as ApiKey,
      user: owner,
    });
  } catch (err) {
    console.error("[v1/chat/completions/responses] proxyOpenAIResponse threw:", err);
    return NextResponse.json(
      { ok: false, error: { code: "proxy_error", message: String(err) } },
      { status: 500 },
    );
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data, { status: result.status });
}
