/**
 * app/api/v1/raw/[provider]/[...path]/route.ts
 *
 * `ANY /v1/raw/<providerId>/<vendor path>` — vendor-verbatim passthrough.
 *
 * The text surfaces have had this shape for a while. Media did not, because the
 * client usually speaks OpenAI's image/video API while the vendor speaks its
 * own; this route is for the client that speaks the vendor's own — a native SDK,
 * an async submit/poll API, an endpoint the spec language has no reason to
 * model.
 *
 * Method, path, query, body and the response all pass through untouched. The
 * provider's credentials are injected, the relay key is required, and a submit
 * (any non-GET method) with a 2xx is billed once at the model's per-item price.
 * A poll is not billed: the response is not parsed, so there is nothing to count.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { getUserById as lookupUserById } from "@/lib/db/users";
import { getMediaProviderById } from "@/lib/db/media-providers";
import { proxyError } from "@/lib/proxy/errors";
import { shouldRejectBeforeRequest } from "@/lib/quota/calculator";
import { computeMediaCredits, settleMediaUsage } from "@/lib/media/billing";
import {
  isRawPathAllowed,
  rawRequestHeaders,
  rawResponseHeaders,
  resolveRawTarget,
  specForRawCall,
} from "@/lib/media/passthrough";
import type { ApiKey, User } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  req: Request,
  params: Promise<{ provider: string; path: string[] }>,
): Promise<Response> {
  const { provider: providerId, path } = await params;

  const provider = await getMediaProviderById(providerId);
  if (!provider || !provider.enabled) {
    return proxyError(404, "provider_not_found", `No enabled media provider '${providerId}'`);
  }

  const requestedModel = new URL(req.url).searchParams.get("model") ?? "";
  if (!requestedModel) {
    return proxyError(400, "model_required", "add ?model=<model> so the call can be billed and scoped");
  }
  const declared = provider.models[requestedModel];
  if (!declared || !declared.enabled) {
    return proxyError(404, "model_not_found", `model '${requestedModel}' is not enabled on this provider`);
  }

  // Which modes this route serves. A spec provider has not promised that an
  // arbitrary vendor path is safe to forward, so it is refused here — that is the
  // whole difference between `advanced`/`simple` and the passthrough modes.
  if (provider.mode !== "passthrough" && provider.mode !== "restricted") {
    return proxyError(
      400,
      "passthrough_disabled",
      `provider '${provider.name}' is in ${provider.mode} mode; use the spec routes (/v1/images/*, /v1/videos/*, /v1/media/jobs)`,
    );
  }

  const spec = specForRawCall(provider, requestedModel);

  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    requestedModel,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }
  const user = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!user) {
    return proxyError(403, "user_not_found", "The account owning this key no longer exists");
  }
  const rejection = shouldRejectBeforeRequest(user);
  if (rejection) return proxyError(403, rejection.reason, "account credit pool is exhausted");

  const url = new URL(req.url);
  /**
   * Everything after `/v1/raw/<providerId>`.
   *
   * Taken from the raw URL when possible so a vendor path keeps its exact
   * spelling (Gemini's `:generateContent`, dots). Behind the `/v1/*` rewrite the
   * request may still carry the public path, and a direct call carries
   * `/api/...` — both are recognised. The params fallback joins the already
   * decoded segments without re-encoding, because encoding them again would send
   * `%3A` where the vendor expects `:`.
   */
  const prefixes = [`/api/v1/raw/${providerId}`, `/v1/raw/${providerId}`];
  const prefix = prefixes.find((candidate) => url.pathname.startsWith(candidate));
  const suffix = prefix
    ? url.pathname.slice(prefix.length)
    : `/${path.join("/")}`;

  let target;
  try {
    target = resolveRawTarget({ provider, spec, suffix, search: url.searchParams });
  } catch (err) {
    return proxyError(400, "invalid_path", err instanceof Error ? err.message : "invalid raw path");
  }

  if (!isRawPathAllowed(provider, suffix)) {
    return proxyError(
      403,
      "path_not_allowed",
      `provider '${provider.name}' only allows: ${provider.passthroughPaths.join(", ")}`,
    );
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = rawRequestHeaders({ provider, spec, incoming: req.headers, target });

  let upstream: Response;
  try {
    upstream = await fetch(target.url.toString(), {
      method,
      headers,
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
      signal: req.signal,
      // The vendor's own redirects are the client's business, not a proxy's.
      redirect: "manual",
    });
  } catch (err) {
    return proxyError(502, "upstream_unreachable", err instanceof Error ? err.message : "upstream request failed");
  }

  // Vendors often answer 2xx to a submit and 4xx to a bad poll; charging only the
  // submit keeps a polling client from paying per poll. A failed submit costs
  // nothing, which matches what the synchronous route does.
  if (hasBody && upstream.status >= 200 && upstream.status < 300) {
    await settleMediaUsage({
      apiKey: auth.key as ApiKey,
      user: user as User,
      providerId: provider.id,
      model: requestedModel,
      upstreamModel: declared.upstreamId,
      capability: spec?.capability ?? "image.generate",
      images: 1,
      creditsUsed: computeMediaCredits(declared.pricePerItem, 1),
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: rawResponseHeaders(upstream.headers),
  });
}

export const GET = (req: Request, ctx: { params: Promise<{ provider: string; path: string[] }> }) =>
  handle(req, ctx.params);
export const POST = (req: Request, ctx: { params: Promise<{ provider: string; path: string[] }> }) =>
  handle(req, ctx.params);
export const PUT = (req: Request, ctx: { params: Promise<{ provider: string; path: string[] }> }) =>
  handle(req, ctx.params);
export const PATCH = (req: Request, ctx: { params: Promise<{ provider: string; path: string[] }> }) =>
  handle(req, ctx.params);
export const DELETE = (req: Request, ctx: { params: Promise<{ provider: string; path: string[] }> }) =>
  handle(req, ctx.params);
