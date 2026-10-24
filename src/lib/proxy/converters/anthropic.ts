/**
 * src/lib/proxy/converters/anthropic.ts
 *
 * Responses <-> Anthropic Messages.
 *
 * The request becomes Anthropic's own shape and the answer comes back in
 * it, which is what lets a Claude model answer a Responses client.
 */

import type { ResponseAPIRequest } from "../types";
import { imageUrlOf } from "./chat";

/**
 * Convert a Responses API request to the Anthropic Messages format.
 * Used when the selected provider only speaks the Anthropic protocol.
 */
export function responsesToAnthropicRequest(req: ResponseAPIRequest): Record<string, unknown> {
  const messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];

  const fromInput = (input: unknown): void => {
    if (typeof input === "string") {
      messages.push({ role: "user", content: input });
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) fromInput(item);
      return;
    }
    if (input && typeof input === "object") {
      const item = input as Record<string, unknown>;
      const role = String(item.role ?? "user").toLowerCase() === "assistant" ? "assistant" : "user";
      const content = item.content;
      if (typeof content === "string") {
        messages.push({ role, content });
      } else if (Array.isArray(content)) {
        /**
         * The blocks, not just their text.
         *
         * Anthropic takes images the same way the pivot does — as blocks — so
         * a picture survives the trip. Dropping it would leave the model
         * answering a question it never saw the picture for, which is worse
         * than an error: it looks like a right answer.
         */
        const blocks: unknown[] = [];
        for (const block of content) {
          if (typeof block === "string") {
            if (block) blocks.push({ type: "text", text: block });
            continue;
          }
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const type = typeof b.type === "string" ? b.type : "";

          if (type === "input_text" || type === "output_text" || type === "text") {
            const text = typeof b.text === "string" ? b.text : "";
            if (text) blocks.push({ type: "text", text });
            continue;
          }
          if (type === "input_image" || type === "image_url") {
            const source = anthropicImageSource(b);
            if (source) blocks.push({ type: "image", source });
          }
        }
        if (blocks.length > 0) {
          // A message of nothing but text keeps the plain string form, which is
          // what Anthropic's own clients send.
          const onlyText = blocks.every(
            (block) => (block as { type?: string }).type === "text",
          );
          if (onlyText) {
            messages.push({
              role,
              content: blocks.map((block) => String((block as { text?: string }).text ?? "")).join("\n"),
            });
          } else {
            messages.push({ role, content: blocks });
          }
        }
      }
    }
  };

  fromInput(req.input);
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const maxTokens =
    typeof req.max_output_tokens === "number" ? req.max_output_tokens : 1024;
  const system = typeof req.instructions === "string" ? req.instructions : undefined;

  return {
    model: req.model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === "number" ? { top_p: req.top_p } : {}),
    // The stream flag travels: the upstream's frames are translated rather
    // than arriving as one whole answer at the end.
    stream: req.stream === true,
  };
}

/**
 * An image block in Anthropic's own spelling.
 *
 * Anthropic takes a picture either as bytes (`base64`) or as an address
 * (`url`), and the pivot carries a data URL — which is the bytes, written
 * out. So the two cases are told apart by the shape of the address, not by a
 * flag nobody set.
 */
function anthropicImageSource(block: Record<string, unknown>): unknown {
  const url = imageUrlOf(block);
  if (!url) return null;

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (match) {
    return { type: "base64", media_type: match[1], data: match[2] };
  }
  return { type: "url", url };
}

export interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  [k: string]: unknown;
}

/**
 * Convert an Anthropic Messages response into an OpenAI Responses object.
 */
export function anthropicToResponsesResponse(
  body: AnthropicMessageResponse,
  originalReq: ResponseAPIRequest,
): Record<string, unknown> {
  const id = body.id ?? `resp_${Date.now()}`;
  const text = (body.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
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
