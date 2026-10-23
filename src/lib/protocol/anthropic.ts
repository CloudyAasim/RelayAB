/**
 * src/lib/protocol/anthropic.ts
 *
 * The Anthropic Messages shapes, and the conversion between them and the
 * Responses shape the gateway speaks internally.
 *
 * ## Why this exists
 *
 * The Anthropic **client** surface used to work only against an Anthropic
 * **upstream**: the request body went out as it was, to
 * `<base>/v1/messages`. A vendor that publishes only an OpenAI-compatible API
 * has no such endpoint, so an Anthropic client (Claude Code, ONLYOFFICE's
 * Anthropic provider, the Anthropic SDK) got a 404 from the vendor — while the
 * same vendor answered the OpenAI and Responses surfaces perfectly well.
 *
 * ## The pivot
 *
 * The Responses API, as everywhere else in this gateway. The Anthropic request
 * becomes a Responses request, the vendor is called in whatever dialect it
 * speaks, and the answer is translated back.
 *
 * ## What is lost, and where it goes
 *
 * Two things do not survive the trip, and both are stated rather than dropped
 * quietly:
 *
 *  - **`top_k`** has no counterpart in the pivot. It is a sampling knob, and
 *    the pivot speaks in `temperature` / `top_p`.
 *  - **A URL image** survives (`source.type === "url"` ✓), and a base64 one
 *    survives ✓; what does not survive is an image the vendor cannot fetch.
 */
export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  [k: string]: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translate an Anthropic Messages request into the pivot.
 */
export function anthropicToResponsesRequest(req: Record<string, unknown>): Record<string, unknown> {
  const input: unknown[] = [];

  for (const message of Array.isArray(req.messages) ? req.messages : []) {
    if (!isPlainObject(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      if (content) {
        input.push({
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }],
        });
      }
      continue;
    }

    for (const block of Array.isArray(content) ? content : []) {
      if (!isPlainObject(block)) continue;
      const type = typeof block.type === "string" ? block.type : "";

      if (type === "text" && typeof block.text === "string") {
        input.push({
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text: block.text }],
        });
        continue;
      }

      if (type === "thinking" && typeof block.thinking === "string") {
        input.push({
          type: "reasoning",
          summary: [{ type: "summary_text", text: block.thinking }],
        });
        continue;
      }

      if (type === "image") {
        const url = anthropicImageUrl(block);
        if (url) {
          input.push({
            role,
            content: [{ type: "input_image", image_url: url }],
          });
        }
        continue;
      }

      if (type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        });
        continue;
      }

      if (type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id ?? ""),
          output:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
        });
      }
    }
  }

  const out: Record<string, unknown> = { model: req.model, input };

  // The system prompt is its own field in Anthropic, and the pivot's
  // `instructions` is the same idea.
  if (typeof req.system === "string" && req.system) {
    out.instructions = req.system;
  } else if (Array.isArray(req.system)) {
    const text = req.system
      .map((block) => (isPlainObject(block) && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) out.instructions = text;
  }

  if (typeof req.max_tokens === "number") out.max_output_tokens = req.max_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (typeof req.stop_sequences === "string") out.stop = req.stop_sequences;
  else if (Array.isArray(req.stop_sequences)) out.stop = req.stop_sequences;

  // Tools: Anthropic names the schema `input_schema`, the pivot `parameters`.
  const tools: unknown[] = [];
  for (const tool of Array.isArray(req.tools) ? req.tools : []) {
    if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
    tools.push({
      type: "function",
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
    });
  }
  if (tools.length > 0) out.tools = tools;

  const choice = isPlainObject(req.tool_choice) ? req.tool_choice : undefined;
  if (choice) {
    if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool") out.tool_choice = "required";
    else if (choice.type === "auto") out.tool_choice = "auto";
  }

  return out;
}

/**
 * An Anthropic image block as an address the pivot understands.
 *
 * The pivot carries images as a data URL, so base64 bytes are written back
 * out and a URL is passed through as it is.
 */
function anthropicImageUrl(block: Record<string, unknown>): string {
  const source = isPlainObject(block.source) ? block.source : {};
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return `data:${media};base64,${source.data}`;
  }
  if (source.type === "url" && typeof source.url === "string") return source.url;
  return "";
}

/**
 * Translate the pivot's answer into an Anthropic message.
 *
 * The stop reason is a translation in the other direction too: the pivot says
 * whether the response *finished*, and Anthropic says *why it stopped*.
 */
export function responsesToAnthropicResponse(
  body: unknown,
  originalReq: Record<string, unknown>,
): Record<string, unknown> {
  const root = isPlainObject(body) ? body : {};
  const content: unknown[] = [];

  for (const item of Array.isArray(root.output) ? root.output : []) {
    if (!isPlainObject(item)) continue;

    if (item.type === "message") {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (isPlainObject(block) && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        }
      }
      continue;
    }

    if (item.type === "function_call") {
      let input: unknown = {};
      if (typeof item.arguments === "string") {
        try {
          input = JSON.parse(item.arguments) as unknown;
        } catch {
          input = {};
        }
      }
      content.push({
        type: "tool_use",
        id: String(item.call_id ?? item.name ?? "tool"),
        name: String(item.name ?? ""),
        input,
      });
      continue;
    }

    if (item.type === "reasoning") {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (isPlainObject(summary) && typeof summary.text === "string") {
          content.push({ type: "thinking", thinking: summary.text });
        }
      }
    }
  }

  const usage = isPlainObject(root.usage) ? root.usage : {};
  const wantsTool = content.some((block) => isPlainObject(block) && block.type === "tool_use");

  return {
    id: typeof root.id === "string" ? root.id : `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: typeof root.model === "string" ? root.model : originalReq.model,
    content,
    stop_reason: wantsTool ? "tool_use" : root.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
    },
  };
}
