/**
 * src/lib/proxy/gemini.ts
 *
 * The Gemini `generateContent` surface.
 *
 * ## What it is for
 *
 * A client that speaks Gemini — the Google SDKs, LangChain's
 * `ChatGoogleGenerativeAI`, Gemini CLI and the tools built on them — asks for
 * `POST /v1beta/models/{model}:generateContent` with a `contents` array. The
 * gateway answered OpenAI and Anthropic and nothing else, so those clients
 * could not use it at all.
 *
 * ## How it works
 *
 * The Gemini request is translated into the shape the gateway already speaks
 * internally, handed to the same proxy every other surface uses, and the
 * answer is translated back. The upstream is whatever the model is configured
 * on: an OpenAI-compatible vendor, an Anthropic one, or one speaking the
 * Responses API.
 *
 * ## The two key carriers
 *
 * A Gemini client does **not** send `Authorization: Bearer`. The Google SDKs
 * send `x-goog-api-key`, and the REST examples put the key in `?key=`. Both
 * are accepted here, alongside the usual ones — see `resolveAuthHeader`.
 */
import { proxyOpenAIResponse, type ProxyDeps, type ProxyResult } from "./openai";
import { sseRewrite } from "./stream-tap";
import {
  geminiToResponsesRequest,
  responsesToGeminiResponse,
  geminiTextChunk,
  geminiFinalChunk,
  type GeminiGenerateRequest,
  type GeminiUsageMetadata,
} from "../protocol/gemini";
import type { ApiKey, User } from "../db/types";

/** The two methods on this surface. */
export type GeminiMethod = "generateContent" | "streamGenerateContent";

/**
 * The model and the method, out of the path.
 *
 * `models/gemini-2.5-flash:generateContent` → `gemini-2.5-flash` +
 * `generateContent`.
 *
 * The colon is what separates them, and a model name never contains one —
 * but the method may be given as `streamGenerateContent?alt=sse`, so the query
 * is stripped before the split.
 */
export function parseGeminiPath(path: string): { model: string; method: GeminiMethod } | null {
  const withoutQuery = path.split("?")[0];
  const slash = withoutQuery.lastIndexOf("/");
  const tail = slash === -1 ? withoutQuery : withoutQuery.slice(slash + 1);
  const colon = tail.lastIndexOf(":");
  if (colon <= 0) return null;
  const model = tail.slice(0, colon).trim();
  const method = tail.slice(colon + 1).trim();
  if (!model) return null;
  if (method !== "generateContent" && method !== "streamGenerateContent") return null;
  return { model, method };
}

/** One SSE line carrying one Gemini chunk. */
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

interface StreamState {
  usage?: GeminiUsageMetadata;
  finishReason?: string;
}

/**
 * Rewrite an upstream SSE stream into Gemini's.
 *
 * Three dialects have to be recognised, because the upstream behind a model
 * may speak any of them: the Responses API's own frames, Chat Completions
 * chunks, and Anthropic's events. Each carries the text in a different place,
 * and only the Responses one names its deltas explicitly.
 */
function geminiStreamMapper(model: string): {
  map: (line: string) => string | null;
  onEnd: () => string;
} {
  const state: StreamState = {};

  const withUsage = (usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }): void => {
    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    state.usage = {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: usage.totalTokens ?? promptTokens + completionTokens,
    };
  };

  return {
    map(line: string): string | null {
      // Gemini's stream carries no event names: only `data:` lines.
      if (!line.startsWith("data:")) return null;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") return null;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }

      // The Responses API's own frames.
      if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        return sseLine(geminiTextChunk(parsed.delta, model));
      }
      if (parsed.type === "response.completed") {
        const response = parsed.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        if (usage) {
          withUsage({
            promptTokens: Number(usage.input_tokens ?? 0),
            completionTokens: Number(usage.output_tokens ?? 0),
            totalTokens: Number(usage.total_tokens ?? 0),
          });
        }
        return null;
      }

      // Chat Completions chunks.
      if (parsed.object === "chat.completion.chunk") {
        const choices = parsed.choices as
          | Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
          | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          return sseLine(geminiTextChunk(delta, model));
        }
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (usage) {
          withUsage({
            promptTokens: Number(usage.prompt_tokens ?? 0),
            completionTokens: Number(usage.completion_tokens ?? 0),
            totalTokens: Number(usage.total_tokens ?? 0),
          });
        }
        return null;
      }

      // Anthropic's events.
      if (parsed.type === "content_block_delta") {
        const delta = parsed.delta as { text?: unknown } | undefined;
        if (typeof delta?.text === "string" && delta.text.length > 0) {
          return sseLine(geminiTextChunk(delta.text, model));
        }
        return null;
      }
      if (parsed.type === "message_delta") {
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (usage) {
          withUsage({
            promptTokens: state.usage?.promptTokenCount ?? 0,
            completionTokens: Number(usage.output_tokens ?? 0),
            totalTokens:
              (state.usage?.promptTokenCount ?? 0) + Number(usage.output_tokens ?? 0),
          });
        }
        return null;
      }
      if (parsed.type === "message_start") {
        const message = parsed.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          withUsage({ promptTokens: Number(usage.input_tokens ?? 0) });
        }
        return null;
      }

      return null;
    },

    onEnd(): string {
      return sseLine(
        geminiFinalChunk({
          model,
          ...(state.usage ? { usage: state.usage } : {}),
          ...(state.finishReason ? { finishReason: state.finishReason } : {}),
        }),
      );
    },
  };
}

/**
 * Serve one Gemini request.
 *
 * The model comes from the URL and the body carries no model of its own —
 * which is Gemini's shape, and the reason the model has to be put back into
 * the request before it reaches the proxy.
 */
export async function proxyGeminiGenerate(args: {
  body: GeminiGenerateRequest;
  model: string;
  stream: boolean;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { body, model, stream, apiKey, user, signal, deps } = args;

  const pivot = geminiToResponsesRequest(body, model);
  if (stream) pivot.stream = true;

  const result = await proxyOpenAIResponse({
    req: pivot as Parameters<typeof proxyOpenAIResponse>[0]["req"],
    apiKey,
    user,
    signal,
    deps,
  });

  if (!result.ok) return result;

  // A stream: the upstream's frames have to become Gemini's.
  if (result.body) {
    const mapper = geminiStreamMapper(model);
    const rewritten = sseRewrite(result.body, {
      map: mapper.map,
      onEnd: mapper.onEnd,
    });
    return {
      ok: true,
      status: 200,
      body: rewritten,
      contentType: "text/event-stream; charset=utf-8",
    };
  }

  // A buffered answer: the pivot's shape becomes Gemini's.
  const gemini = responsesToGeminiResponse(result.data, model);

  if (!stream) {
    return { ok: true, status: 200, data: gemini };
  }

  // The client asked for a stream and the upstream answered with one whole
  // body — which is what happens against a Chat Completions upstream, because
  // that path cannot stream in the shape the pivot speaks.
  //
  // The answer is still delivered as a stream, in Gemini's own framing: one
  // frame with the text and the usage, then the closing frame. It is not
  // incremental, and it is said so rather than left for a client to discover.
  const text = (gemini.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  const frames = [
    sseLine({
      ...geminiTextChunk(text, model),
      ...(gemini.usageMetadata ? { usageMetadata: gemini.usageMetadata } : {}),
    }),
    sseLine(
      geminiFinalChunk({
        model,
        ...(gemini.usageMetadata ? { usage: gemini.usageMetadata } : {}),
      }),
    ),
  ].join("\n\n");

  return {
    ok: true,
    status: 200,
    body: new Response(`${frames}\n\n`).body!,
    contentType: "text/event-stream; charset=utf-8",
  };
}
