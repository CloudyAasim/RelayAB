/**
 * app/api/v1/images/generations/route.ts
 *
 * OpenAI Images compatible endpoint — exposed publicly as
 * `POST /v1/images/generations` through the rewrite in next.config.ts.
 *
 * The relay does not know MiniMax (or any vendor) here: the request is routed
 * to the media provider that publishes the model, and that provider's
 * declarative spec turns it into whatever the vendor expects.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById as lookupUserById } from "@/lib/db/users";
import { executeMediaRequest, imageItemsResponse, requirePrompt, resultItems, type MediaRequestInput } from "@/lib/media/handler";
import type { ApiKey } from "@/lib/db/types";

export const runtime = "nodejs";
// Image generation is slower than a chat turn; do not inherit the 60s default.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
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
      {
        ok: false,
        error: {
          code: "user_not_found",
          message: "The account owning this key no longer exists",
        },
      },
      { status: 403 },
    );
  }

  const input: MediaRequestInput = {
    model: requestedModel,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    ...(typeof body.n === "number" ? { n: body.n } : {}),
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.response_format === "string"
      ? { responseFormat: body.response_format }
      : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof body.style === "string" ? { style: body.style } : {}),
    ...(typeof body.watermark === "boolean" ? { watermark: body.watermark } : {}),
    ...(typeof body.prompt_optimizer === "boolean"
      ? { promptOptimizer: body.prompt_optimizer }
      : {}),
    // Vendor-specific extras (`negative_prompt`, `aigc_watermark`, …) stay
    // reachable from a spec under both spellings (see buildMediaScope).
    extra: body,
  };

  const invalid = requirePrompt(input.prompt);
  if (invalid) {
    return NextResponse.json(
      { ok: false, error: { code: invalid.code, message: invalid.message } },
      { status: invalid.status },
    );
  }

  const outcome = await executeMediaRequest({
    capability: "image.generate",
    input,
    apiKey: auth.key as ApiKey,
    user: owner,
    signal: req.signal,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: { code: outcome.error.code, message: outcome.error.message } },
      { status: outcome.error.status },
    );
  }
  const items = await resultItems(outcome.value.result);
  return NextResponse.json(imageItemsResponse(items));
}
