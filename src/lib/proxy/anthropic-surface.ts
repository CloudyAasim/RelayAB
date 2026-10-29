/**
 * src/lib/proxy/anthropic-surface.ts
 *
 * The Anthropic **client** surface.
 *
 * ## The two ways this surface is served
 *
 * A provider's Anthropic face has two modes, and they are different things
 * rather than two spellings of one:
 *
 *  - **native** — the vendor publishes its own `/v1/messages`, and the request
 *    goes out in Anthropic's shape. This is what the face has always meant.
 *  - **translated** — the vendor speaks no Anthropic at all, and the gateway
 *    rewrites the request into the protocol it does speak.
 *
 * The choice is the operator's because the gateway cannot know it: guessing
 * would either 404 on a vendor that has no Anthropic endpoint, or bypass the
 * endpoint of one that has.
 *
 * ## The pivot
 *
 * The Responses API, as everywhere else in this gateway: the Anthropic request
 * becomes a Responses request, the vendor is called in whatever dialect it
 * speaks, and the answer is translated back into an Anthropic message.
 */
import { providerFaces, type ApiKey, type Provider, type User } from "@/lib/db/types";
import { routesOf } from "@/lib/protocol/surface-routes";
import { findAnthropicProvidersForModel } from "@/lib/db/providers";
import { checkKeyStatus, reasonToHttp } from "@/lib/auth/apikey";
import { shouldRejectBeforeRequest } from "@/lib/quota/calculator";
import { proxyAnthropicMessage, type AnthropicRequest } from "./anthropic";
import { proxyResponsesViaDialect } from "./pivot";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "./types";
import {
  anthropicToResponsesRequest,
  responsesToAnthropicResponse,
} from "../protocol/anthropic";
import { readStreamFacts } from "../protocol/stream-frames";

export async function proxyAnthropicSurface(args: {
  req: AnthropicRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const model = typeof req.model === "string" ? req.model : "";
  if (!model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // The row this surface picks: the ones that answer this surface.
  const candidates = await findAnthropicProvidersForModel(model);
  const provider: Provider | undefined = candidates[0];
  const face = provider ? providerFaces(provider).anthropic : null;
  if (!provider || !face) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "model_not_mapped",
        message: `No Anthropic provider configured for model '${model}'`,
      },
    };
  }

  /**
   * How this surface is answered, as the row's route says.
   *
   * `passthrough` is the vendor's own `/v1/messages` — the path that has
   * always worked, and it is left exactly as it was. A route to another
   * dialect means the request is rewritten on the way out.
   */
  const route = routesOf(provider)["anthropic-messages"];
  if (route.kind === "unsupported") {
    return {
      ok: false,
      status: 400,
      error: {
        code: "model_not_mapped",
        message: `No Anthropic provider configured for model '${model}'`,
      },
    };
  }
  if (route.kind === "passthrough") {
    // The vendor serves Anthropic itself: the request goes out as it is. This
    // is the path that has always worked, and it is left exactly as it was.
    return proxyAnthropicMessage({ req, apiKey, user, signal, deps, provider });
  }

  // The vendor speaks no Anthropic. The checks the native path does for itself
  // are done here, because this path does not go through it.
  const status = checkKeyStatus({ key: apiKey, user, requestedModel: model });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(user);
  if (preFlight) {
    const http = reasonToHttp(preFlight.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }

  // The Anthropic request becomes the pivot, the pivot becomes the vendor's
  // dialect, and the answer comes back the same way.
  const pivot = anthropicToResponsesRequest(req as unknown as Record<string, unknown>);
  const viaPivot = await proxyResponsesViaDialect({
    req: pivot as unknown as ResponseAPIRequest,
    provider,
    apiKey,
    user,
    signal,
    deps,
    surface: "anthropic-messages",
  });
  if (!viaPivot.ok) return viaPivot;

  if (viaPivot.body) {
    // A streamed answer: the pivot's frames are read to the end and the answer
    // is handed over whole. The client does get a stream — the route replays
    // the message as Anthropic's events — but not an incremental one. Turning
    // the pivot's frames into Anthropic's events as they arrive is what this
    // mode still owes.
    const answer = await readPivotStream(viaPivot.body);
    return { ok: true, status: 200, data: responsesToAnthropicResponse(answer, req) };
  }

  return {
    ok: true,
    status: 200,
    data: responsesToAnthropicResponse(viaPivot.data, req),
  };
}

/**
 * Read the pivot's frames to the end and assemble the answer they carried.
 *
 * The frames are the pivot's own — `response.output_text.delta` and
 * `response.completed` — so the reader is the same one the rest of the
 * gateway uses to read a stream of any dialect.
 */
async function readPivotStream(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let id: string | undefined;
  let model: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const facts = readStreamFacts(JSON.parse(payload));
        if (facts.text) text += facts.text;
        if (facts.inputTokens !== undefined) inputTokens = facts.inputTokens;
        if (facts.outputTokens !== undefined) outputTokens = facts.outputTokens;
        if (facts.id) id = facts.id;
        if (facts.model) model = facts.model;
      } catch {
        // A partial or non-JSON frame: nothing to add.
      }
    }
  }

  return {
    id,
    model,
    output: text
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ]
      : [],
    output_text: text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
