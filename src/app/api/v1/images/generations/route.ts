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
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";
import { executeMediaRequest, imageItemsResponse, requirePrompt, resultItems, type MediaRequestInput } from "@/lib/media/handler";
import type { ApiKey } from "@/lib/db/types";
import { respondWithHeartbeat } from "@/lib/http/heartbeat";

export const runtime = "nodejs";
/*
 * No `maxDuration`: that is a Vercel platform declaration, and this deployment
 * is a Dokku container where nothing reads it. It used to say 300 here while the
 * route actually honoured a different number — one of the four places the
 * request budget was written down (see `lib/protocol/limits.ts`).
 */

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    requestedModel,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
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
    return proxyError(invalid.status, invalid.code, invalid.message);
  }

  /**
   * A 4K frame can take longer than any proxy's idle window, and the thing that
   * kills it is *silence*, not duration. Once this call passes the heartbeat
   * threshold the response starts emitting whitespace so the connection stays
   * alive for as long as the vendor's own spec allows (see
   * `lib/http/heartbeat.ts` for the trade-off that comes with it).
   */
  return respondWithHeartbeat(
    (async () => {
      const outcome = await executeMediaRequest({
        capability: "image.generate",
        input,
        apiKey: auth.key as ApiKey,
        user: owner,
        signal: req.signal,
      });

      if (!outcome.ok) {
        return proxyError(outcome.error.status, outcome.error.code, outcome.error.message);
      }
      const items = await resultItems(outcome.value.result);
      return NextResponse.json(imageItemsResponse(items), { headers: quotaHeaders(owner) });
    })(),
  );
}
