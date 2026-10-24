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

import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "./types";
import { proxyResponsesViaChat } from "./dialects/chat";
import { proxyResponsesViaAnthropic } from "./dialects/anthropic";
import { proxyResponsesViaGemini } from "./dialects/gemini";
import { proxyResponsesNative } from "./dialects/responses";

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
}): Promise<ProxyResult> {
  const { req, provider, apiKey, user, signal, deps } = args;
  const format = providerFaces(provider).openai?.format;
  if (format === "chat") {
    return proxyResponsesViaChat({ req, apiKey, user, signal, deps, provider });
  }
  if (format === "anthropic") {
    // The upstream speaks Anthropic Messages. The request is rewritten into
    // Anthropic's shape and the answer rewritten back — which is what lets a
    // Claude model answer a Responses client (and, through it, a Gemini one).
    return proxyResponsesViaAnthropic({ req, apiKey, user, signal, deps, provider });
  }
  if (format === "gemini") {
    // The upstream speaks Google's own Gemini API. Same idea, one dialect
    // further out: `contents` in, `candidates` out.
    return proxyResponsesViaGemini({ req, apiKey, user, signal, deps, provider });
  }
  return proxyResponsesNative({ req, apiKey, user, signal, deps, provider });
}
