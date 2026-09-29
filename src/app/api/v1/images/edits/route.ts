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
import {
  executeMediaRequest,
  fileToDataUrl,
  imageItemsResponse,
  requirePrompt,
  type MediaRequestInput,
} from "@/lib/media/handler";
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
    return NextResponse.json(
      { ok: false, error: { code: "invalid_request", message: "expected multipart/form-data" } },
      { status: 400 },
    );
  }

  const model = form.get("model");
  const requestedModel = typeof model === "string" ? model : "";
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

  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_request", message: "an 'image' file is required" } },
      { status: 400 },
    );
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "invalid_request", message: "'image' exceeds the 10MB limit" },
      },
      { status: 400 },
    );
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
  };

  const invalid = requirePrompt(input.prompt);
  if (invalid) {
    return NextResponse.json(
      { ok: false, error: { code: invalid.code, message: invalid.message } },
      { status: invalid.status },
    );
  }

  const outcome = await executeMediaRequest({
    capability: "image.edit",
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
  return NextResponse.json(imageItemsResponse(outcome.value.result.items));
}
