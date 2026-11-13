/**
 * app/api/v1/media/jobs/route.ts
 *
 * `POST /v1/media/jobs` — submit a generation and stop waiting.
 *
 * Body: the same fields the synchronous media routes take, plus `capability`:
 *
 *   { "capability": "image.generate", "model": "image-01", "prompt": "…",
 *     "size": "1024x1024", "images": ["data:image/png;base64,…"] }
 *
 * Answers `202` with the job, and the client polls `/v1/media/jobs/<id>`. No
 * heartbeat, no idle-proxy problem, no "status already committed to 200" — the
 * trade-off the synchronous routes cannot avoid.
 */
import { NextResponse } from "next/server";
import { authorizeMediaRequest, requirePrompt, type MediaRequestInput } from "@/lib/media/handler";
import {
  MEDIA_JOB_CAPABILITIES,
  isMediaJobCapability,
  mediaJobView,
  submitMediaJob,
} from "@/lib/media/jobs";
import { proxyError } from "@/lib/proxy/errors";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  const capability = typeof body.capability === "string" ? body.capability : "";
  if (!isMediaJobCapability(capability)) {
    return proxyError(
      400,
      "unsupported_capability",
      `capability must be one of: ${MEDIA_JOB_CAPABILITIES.join(", ")}`,
    );
  }

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const auth = await authorizeMediaRequest(req, requestedModel);
  if (!auth.ok) return auth.response;

  const input: MediaRequestInput = {
    model: requestedModel,
    ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
    ...(typeof body.input === "string" ? { input: body.input } : {}),
    ...(typeof body.n === "number" ? { n: body.n } : {}),
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.response_format === "string" ? { responseFormat: body.response_format } : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof body.style === "string" ? { style: body.style } : {}),
    ...(typeof body.watermark === "boolean" ? { watermark: body.watermark } : {}),
    ...(typeof body.prompt_optimizer === "boolean" ? { promptOptimizer: body.prompt_optimizer } : {}),
    /**
     * Reference images for `image.edit`.
     *
     * A job is JSON, not multipart: the caller sends the pictures as data URLs
     * (or public URLs) in `images`, which is exactly what the spec scope reads.
     * `image` is accepted too, for the one-reference shape the synchronous route
     * also supports.
     */
    ...(typeof body.image === "string" ? { image: body.image } : {}),
    ...(Array.isArray(body.images)
      ? { images: body.images.filter((value): value is string => typeof value === "string") }
      : {}),
    extra: body,
  };

  // The same prompt rule the synchronous routes apply, checked before the job is
  // accepted: a job that cannot possibly run should not cost a poll round-trip.
  if (capability !== "image.edit" || typeof input.prompt === "string") {
    const invalid = requirePrompt(input.prompt);
    if (invalid) return proxyError(invalid.status, invalid.code, invalid.message);
  }
  if (capability === "image.edit" && !input.image && !(input.images && input.images.length > 0)) {
    return proxyError(400, "invalid_request", "an 'image' or 'images' reference is required");
  }

  const outcome = await submitMediaJob({
    capability,
    user: auth.user,
    apiKey: auth.key,
    request: { ...input } as Record<string, unknown>,
  });
  if (!outcome.ok) {
    return proxyError(outcome.error.status, outcome.error.code, outcome.error.message);
  }

  return NextResponse.json(mediaJobView(outcome.job), {
    status: 202,
    headers: {
      Location: `/v1/media/jobs/${outcome.job.id}`,
      "Cache-Control": "no-store",
    },
  });
}
