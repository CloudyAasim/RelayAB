/**
 * src/lib/proxy/responses.ts
 *
 * The OpenAI Responses **client** surface.
 *
 * The request is checked and a row is picked; the pivot then reaches that
 * row in whichever dialect it speaks.
 */

import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { findOpenAIProvidersForModel } from "../db/providers";
import type { ApiKey, User } from "../db/types";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "./types";
import { proxyResponsesViaDialect } from "./pivot";

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

/**
 * Forward an OpenAI Responses API request.
 * Maps to upstream /v1/responses endpoint.
 */
export async function proxyOpenAIResponse(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;

  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // 1. Validate key
  const status = checkKeyStatus({
    key: apiKey,
    user,
    requestedModel: req.model,
  });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(user);
  if (preFlight) {
    const http = reasonToHttp(preFlight.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }

  // 2. Pick the provider and honour the protocol it was configured with.
  //
  // One protocol, no automatic switching: if a vendor was declared as speaking
  // Chat Completions, the request goes out as Chat Completions and a failure is
  // reported as a failure. Silently retrying over a different protocol hides
  // real breakage (and paid for a doomed round trip on every request).
  const providers = await findOpenAIProvidersForModel(req.model);
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];
  return proxyResponsesViaDialect({ req, provider, apiKey, user, signal, deps });
}
