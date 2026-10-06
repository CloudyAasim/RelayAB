/**
 * app/api/v1/images/edits/route.ts
 *
 * OpenAI Images compatible image-to-image endpoint, exposed publicly as
 * `POST /v1/images/edits` (multipart/form-data).
 *
 * The uploaded image is normalised to a data URL here, once. What the vendor
 * then does with it is entirely the spec's business: a provider that supports
 * a character reference maps it to that (MiniMax), a provider that supports a
 * masked edit maps it to that. Providers advertise which one they do through
 * `relay.edit_mode` in `/v1/models`.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById as lookupUserById } from "@/lib/db/users";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";
import { executeMediaRequest, fileToDataUrl, imageItemsResponse, requirePrompt, resultItems, type MediaRequestInput } from "@/lib/media/handler";
import type { ApiKey } from "@/lib/db/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 10 MB upstream limit (MiniMax documents <10MB for reference images). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return proxyError(400, "invalid_request", "expected multipart/form-data");
  }

  const model = form.get("model");
  const requestedModel = typeof model === "string" ? model : "";
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

  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return proxyError(400, "invalid_request", "an 'image' file is required");
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return proxyError(400, "invalid_request", "'image' exceeds the 10MB limit");
  }

  const prompt = form.get("prompt");
  const size = form.get("size");
  const responseFormat = form.get("response_format");
  const n = Number(form.get("n"));
  const seed = Number(form.get("seed"));

  const input: MediaRequestInput = {
    model: requestedModel,
    prompt: typeof prompt === "string" ? prompt : "",
    image: await fileToDataUrl(image),
    ...(Number.isFinite(n) && n > 0 ? { n } : {}),
    ...(typeof size === "string" && size ? { size } : {}),
    ...(typeof responseFormat === "string" && responseFormat
      ? { responseFormat }
      : {}),
    ...(Number.isFinite(seed) ? { seed } : {}),
    // Everything else the client sent stays reachable from a spec, under both
    // its original and its camelCase spelling (see buildMediaScope).
    extra: Object.fromEntries(
      [...form.entries()].filter(
        ([key, value]) => key !== "image" && typeof value === "string",
      ),
    ),
  };

  const invalid = requirePrompt(input.prompt);
  if (invalid) {
    return proxyError(invalid.status, invalid.code, invalid.message);
  }

  const outcome = await executeMediaRequest({
    capability: "image.edit",
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
}
