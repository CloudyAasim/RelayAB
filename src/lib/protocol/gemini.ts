/**
 * src/lib/protocol/gemini.ts
 *
 * The Gemini `generateContent` shapes, and the conversion between them and the
 * Responses shape the gateway speaks internally.
 *
 * ## Why this exists
 *
 * A client that speaks Gemini — the Google SDKs, LangChain's
 * `ChatGoogleGenerativeAI`, Gemini CLI, and a long tail of tools built on them
 * — cannot talk to a gateway that only answers OpenAI and Anthropic. They ask
 * for `POST /v1beta/models/{model}:generateContent` with a `contents` array,
 * and there is nothing on the other end.
 *
 * ## The pivot
 *
 * The gateway already has a pivot shape: the Responses API. A request is
 * translated into it, the upstream is called in whatever dialect it speaks,
 * and the answer is translated back. Gemini is one more pair of translations
 * around that pivot, which is why this module is only about shapes and never
 * about HTTP.
 *
 * ## What is lost, and where it goes
 *
 * Two things do not survive the trip, and both are stated rather than
 * dropped quietly:
 *
 *  - **`thinkingConfig.thinkingBudget`.** It is a token budget, and the pivot
 *    speaks in *levels* (`reasoning.effort`). A budget of zero does map —
 *    to `effort: "none"`, which means the same thing — but a budget of 8000
 *    has no level that says the same thing. It is dropped, and the operator
 *    who wants a fixed budget sets one in the provider's spec, which is the
 *    place a fixed value belongs.
 *  - **`safetySettings`.** They are a Google-side policy knob, and no other
 *    vendor has an equivalent field to move it to.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface GeminiPart {
  text?: string;
  /** True on the model's own reasoning, which Gemini returns as a part. */
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { fileUri?: string; mimeType?: string };
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name?: string; response?: Record<string, unknown>; id?: string };
}

export interface GeminiContent {
  /** Gemini says "model" where every other protocol says "assistant". */
  role?: "user" | "model";
  parts?: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface GeminiGenerateRequest {
  contents?: GeminiContent[];
  systemInstruction?: { parts?: GeminiPart[]; role?: string };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    candidateCount?: number;
    seed?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
  };
  tools?: { functionDeclarations?: GeminiFunctionDeclaration[] }[];
  toolConfig?: {
    functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] };
  };
  safetySettings?: unknown[];
}

export interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  index?: number;
  safetyRatings?: unknown[];
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The text of a set of parts, joined the way Gemini joins them. */
function partsText(parts: GeminiPart[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text as string)
    .join("");
}

// ---------------------------------------------------------------------------
// Gemini request → Responses request
// ---------------------------------------------------------------------------

/**
 * Translate a Gemini request into the pivot shape.
 *
 * The model is taken from the URL rather than the body: Gemini puts it in the
 * path (`/v1beta/models/gemini-2.5-flash:generateContent`) and the body has
 * no `model` field at all.
 */
export function geminiToResponsesRequest(
  body: GeminiGenerateRequest,
  model: string,
): Record<string, unknown> {
  const input: unknown[] = [];
  const instructions = partsText(body.systemInstruction?.parts);

  for (const content of body.contents ?? []) {
    const role = content?.role === "model" ? "assistant" : "user";
    const blocks: unknown[] = [];
    for (const part of content?.parts ?? []) {
      if (!part || typeof part !== "object") continue;

      if (typeof part.text === "string") {
        // A thought is the model's own reasoning. It is kept as a reasoning
        // item rather than as text, so that a Gemini upstream gets it back as
        // a thought and a chat upstream drops it — which is what each of them
        // can actually accept.
        if (part.thought === true) {
          blocks.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: part.text }],
          });
          continue;
        }
        blocks.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text: part.text,
        });
        continue;
      }

      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? "image/png";
        blocks.push({
          type: "input_image",
          image_url: `data:${mime};base64,${part.inlineData.data}`,
        });
        continue;
      }

      if (part.functionCall?.name) {
        blocks.push({
          type: "function_call",
          call_id: part.functionCall.id ?? part.functionCall.name,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
        continue;
      }

      if (part.functionResponse) {
        blocks.push({
          type: "function_call_output",
          call_id:
            part.functionResponse.id ?? part.functionResponse.name ?? "function_call",
          output: JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
    }
    if (blocks.length > 0) input.push({ role, content: blocks });
  }

  const out: Record<string, unknown> = { model, input };
  if (instructions) out.instructions = instructions;

  const cfg = body.generationConfig ?? {};
  const temperature = asNumber(cfg.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = asNumber(cfg.topP);
  if (topP !== undefined) out.top_p = topP;
  const maxOutputTokens = asNumber(cfg.maxOutputTokens);
  if (maxOutputTokens !== undefined) out.max_output_tokens = maxOutputTokens;
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length > 0) {
    out.stop = cfg.stopSequences;
  }
  const seed = asNumber(cfg.seed);
  if (seed !== undefined) out.seed = seed;

  // A budget of zero is the same request as "do not think", and the pivot
  // says exactly that. Any other budget has no level that means the same
  // thing, so it is left to the provider's spec.
  if (cfg.thinkingConfig?.thinkingBudget === 0) {
    out.reasoning = { effort: "none" };
  }

  // A structured-output request is a JSON-schema request in the pivot's
  // vocabulary.
  if (cfg.responseMimeType === "application/json" && cfg.responseSchema !== undefined) {
    out.text = {
      format: {
        type: "json_schema",
        name: "response",
        schema: cfg.responseSchema,
        strict: true,
      },
    };
  }

  const tools: unknown[] = [];
  for (const tool of body.tools ?? []) {
    for (const decl of tool?.functionDeclarations ?? []) {
      if (!decl?.name) continue;
      tools.push({
        type: "function",
        name: decl.name,
        ...(decl.description !== undefined ? { description: decl.description } : {}),
        ...(decl.parameters !== undefined ? { parameters: decl.parameters } : {}),
      });
    }
  }
  if (tools.length > 0) out.tools = tools;

  const mode = body.toolConfig?.functionCallingConfig?.mode;
  if (mode === "AUTO") out.tool_choice = "auto";
  else if (mode === "ANY") out.tool_choice = "required";
  else if (mode === "NONE") out.tool_choice = "none";

  return out;
}

// ---------------------------------------------------------------------------
// Responses response → Gemini response
// ---------------------------------------------------------------------------

/**
 * Translate the pivot's answer into the Gemini shape.
 *
 * The finish reason is the part worth reading twice: Gemini names the *reason
 * it stopped* (`STOP`, `MAX_TOKENS`, `SAFETY`), and the pivot names the
 * *state of the response* (`completed`, `incomplete`, `failed`). The mapping
 * is therefore a translation, not a copy — and `incomplete` is the one that
 * matters, because it is the only case where the model was cut off rather
 * than finished.
 */
export function responsesToGeminiResponse(
  body: unknown,
  model: string,
): GeminiGenerateResponse {
  const root = isPlainObject(body) ? body : {};
  const parts: GeminiPart[] = [];

  for (const item of Array.isArray(root.output) ? root.output : []) {
    if (!isPlainObject(item)) continue;

    if (item.type === "message") {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (isPlainObject(block) && typeof block.text === "string") {
          parts.push({ text: block.text });
        }
      }
      continue;
    }

    if (item.type === "function_call" && typeof item.name === "string") {
      let args: Record<string, unknown> = {};
      if (typeof item.arguments === "string") {
        try {
          args = JSON.parse(item.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
      } else if (isPlainObject(item.arguments)) {
        args = item.arguments;
      }
      parts.push({
        functionCall: {
          name: item.name,
          args,
          ...(typeof item.call_id === "string" ? { id: item.call_id } : {}),
        },
      });
      continue;
    }

    if (item.type === "reasoning") {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (isPlainObject(summary) && typeof summary.text === "string") {
          parts.push({ text: summary.text, thought: true });
        }
      }
    }
  }

  const usage = isPlainObject(root.usage) ? root.usage : {};
  const promptTokens = asNumber(usage.input_tokens) ?? 0;
  const completionTokens = asNumber(usage.output_tokens) ?? 0;

  const finishReason =
    root.status === "incomplete"
      ? "MAX_TOKENS"
      : root.status === "failed"
        ? "OTHER"
        : "STOP";

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: asNumber(usage.total_tokens) ?? promptTokens + completionTokens,
    },
    modelVersion: model,
    ...(typeof root.id === "string" ? { responseId: root.id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * One Gemini chunk, in the shape `streamGenerateContent` sends.
 *
 * The same `candidates` array as the non-streaming answer, minus the parts
 * that only make sense once: the usage block rides along on the last chunk,
 * because that is the only chunk where it is final.
 */
export interface GeminiStreamChunk {
  candidates: Array<{
    content: { role: "model"; parts: GeminiPart[] };
    index: number;
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

/** A chunk carrying one piece of text. */
export function geminiTextChunk(text: string, model?: string): GeminiStreamChunk {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        index: 0,
      },
    ],
    ...(model ? { modelVersion: model } : {}),
  };
}

/** The final chunk: no more text, the reason it stopped, and the usage. */
export function geminiFinalChunk(args: {
  model?: string;
  usage?: GeminiUsageMetadata;
  finishReason?: string;
  responseId?: string;
}): GeminiStreamChunk {
  return {
    candidates: [
      {
        content: { role: "model", parts: [] },
        index: 0,
        finishReason: args.finishReason ?? "STOP",
      },
    ],
    ...(args.usage ? { usageMetadata: args.usage } : {}),
    ...(args.model ? { modelVersion: args.model } : {}),
    ...(args.responseId ? { responseId: args.responseId } : {}),
  };
}
