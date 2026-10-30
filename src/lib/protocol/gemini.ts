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
// Responses request → Gemini request
// ---------------------------------------------------------------------------

/**
 * Translate the pivot's request into the Gemini shape.
 *
 * The mirror of {@link geminiToResponsesRequest}: that one is for a Gemini
 * *client*, this one is for a Gemini *upstream*. A vendor that publishes
 * Google's own API speaks Gemini, and the gateway has to be able to talk to
 * it.
 *
 * The pivot's items are flat and typed (`input_text`, `input_image`,
 * `function_call`, …); Gemini's are a list of contents carrying `parts`. Two
 * things are worth naming:
 *
 *  - **Consecutive turns are merged.** The pivot has no opinion about
 *    alternating roles, and Gemini does: two user turns in a row are one turn
 *    as far as it is concerned.
 *  - **An image has to be bytes.** The pivot carries a data URL; Gemini wants
 *    `inlineData`. A remote image URL has no bytes to inline and is dropped —
 *    Gemini's `fileData` only accepts a Files API or GCS URI, not an
 *    arbitrary address.
 */
export function responsesToGeminiRequest(
  req: Record<string, unknown>,
): GeminiGenerateRequest {
  const contents: GeminiContent[] = [];

  const append = (role: "user" | "model", part: GeminiPart): void => {
    const last = contents[contents.length - 1];
    if (last && last.role === role && Array.isArray(last.parts)) {
      last.parts.push(part);
      return;
    }
    contents.push({ role, parts: [part] });
  };

  const input = req.input;
  if (typeof input === "string") {
    append("user", { text: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const type = typeof entry.type === "string" ? entry.type : "";

      // A plain message: {role, content}. The content is a string or a list of
      // blocks, and the blocks are where the types live — an image is a block
      // here, not a top-level item.
      if (type === "" || type === "message") {
        const role =
          String(entry.role ?? "user").toLowerCase() === "assistant" ? "model" : "user";
        const content = entry.content;

        if (typeof content === "string") {
          if (content) append(role, { text: content });
          continue;
        }

        for (const block of Array.isArray(content) ? content : []) {
          if (typeof block === "string") {
            if (block) append(role, { text: block });
            continue;
          }
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const blockType = typeof b.type === "string" ? b.type : "";

          if (
            blockType === "input_text" ||
            blockType === "output_text" ||
            blockType === "text" ||
            blockType === "summary_text"
          ) {
            const text = typeof b.text === "string" ? b.text : "";
            if (text) append(role, { text });
            continue;
          }

          if (blockType === "input_image" || blockType === "image_url") {
            const inline = dataUrlToInlineData(imageUrlOf(b));
            if (inline) append(role, { inlineData: inline });
          }
        }
        continue;
      }

      if (type === "input_text" || type === "output_text" || type === "text") {
        const text = typeof entry.text === "string" ? entry.text : "";
        if (text) append("user", { text });
        continue;
      }

      if (type === "reasoning") {
        // The pivot keeps a model's own reasoning in a reasoning item; Gemini
        // keeps it as a part marked `thought`.
        for (const summary of Array.isArray(entry.summary) ? entry.summary : []) {
          if (
            summary &&
            typeof summary === "object" &&
            typeof (summary as { text?: unknown }).text === "string"
          ) {
            append("model", { text: (summary as { text: string }).text, thought: true });
          }
        }
        continue;
      }

      if (type === "input_image" || type === "image_url") {
        const inline = dataUrlToInlineData(imageUrlOf(entry));
        if (inline) append("user", { inlineData: inline });
        continue;
      }

      if (type === "function_call") {
        append("model", {
          functionCall: {
            name: String(entry.name ?? ""),
            args: parseJsonObject(entry.arguments),
            ...(typeof entry.call_id === "string" ? { id: entry.call_id } : {}),
          },
        });
        continue;
      }

      if (type === "function_call_output") {
        append("user", {
          functionResponse: {
            name: String(entry.call_id ?? entry.name ?? "function_call"),
            response: {
              output:
                typeof entry.output === "string"
                  ? entry.output
                  : JSON.stringify(entry.output ?? {}),
            },
          },
        });
      }
    }
  }

  const out: GeminiGenerateRequest = {};
  if (contents.length > 0) out.contents = contents;

  const instructions = typeof req.instructions === "string" ? req.instructions : "";
  if (instructions) out.systemInstruction = { parts: [{ text: instructions }] };

  const cfg: NonNullable<GeminiGenerateRequest["generationConfig"]> = {};
  if (typeof req.temperature === "number") cfg.temperature = req.temperature;
  if (typeof req.top_p === "number") cfg.topP = req.top_p;
  if (typeof req.max_output_tokens === "number") cfg.maxOutputTokens = req.max_output_tokens;
  const stop = req.stop;
  if (typeof stop === "string" && stop) cfg.stopSequences = [stop];
  else if (Array.isArray(stop) && stop.length > 0) cfg.stopSequences = stop.map(String);

  // A thinking budget of zero is "do not think", which is exactly what the
  // pivot's `effort: "none"` says. It is the one budget with an equivalent.
  const effort = (req.reasoning as { effort?: unknown } | undefined)?.effort;
  if (effort === "none") cfg.thinkingConfig = { thinkingBudget: 0 };

  // A structured-output request in the pivot's vocabulary is a JSON-schema
  // request in Gemini's.
  const text = req.text as { format?: { type?: string; schema?: unknown } } | undefined;
  if (text?.format?.type === "json_schema" && text.format.schema !== undefined) {
    cfg.responseMimeType = "application/json";
    cfg.responseSchema = text.format.schema;
  }
  if (Object.keys(cfg).length > 0) out.generationConfig = cfg;

  // Tools: the pivot's flat function list becomes Gemini's declarations.
  const declarations: GeminiFunctionDeclaration[] = [];
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!tool || typeof tool !== "object") continue;
      const t = tool as Record<string, unknown>;
      if (typeof t.type === "string" && t.type !== "function") continue;
      if (typeof t.name !== "string" || !t.name) continue;
      declarations.push({
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      });
    }
  }
  if (declarations.length > 0) out.tools = [{ functionDeclarations: declarations }];

  const choice = req.tool_choice;
  if (typeof choice === "string") {
    const mode =
      choice === "required" ? "ANY" : choice === "none" ? "NONE" : choice === "auto" ? "AUTO" : null;
    if (mode) out.toolConfig = { functionCallingConfig: { mode } };
  }

  return out;
}

/** A data URL unpacked into Gemini's `inlineData`. Null when it is not one. */
function dataUrlToInlineData(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * The address of an image, wherever the item happens to keep it.
 *
 * The pivot writes `image_url` as a string, and the OpenAI-shaped form writes
 * it as an object — both spellings turn up in the wild.
 */
function imageUrlOf(item: Record<string, unknown>): string {
  const raw = item.image_url ?? item.url;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { url?: unknown }).url === "string") {
    return String((raw as { url: string }).url);
  }
  return "";
}

/** A tool call's arguments, which arrive as a JSON string. */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(value) ? value : {};
}

// ---------------------------------------------------------------------------
// Gemini response → Responses response
// ---------------------------------------------------------------------------

/**
 * Translate Gemini's answer into the pivot's shape.
 *
 * The mirror of {@link responsesToGeminiResponse}, and the two have to agree
 * about the finish reason — Gemini names the *reason it stopped* and the pivot
 * names the *state of the response*, so it is a translation in both
 * directions:
 *
 * | Gemini | pivot |
 * | --- | --- |
 * | `STOP` | `completed` |
 * | `MAX_TOKENS` | `incomplete` |
 * | `SAFETY` / `OTHER` / … | `failed` |
 *
 * A safety block is a failure rather than a truncation, and saying so is the
 * difference between a client that retries and one that shows the user what
 * happened.
 */
export function geminiToResponsesResponse(
  body: unknown,
  model: string,
): Record<string, unknown> {
  /**
   * Google answers the streaming endpoint with a JSON **array** of chunks when
   * `alt=sse` does not arrive — the frames, but not as SSE. Treating that as
   * an empty answer would be the worst kind of wrong: a 200 with no text in it.
   * So the array is merged into the one answer it stands for.
   */
  if (Array.isArray(body)) {
    const parts: GeminiPart[] = [];
    let finishReason: string | undefined;
    let meta: Record<string, unknown> | undefined;
    let responseId: string | undefined;
    let modelVersion: string | undefined;

    for (const chunk of body) {
      if (!isPlainObject(chunk)) continue;
      const candidate = Array.isArray(chunk.candidates) ? chunk.candidates : undefined;
      const first = candidate?.[0];
      const content = isPlainObject(first) ? first.content : undefined;
      const chunkParts = isPlainObject(content) && Array.isArray(content.parts) ? content.parts : [];
      for (const part of chunkParts) {
        if (isPlainObject(part) && typeof part.text === "string" && part.text) {
          parts.push({ text: part.text });
        }
      }
      if (isPlainObject(first) && typeof first.finishReason === "string") {
        finishReason = first.finishReason;
      }
      if (isPlainObject(chunk.usageMetadata)) meta = chunk.usageMetadata;
      if (typeof chunk.responseId === "string") responseId = chunk.responseId;
      if (typeof chunk.modelVersion === "string") modelVersion = chunk.modelVersion;
    }

    return geminiToResponsesResponse(
      {
        candidates: [{ content: { role: "model", parts }, finishReason: finishReason ?? "STOP" }],
        usageMetadata: meta,
        ...(responseId ? { responseId } : {}),
        ...(modelVersion ? { modelVersion } : {}),
      },
      model,
    );
  }

  const root = isPlainObject(body) ? body : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const candidate = isPlainObject(candidates[0]) ? (candidates[0] as Record<string, unknown>) : {};
  const content = isPlainObject(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? (content.parts as GeminiPart[]) : [];

  const output: unknown[] = [];
  let message: Record<string, unknown> | null = null;
  const ensureMessage = (): Record<string, unknown> => {
    if (!message) {
      message = {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [],
      };
      output.push(message);
    }
    return message;
  };

  let text = "";
  for (const part of parts) {
    if (!isPlainObject(part)) continue;

    if (typeof part.text === "string" && part.text) {
      if (part.thought === true) {
        output.push({
          type: "reasoning",
          summary: [{ type: "summary_text", text: part.text }],
        });
        continue;
      }
      text += part.text;
      continue;
    }

    if (isPlainObject(part.functionCall)) {
      const call = part.functionCall;
      output.push({
        type: "function_call",
        call_id: typeof call.id === "string" ? call.id : String(call.name ?? "call"),
        name: String(call.name ?? ""),
        arguments: JSON.stringify(call.args ?? {}),
      });
    }
  }
  if (text) {
    const blocks = (ensureMessage().content as Array<Record<string, unknown>>);
    blocks.push({ type: "output_text", text, annotations: [] });
  }

  const finishReason =
    typeof candidate.finishReason === "string" ? candidate.finishReason : "STOP";
  const status =
    finishReason === "STOP"
      ? "completed"
      : finishReason === "MAX_TOKENS"
        ? "incomplete"
        : "failed";

  const meta = isPlainObject(root.usageMetadata) ? root.usageMetadata : {};
  const promptTokens = asNumber(meta.promptTokenCount) ?? 0;
  const completionTokens = geminiOutputTokens(meta);
  const cachedTokens = asNumber(meta.cachedContentTokenCount) ?? 0;

  /**
   * The pivot's usage.
   *
   * `output_tokens` carries the thinking along with the answer, which is what
   * OpenAI's own `output_tokens` means — and it makes `total_tokens` add up:
   * Google's `totalTokenCount` is `prompt + candidates + thoughts`, and the
   * three are now the same three numbers.
   */
  const usage: Record<string, unknown> = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: asNumber(meta.totalTokenCount) ?? promptTokens + completionTokens,
  };
  // Gemini reports the cached slice of the prompt separately; the pivot's shape
  // is what the billing code reads.
  if (cachedTokens > 0) usage.input_tokens_details = { cached_tokens: cachedTokens };

  return {
    id: typeof root.responseId === "string" ? root.responseId : `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: typeof root.modelVersion === "string" ? root.modelVersion : model,
    output,
    output_text: text,
    error:
      status === "failed"
        ? { code: finishReason.toLowerCase(), message: `Gemini stopped: ${finishReason}` }
        : null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    usage,
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

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * The output tokens of a Gemini answer.
 *
 * The thinking tokens are counted **with** the candidate tokens, because that
 * is what they are billed as — Google's own `totalTokenCount` is
 * `promptTokenCount + candidatesTokenCount + thoughtsTokenCount`, so a gateway
 * that counts only the candidates hands the thinking out for free.
 *
 * It is also what the pivot means by "output tokens": OpenAI's `output_tokens`
 * includes the reasoning tokens, and the two vocabularies have to agree on
 * that or the same request costs a different amount depending on which side
 * of the gateway it is counted on.
 */
export function geminiOutputTokens(meta: unknown): number {
  const m = isPlainObject(meta) ? meta : {};
  const candidates = asNumber(m.candidatesTokenCount) ?? 0;
  const thoughts = asNumber(m.thoughtsTokenCount) ?? 0;
  return candidates + thoughts;
}

/**
 * The usage of a Gemini answer, in the gateway's own words.
 *
 * Gemini counts in a vocabulary of its own: `promptTokenCount`,
 * `candidatesTokenCount`, `totalTokenCount`, and the cached slice of the
 * prompt under `cachedContentTokenCount`. The billing code reads the OpenAI
 * and Anthropic spellings, so the numbers are read here — once — rather than
 * in every place that looks at a Gemini answer.
 *
 * The answer may be one body or the JSON **array** of chunks the streaming
 * endpoint sends without `alt=sse`; the usage rides on the last chunk that
 * carries it, so an array is searched from the back.
 *
 * The output tokens include the thinking — see {@link geminiOutputTokens}.
 */
export function geminiUsage(answer: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
} {
  const chunks = Array.isArray(answer) ? answer : [answer];
  let meta: Record<string, unknown> | undefined;
  for (const chunk of chunks) {
    if (!isPlainObject(chunk)) continue;
    if (isPlainObject(chunk.usageMetadata)) meta = chunk.usageMetadata;
  }

  const source = meta ?? {};
  const promptTokens = asNumber(source.promptTokenCount) ?? 0;
  const completionTokens = geminiOutputTokens(source);
  return {
    promptTokens,
    completionTokens,
    totalTokens: asNumber(source.totalTokenCount) ?? promptTokens + completionTokens,
    cachedTokens: asNumber(source.cachedContentTokenCount) ?? 0,
  };
}

/**
 * The prompt's text, for the estimate a stream without usage falls back on.
 *
 * The same text the translated path measures, measured here without the
 * detour through the pivot: the system instruction and the contents.
 */
export function geminiInputText(body: GeminiGenerateRequest): string {
  const parts: string[] = [];
  const instruction = partsText(body.systemInstruction?.parts);
  if (instruction) parts.push(instruction);
  for (const content of body.contents ?? []) {
    const text = partsText(content?.parts);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}
