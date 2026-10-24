/**
 * src/lib/proxy/dialects/anthropic.ts
 *
 * The upstream dialect: Anthropic Messages.
 *
 * A row that speaks Anthropic is called in Anthropic's own shape; the
 * request is rewritten into it and the answer rewritten back.
 */

import { proxyAnthropicMessage } from "../anthropic";
import { sseRewrite } from "../stream-tap";
import type { ApiKey, Provider, User } from "../../db/types";
import { pivotFrameMapper } from "../../protocol/stream-frames";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "../types";
import {
  anthropicToResponsesResponse,
  responsesToAnthropicRequest,
  type AnthropicMessageResponse,
} from "../converters/anthropic";
import { asRecord } from "../converters/chat";

/**
 * Serve a Responses API request from a provider that only speaks the
 * Anthropic Messages protocol, by converting the request and the response.
 */
export async function proxyResponsesViaAnthropic(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /** The row to call, when the caller has already picked one. */
  provider?: Provider;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps, provider } = args;

  /**
   * Anthropic Messages has no JSON-schema response mode, so the instruction
   * becomes the thing Anthropic does have: **a tool with a schema, forced**.
   * The answer comes back as that tool's arguments — which is the JSON the
   * client asked for.
   *
   * The alternative — dropping the instruction — gives a client that asked for
   * JSON a 200 and some prose, and its JSON.parse fails three lines later
   * with nothing pointing at the cause.
   */
  const jsonFormat = responsesJsonFormat(req.text);

  if (jsonFormat && req.stream === true) {
    // A streamed tool call arrives as a run of partial JSON, and the pivot
    // would have to assemble it frame by frame. Until that exists, the honest
    // answer is to say so rather than to stream prose.
    return {
      ok: false,
      status: 400,
      error: {
        code: "invalid_request_error",
        message:
          "A structured-output request against an Anthropic upstream is not supported while streaming. Ask for the same request without \"stream\": true.",
      },
    };
  }

  const anthropicReq = responsesToAnthropicRequest(req);
  let toolName: string | null = null;
  if (jsonFormat) {
    toolName = anthropicToolName(jsonFormat.name);
    anthropicReq.tools = [
      {
        name: toolName,
        description:
          "Answer with a JSON object matching the schema. This tool is the only way to answer.",
        input_schema: (jsonFormat.schema as unknown) ?? { type: "object" },
      },
    ];
    anthropicReq.tool_choice = { type: "tool", name: toolName };
  }

  const result = await proxyAnthropicMessage({
    req: anthropicReq as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey,
    user,
    signal,
    deps,
    ...(provider ? { provider } : {}),
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  // The upstream answered in Anthropic's events; the pivot speaks Responses'.
  if (result.body) {
    const mapper = pivotFrameMapper(req.model);
    return {
      ok: true,
      status: 200,
      body: sseRewrite(result.body, {
        map: mapper.map,
        onEnd: mapper.onEnd,
        signal,
      }),
      contentType: "text/event-stream; charset=utf-8",
    };
  }

  const body = result.data as AnthropicMessageResponse;
  if (jsonFormat && toolName) {
    return { ok: true, status: 200, data: structuredAnswer(body, toolName, req) };
  }
  return {
    ok: true,
    status: 200,
    data: anthropicToResponsesResponse(body, req),
  };
}

/**
 * The structured-output instruction in the pivot's shape, if there is one.
 */
function responsesJsonFormat(
  text: unknown,
): { type: string; name?: string; schema?: unknown } | null {
  const format = asRecord(asRecord(text)?.format);
  if (!format) return null;
  const type = typeof format.type === "string" ? format.type : "";
  if (type !== "json_schema" && type !== "json_object") return null;
  return {
    type,
    ...(typeof format.name === "string" ? { name: format.name } : {}),
    ...(format.schema !== undefined ? { schema: format.schema } : {}),
  };
}

/**
 * A tool name Anthropic will accept.
 *
 * Anthropic's names are letters, digits, underscores and dashes; a JSON schema
 * named `my.answer` would be refused, so the punctuation goes.
 */
function anthropicToolName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "response";
}

/**
 * The pivot's answer when the JSON came back as a tool's arguments.
 *
 * The client asked for the JSON itself, so the tool call is unwrapped into
 * the message the client is going to read — the tool was the mechanism, not
 * the answer.
 */
function structuredAnswer(
  body: AnthropicMessageResponse,
  toolName: string,
  originalReq: ResponseAPIRequest,
): Record<string, unknown> {
  const call = (body.content ?? []).find(
    (block) => block?.type === "tool_use" && (block as { name?: string }).name === toolName,
  );
  const input = call ? (call as { input?: unknown }).input : undefined;
  const text = input === undefined ? "" : JSON.stringify(input);
  const id = body.id ?? `resp_${Date.now()}`;
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? originalReq.model,
    output: text
      ? [
          {
            id: `${id}_msg`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ]
      : [],
    output_text: text,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
