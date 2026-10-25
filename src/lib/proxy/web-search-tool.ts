/**
 * src/lib/proxy/web-search-tool.ts
 *
 * The hosted `web_search` tool, answered by this deployment.
 *
 * OpenAI's Responses API has a **hosted** web search: a client asks for
 * `tools: [{type: "web_search"}]` and the server does the searching. The
 * frontends that speak it — ChatGPT-style clones, Dify's OpenAI-compatible
 * mode, OpenWebUI, LobeChat — send that tool and expect the answer back with
 * the sources on it.
 *
 * An upstream that only speaks Chat Completions cannot forward it: there is
 * no such thing in the shape it speaks, and forwarding it is a 400. So the
 * tool used to be **dropped** — the client asked for a web search and got a
 * plain conversation, with nothing in the answer to say it had not searched.
 *
 * So the gateway answers it:
 *
 *  1. it searches, through the same settlement every other search goes
 *     through, so the account is charged the same price it would be for a
 *     search it had asked for itself;
 *  2. it puts the results in front of the model, numbered, with the sources
 *     named;
 *  3. it marks the answer with the sources, in the shape the client asked
 *     for: a `web_search_call` item and `url_citation` annotations.
 *
 * **One search, before the model is called.** The hosted tool is a loop
 * upstream — the model decides to search, reads the results, and may search
 * again. Here the gateway decides, once, from the question: it is the shape
 * that works without a loop, and a search that never happens is worse than a
 * search that happened once.
 */

import type { ResponseAPIRequest, ResponsesInputItem } from "./types";
import { sseRewrite } from "./stream-tap";

/** One source, as the model and the client see it. */
export interface WebSearchSource {
  /** 1-based, because the model is asked to write `[1]`. */
  index: number;
  title: string;
  url: string;
  snippet: string;
}

/**
 * Does this request ask for the hosted web search?
 *
 * `web_search_preview` is the older spelling of the same tool and is still
 * what some clients send.
 */
export function wantsHostedWebSearch(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const type = (tool as { type?: unknown }).type;
    return type === "web_search" || type === "web_search_preview";
  });
}

/**
 * The question to search for: the last thing the user said.
 *
 * A Responses request carries its conversation in `input`, as a string or as
 * items. Only the user's own turns are asked — a system prompt is not a
 * question, and the assistant's earlier answers are not either.
 */
export function lastUserText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!Array.isArray(input)) return "";

  let found = "";
  for (const item of input) {
    if (typeof item === "string") {
      found = item.trim();
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const it = item as { type?: unknown; role?: unknown; content?: unknown };
    const role = String(it.role ?? (it.type === "message" ? "user" : "")).toLowerCase();
    if (role !== "user") continue;
    const text = textOf(it.content);
    if (text) found = text;
  }
  return found;
}

/** The text of a content value, whether it is a string or a list of blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n").trim();
}

/**
 * What the model is given: the results, numbered, with the sources named.
 *
 * The numbering is the link back — the model is asked to write `[n]` after a
 * claim, and those markers are where the citations come from. A model that
 * does not write them loses the citation, not the answer.
 */
export function buildSearchContext(query: string, sources: WebSearchSource[]): string {
  /**
   * Nothing found is still an answer, and it has to be said plainly.
   *
   * A context that opens with "here are the results" and then has no results
   * in it reads as a search that worked and came back empty — and a model
   * asked to answer from it will answer from memory, which is exactly the
   * thing the caller was told not to do. So the empty case says it outright.
   */
  if (sources.length === 0) {
    return [
      `没有检索到「${query}」的任何结果。`,
      "",
      "直接告诉用户没有搜到，不要根据记忆作答，也不要给出未经检索的来源。",
    ].join("\n");
  }

  const lines = sources.map(
    (source) =>
      `[${source.index}] ${source.title}\n${source.url}\n${source.snippet}`.trim(),
  );
  return [
    `以下是关于「${query}」的检索结果，来自公开网页：`,
    "",
    ...lines,
    "",
    "回答时以这些结果为依据，并在用到的结论后面标出来源编号（例如 [1]、[2]）。",
    "没有检索到结果的地方就直接说没有查到，不要编。",
  ].join("\n");
}

/**
 * The search results, as sources.
 *
 * The snippet is the short text the vendor gave; the summary is the longer one
 * when the vendor has one. A model reads the summary, a client shows the
 * snippet, and neither of them has to ask the other for it.
 */
export function sourcesFromResults(
  results: Array<{ title: string; url: string; snippet: string; summary?: string }>,
): WebSearchSource[] {
  return results.map((result, index) => ({
    index: index + 1,
    title: result.title,
    url: result.url,
    snippet: (result.summary ?? result.snippet).slice(0, 1_000),
  }));
}

/**
 * Put the search results in front of the model.
 *
 * They go **into the last thing the user said**, not as a turn of their own:
 * a second user message would read as the user asking twice, and the
 * retrieved text is not something anybody asked for — it is what the
 * deployment found. Marked as such, in the block itself.
 */
export function withSearchContext(
  input: ResponseAPIRequest["input"],
  context: string,
): ResponseAPIRequest["input"] {
  if (typeof input === "string") return `${input}\n\n${context}`;
  if (!Array.isArray(input)) return input;

  const out: ResponsesInputItem[] = [...input];
  for (let i = out.length - 1; i >= 0; i--) {
    const item: unknown = out[i];

    // A bare string in the list is not what the Responses API defines, but a
    // client that sends one means a user turn — so it becomes one.
    if (typeof item === "string") {
      out[i] = { type: "message", role: "user", content: `${item}\n\n${context}` };
      return out;
    }
    if (!item || typeof item !== "object") continue;
    const it = item as ResponsesInputItem;
    const role = String(it.role ?? (it.type === "message" ? "user" : "")).toLowerCase();
    if (role !== "user") continue;
    const content = it.content;
    out[i] = {
      ...it,
      content:
        typeof content === "string"
          ? `${content}\n\n${context}`
          : [
              ...(Array.isArray(content) ? content : []),
              { type: "input_text", text: context },
            ],
    };
    return out;
  }
  // No user turn to put it in: it becomes one.
  return [...out, { type: "message", role: "user", content: context }];
}

/**
 * Put the sources on the answer, in the shape the client asked for.
 *
 * Two things: a `web_search_call` item, so the client can show that a search
 * happened, and `url_citation` annotations on the text, so the client can
 * render the links.
 *
 * The annotations are found by looking for the `[n]` markers the model was
 * asked to write. A marker that is not there is a claim with no source, and it
 * gets no annotation — the alternative, inventing a range, would put a link
 * next to a sentence that never said it.
 */
export function applySearchAnnotations(output: unknown, sources: WebSearchSource[]): void {
  if (!output || typeof output !== "object") return;
  const items = (output as { output?: unknown }).output;
  if (!Array.isArray(items)) return;

  const byIndex = new Map(sources.map((source) => [source.index, source]));

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "output_text") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) continue;

      const annotations: unknown[] = [];
      for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
        const source = byIndex.get(Number(match[1]));
        if (!source) continue;
        annotations.push({
          type: "url_citation",
          start_index: match.index,
          end_index: match.index + match[0].length,
          url: source.url,
          title: source.title,
        });
      }
      if (annotations.length === 0) continue;
      (block as { annotations?: unknown[] }).annotations = [
        ...(((block as { annotations?: unknown[] }).annotations ?? []) as unknown[]),
        ...annotations,
      ];
    }
  }

  // The search call goes **before** the answer, where the client expects to
  // find it: the answer is what the search was for.
  const call = {
    type: "web_search_call",
    // Unique per call: two searches in the same millisecond must not share
    // an id, or a client that keys on it merges them.
    id: `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "completed",
  };
  const firstMessage = items.findIndex(
    (item) =>
      item && typeof item === "object" && (item as { type?: unknown }).type === "message",
  );
  if (firstMessage === -1) items.push(call);
  else items.splice(firstMessage, 0, call);
}

// ---------------------------------------------------------------------------
// The Chat Completions face
// ---------------------------------------------------------------------------

/**
 * Does a chat request ask for the hosted web search?
 *
 * Two spellings, and they come from two different kinds of client:
 *
 *  - `tools: [{type: "web_search"}]` — the Responses spelling, sent by the
 *    frontends that speak it (ChatGPT-style clones, Dify, OpenWebUI).
 *  - `web_search_options: {…}` — the Chat Completions spelling, the one the
 *    search-augmented chat APIs use.
 *
 * Both mean the same thing here: the deployment does the searching, and the
 * upstream is not asked to.
 */
export function wantsHostedChatSearch(req: {
  tools?: unknown;
  web_search_options?: unknown;
  [k: string]: unknown;
}): boolean {
  if (wantsHostedWebSearch(req.tools)) return true;
  const options = req.web_search_options;
  return options !== undefined && options !== null;
}

/**
 * How many results the caller asked for.
 *
 * `search_context_size` is the only knob the Chat Completions spelling has,
 * and it is a *size* rather than a count — "low" means fewer sources, not
 * shorter ones. So it is read as a count, with the middle one being what the
 * endpoint already asks for when nobody says anything.
 */
export function chatSearchLimit(options: unknown, fallback = 6): number {
  const size = (options as { search_context_size?: unknown } | null | undefined)?.search_context_size;
  if (typeof size !== "string") return fallback;
  const wanted = { low: 3, medium: 6, high: 8 }[size.toLowerCase()];
  return wanted ?? fallback;
}

/**
 * The question to search for: the last thing the user said.
 *
 * Only the user's own turns are asked — a system prompt is not a question, and
 * the assistant's earlier answers are not either.
 */
export function lastChatUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  let found = "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: unknown; content?: unknown };
    if (String(m.role ?? "").toLowerCase() !== "user") continue;
    const text = chatContentText(m.content);
    if (text) found = text;
  }
  return found;
}

/** The text of a chat message's content, whether it is a string or blocks. */
function chatContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n").trim();
}

/**
 * Put the search results in front of the model.
 *
 * Into the **last user message**, for the same reason the Responses face does
 * it: the retrieved text is what the deployment found, not something the user
 * asked for, and a second user turn reads as the user asking twice.
 */
export function withChatSearchContext(messages: unknown, context: string): unknown {
  if (!Array.isArray(messages)) return messages;

  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: unknown; content?: unknown };
    if (String(m.role ?? "").toLowerCase() !== "user") continue;
    const content = m.content;
    out[i] = {
      ...m,
      content:
        typeof content === "string"
          ? `${content}\n\n${context}`
          : [...(Array.isArray(content) ? content : []), { type: "text", text: context }],
    };
    return out;
  }
  // No user turn to put it in: it becomes one.
  return [...out, { role: "user", content: context }];
}

/**
 * Is this tool the hosted web search?
 *
 * `web_search_preview` is the older spelling of the same tool and is still
 * what some clients send.
 */
function isHostedWebSearchTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const type = (tool as { type?: unknown }).type;
  return type === "web_search" || type === "web_search_preview";
}

/**
 * Take the hosted-search markers out of the request.
 *
 * The upstream is not going to search: the deployment already did. Left in,
 * `web_search_options` is a field the upstream does not define (a 400), and a
 * `web_search` tool is a tool the upstream cannot run — either a 400 or a tool
 * call the model was never told how to answer.
 *
 * It is done **once**, by whoever did the searching, so that a request which
 * travels through the pivot cannot be searched twice.
 */
export function stripHostedSearchFields<T extends Record<string, unknown>>(req: T): T {
  const out: Record<string, unknown> = { ...req };
  delete out.web_search_options;

  const tools = out.tools;
  if (Array.isArray(tools)) {
    const kept = tools.filter((tool) => !isHostedWebSearchTool(tool));
    if (kept.length > 0) out.tools = kept;
    else delete out.tools;
  }
  return out as T;
}

/**
 * The citation, in the shape a Chat Completions client reads.
 *
 * `url_citation` carries the range **inside the message's own text**, so the
 * client knows which words the link belongs to. A citation without a range
 * would have to be guessed at by the client, and a guessed link lands next to
 * a sentence that never said it.
 */
export function chatUrlCitations(text: string, sources: WebSearchSource[]): unknown[] {
  const byIndex = new Map(sources.map((source) => [source.index, source]));

  const citations: unknown[] = [];
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const source = byIndex.get(Number(match[1]));
    if (!source) continue;
    citations.push({
      type: "url_citation",
      url_citation: {
        start_index: match.index,
        end_index: match.index + match[0].length,
        title: source.title,
        url: source.url,
      },
    });
  }
  return citations;
}

/**
 * Put the sources on the answer, in the Chat Completions shape.
 *
 * `choices[].message.annotations` is where a Chat Completions client looks
 * for them, so that is where they go.
 */
export function applyChatSearchAnnotations(response: unknown, sources: WebSearchSource[]): void {
  if (!response || typeof response !== "object") return;
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const text = (message as { content?: unknown }).content;
    if (typeof text !== "string" || text.length === 0) continue;

    const citations = chatUrlCitations(text, sources);
    if (citations.length === 0) continue;
    (message as { annotations?: unknown[] }).annotations = [
      ...(((message as { annotations?: unknown[] }).annotations ?? []) as unknown[]),
      ...citations,
    ];
  }
}

/**
 * The final frame of a stream, carrying the sources.
 *
 * A stream's text arrives in pieces, so the citations — which are ranges
 * *inside that text* — cannot be known until the text is whole. They are
 * therefore sent at the end, in one frame, which is where a non-streaming
 * answer carries them too.
 */
export function chatAnnotationChunk(args: {
  text: string;
  sources: WebSearchSource[];
  /** The frame fields copied from the upstream, so the chunk looks like its neighbours. */
  template: Record<string, unknown>;
  /**
   * Why the upstream stopped, as the upstream said it.
   *
   * The upstream's own reason: a stream that was cut short ("length") must not
   * be closed with "stop" just because the sources were appended.
   */
  finishReason: string | null;
}): string | null {
  const citations = chatUrlCitations(args.text, args.sources);
  if (citations.length === 0) return null;

  const chunk = {
    ...args.template,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: args.finishReason,
        message: {
          role: "assistant",
          content: args.text,
          annotations: citations,
        },
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}`;
}

/**
 * Put the sources on a streamed answer.
 *
 * The text is accumulated on the way through, and the upstream's closing frame
 * is **held back** until the citation frame has been added — a client that
 * stops reading at the end of the answer still gets the sources.
 */
export function withChatSearchAnnotationStream(
  body: ReadableStream<Uint8Array>,
  sources: WebSearchSource[],
): ReadableStream<Uint8Array> {
  let text = "";
  let template: Record<string, unknown> = {};
  let sawDone = false;
  /** Why the upstream stopped, as the upstream said it. */
  let finishReason: string | null = null;

  return sseRewrite(body, {
    map: (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return line;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        // Held back: the citation frame has to come before it.
        sawDone = true;
        return null;
      }
      if (!payload) return line;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (Object.keys(template).length === 0) {
          template = {
            id: parsed.id,
            object: parsed.object ?? "chat.completion.chunk",
            created: parsed.created,
            model: parsed.model,
          };
        }
        const choices = parsed.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = (choice as { delta?: { content?: unknown } } | null)?.delta;
            if (delta && typeof delta.content === "string") text += delta.content;
            const reason = (choice as { finish_reason?: unknown } | null)?.finish_reason;
            if (typeof reason === "string") finishReason = reason;
          }
        }
      } catch {
        // A keep-alive frame that is not JSON: nothing to collect.
      }
      return line;
    },
    onEnd: () => {
      const lines: string[] = [];
      const chunk = chatAnnotationChunk({ text, sources, template, finishReason });
      if (chunk) lines.push(chunk);
      // Only when the upstream sent one: a stream that ended without it ends
      // without it here too.
      if (sawDone) lines.push("data: [DONE]");
      return lines;
    },
  });
}
