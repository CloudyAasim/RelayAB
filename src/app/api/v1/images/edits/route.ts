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
import { MAX_IMAGE_UPLOAD_BYTES, MAX_REFERENCE_IMAGES } from "@/lib/protocol/limits";
import { respondWithHeartbeat } from "@/lib/http/heartbeat";

export const runtime = "nodejs";

/** 10 MB per reference image (MiniMax documents <10MB for reference images). */
const MAX_IMAGE_BYTES = MAX_IMAGE_UPLOAD_BYTES;

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

  /**
   * Every reference image the client sent.
   *
   * The OpenAI shape is a repeatable `image` field (`image[]` on the wire from
   * some SDKs); a single upload is just the one-element case. Before 2026-11-13
   * this route read only the first file, so a client that sent four references
   * silently got an edit based on one — H3's `/v1/images/edits` accepts 1–16 and
   * had no way to receive them.
   */
  const uploads = [...form.getAll("image"), ...form.getAll("image[]")].filter(
    (value): value is File => value instanceof File && value.size > 0,
  );
  if (uploads.length === 0) {
    return proxyError(400, "invalid_request", "an 'image' file is required");
  }
  if (uploads.length > MAX_REFERENCE_IMAGES) {
    return proxyError(
      400,
      "invalid_request",
      `at most ${MAX_REFERENCE_IMAGES} reference images are accepted (got ${uploads.length})`,
    );
  }
  const oversized = uploads.find((file) => file.size > MAX_IMAGE_BYTES);
  if (oversized) {
    return proxyError(
      400,
      "invalid_request",
      `'image' exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit`,
    );
  }
  const images = await Promise.all(uploads.map((file) => fileToDataUrl(file)));

  const prompt = form.get("prompt");
  const size = form.get("size");
  const responseFormat = form.get("response_format");
  const n = Number(form.get("n"));
  const seed = Number(form.get("seed"));

  const input: MediaRequestInput = {
    model: requestedModel,
    prompt: typeof prompt === "string" ? prompt : "",
    // The first one is what every pre-existing spec maps; the array is the new
    // surface (see the protocol's scope table).
    image: images[0],
    images,
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
        ([key, value]) =>
          key !== "image" && key !== "image[]" && typeof value === "string",
      ),
    ),
  };

  const invalid = requirePrompt(input.prompt);
  if (invalid) {
    return proxyError(invalid.status, invalid.code, invalid.message);
  }

  return respondWithHeartbeat(
    (async () => {
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
    })(),
  );
}
