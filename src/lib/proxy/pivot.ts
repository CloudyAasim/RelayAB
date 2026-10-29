/**
 * src/lib/proxy/pivot.ts
 *
 * Which dialect the row speaks.
 *
 * The one place that knows how to reach a given row: natively for a
 * Responses upstream, and by conversion for the other three. Every surface
 * that has to reach a row it picked itself goes through here, so "which
 * dialect is this row" is answered in one place.
 */

import { type ApiKey, type Provider, type User } from "../db/types";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "./types";
import { proxyResponsesViaChat } from "./dialects/chat";
import { proxyResponsesViaAnthropic } from "./dialects/anthropic";
import { proxyResponsesViaGemini } from "./dialects/gemini";
import { proxyResponsesNative } from "./dialects/responses";
import { dialectForSurface, type SurfaceId } from "../protocol/surface-routes";

/**
 * Call a provider in the dialect it speaks, with the request in the pivot shape.
 *
 * The one place that knows how to reach a given row: natively for a Responses
 * upstream, and by conversion for the other three. Every surface that has to
 * reach a row it picked itself goes through here, so "which dialect is this
 * row" is answered in one place.
 */
export async function proxyResponsesViaDialect(args: {
  req: ResponseAPIRequest;
  /** The row to call. Its dialect decides how. */
  provider: Provider;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /**
   * Which client surface this came in on.
   *
   * The row's route table is keyed by surface, so this is what says which
   * dialect the answer comes back in. Absent means the Responses surface, which
   * is what the hub used to assume.
   */
  surface?: SurfaceId;
}): Promise<ProxyResult> {
  const { req, provider, apiKey, user, signal, deps } = args;
  const surface = args.surface ?? "openai-responses";
  /**
   * The dialect this row answers this surface in.
   *
   * Read from the row's routes rather than from the face it happens to have:
   * a vendor that publishes both `/v1/chat/completions` and `/v1/responses`
   * can serve one natively and the other by translation, and a row that could
   * only say one thing could not say that.
   */
  const dialect = dialectForSurface(provider, surface) ?? "responses";
  if (dialect === "chat") {
    return proxyResponsesViaChat({ req, apiKey, user, signal, deps, provider });
  }
  if (dialect === "anthropic") {
    // The upstream speaks Anthropic Messages. The request is rewritten into
    // Anthropic's shape and the answer rewritten back — which is what lets a
    // Claude model answer a Responses client (and, through it, a Gemini one).
    return proxyResponsesViaAnthropic({ req, apiKey, user, signal, deps, provider });
  }
  if (dialect === "gemini") {
    // The upstream speaks Google's own Gemini API. Same idea, one dialect
    // further out: `contents` in, `candidates` out.
    return proxyResponsesViaGemini({ req, apiKey, user, signal, deps, provider });
  }
  return proxyResponsesNative({ req, apiKey, user, signal, deps, provider });
}
