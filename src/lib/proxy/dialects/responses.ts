/**
 * src/lib/proxy/dialects/responses.ts
 *
 * The upstream dialect: native Responses.
 *
 * A row that speaks Responses is called in Responses' own shape — the body
 * goes out untouched and the answer comes back untouched.
 */

import { decryptSecret } from "../../crypto/secrets";
import { estimateTokensFromText } from "../../quota/calculator";
import { extractCacheBuckets } from "../../quota/rates";
import { settleUsage } from "../billing";
import { ssePassthrough } from "../stream-tap";
import type { ApiKey, Provider, User } from "../../db/types";
import { applyParameterPolicy } from "../../protocol/parameter-policy";
import { activeSpecFor } from "../../protocol/text-specs";
import { upstreamRefusal } from "../errors";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest, StreamUsage } from "../types";
import { isEventStream, recordFailure, usageFromSsePayload } from "./shared";

interface ResponseAPIResponse {
  id: string;
  object: string;
  model: string;
  output: unknown[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  [k: string]: unknown;
}

/**
 * Forward a Responses API request verbatim to a native `/responses` upstream.
 */
export async function proxyResponsesNative(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  provider: Provider;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps, provider } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const upstreamModel = provider.modelMapping[req.model];

  // Build upstream URL - Responses API uses /responses
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultResponsesUrl(provider);


  // 4. Decrypt upstream key
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Strip OpenAI-only fields the upstream may reject (e.g. stream_options).
  const forwardable: Record<string, unknown> = { ...req };
  delete forwardable.stream_options;

  // The Responses surface's policy, chosen the same way the OpenAI one is: the
  // entry that governs the surface the client actually called.
  const { body: policed } = applyParameterPolicy(
    forwardable,
    activeSpecFor(provider, "openai-responses") ?? undefined,
  );

  // 5. Forward request
  // Flatten the request's input into text once: it feeds the credit
  // calculation and the estimation fallback for a stream that never reports
  // usage.
  let inputText = "";
  if (typeof req.input === "string") {
    inputText = req.input;
  } else if (Array.isArray(req.input)) {
    inputText = req.input
      .filter((i) => i.type === "input_text" && i.content)
      .map((i) => i.content)
      .join(" ");
  }

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify({ ...policed, model: upstreamModel }),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: String(err) },
    };
  }

  if (!response.ok) {
    const text = await response.text();
    const detail = `${upstreamUrl} -> HTTP ${response.status}: ${text.slice(0, 500)}`;
    console.error(`[relayab] responses upstream failure: ${detail}`);
    await recordFailure({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: detail,
    });
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_error",
        message: upstreamRefusal(response.status, detail),
      },
    };
  }

  // 6. Streaming clients (Codex CLI, OpenAI SDK with stream:true) expect an
  //    SSE body. Pipe the upstream bytes straight through instead of trying to
  //    parse them as JSON, and settle usage once the stream has finished.
  if (req.stream === true && isEventStream(response)) {
    return streamResponsesAnswer({
      upstream: response,
      apiKey,
      provider,
      user,
      model: req.model,
      upstreamModel,
      inputText,
      signal,
    });
  }

  // 7. Parse + extract usage.
  const body = (await response.json()) as ResponseAPIResponse;
  const usage = body.usage ?? {};
  const promptTokens = (usage as any).prompt_tokens ?? (usage as any).input_tokens ?? 0;
  const completionTokens =
    (usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0;
  const totalTokens = (usage as any).total_tokens ?? (promptTokens + completionTokens);

  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
    cache: extractCacheBuckets(usage),
    });

  return { ok: true, status: 200, data: body };
}

function streamResponsesAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  /** Best-effort input text, used to estimate tokens if no usage frame arrives. */
  inputText: string;
  /** Client request signal; firing it settles the usage row. */
  signal?: AbortSignal;
}): ProxyResult {
  const { upstream, apiKey, provider, user, model, upstreamModel, inputText, signal } = args;
  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: "Upstream returned an empty stream" },
    };
  }

  let usage: StreamUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cache: { read: 0, write: 0, reported: false },
  };
  let sawUsage = false;
  let outputText = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const found = usageFromSsePayload(parsed);
      if (found) {
        usage = found;
        sawUsage = true;
      }
      // Harvest streamed output text so the estimate fallback has something
      // to measure when the upstream omits the usage frame.
      const record = parsed as { type?: string; delta?: unknown };
      if (record?.type === "response.output_text.delta" && typeof record.delta === "string") {
        outputText += record.delta;
      }
    } catch {
      // Partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const body = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    settle: async () => {
      // No usage frame means the client disconnected or maxDuration cut the
      // stream short. Bill by estimate from the text we did see, and mark the
      // row so the estimate is auditable.
      const billingMode: "usage" | "estimated" = sawUsage ? "usage" : "estimated";
      if (!sawUsage) {
        console.warn(
          `[relayab] responses stream for model=${model} ended without a usage frame; estimating tokens`,
        );
      }
      await settleUsage({
        apiKey,
        provider,
        user,
        model,
        upstreamModel,
        promptTokens: sawUsage ? usage.promptTokens : estimateTokensFromText(inputText),
        completionTokens: sawUsage ? usage.completionTokens : estimateTokensFromText(outputText),
        // Only when the upstream really reported it: an estimated turn has no cache
        // to report, and claiming 0 would turn a guess into a recorded fact.
        cache: sawUsage ? usage.cache : { read: 0, write: 0, reported: false },
        billingMode,
        });
    },
  });

  return {
    ok: true,
    status: 200,
    body,
    contentType: upstream.headers.get("content-type") ?? "text/event-stream",
  };
}

/**
 * The prompt's text, for the estimate fallback.
 *
 * The pivot's input comes in two shapes — a plain string, and a list of items
 * whose content is either a string or a list of typed blocks — and the estimate
 * needs all of them.
 */
export function pivotInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.text === "string") {
      parts.push(entry.text);
      continue;
    }
    const content = entry.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (
        block &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.join(" ");
}

function defaultResponsesUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // This proxy always forwards a Responses API body, so the target must be the
  // upstream Responses endpoint regardless of `upstreamFormat`.
  return `${cleanBase}/responses`;
}
