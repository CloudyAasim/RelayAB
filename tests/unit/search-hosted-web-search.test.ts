/**
 * tests/unit/search-hosted-web-search.test.ts
 *
 * The hosted web search: the gateway searches for the model.
 *
 * A client that asks for a search has to be able to trust three things, and
 * each of them has broken in a different way:
 *
 *  1. **the search happened.** The upstream that only speaks Chat Completions
 *     cannot forward a `web_search` tool — it is either refused or answered by
 *     a model that was never told how. So the gateway searches, and it has to
 *     do it exactly once: twice would charge the account twice and put two
 *     sets of results in front of the model.
 *  2. **the results reached the model.** They go into the last user message,
 *     not as a turn of their own — a second user message reads as the user
 *     asking twice.
 *  3. **the sources reached the client.** In the shape the client asked for:
 *     `url_citation` annotations on a Chat Completions answer, a
 *     `web_search_call` item and annotations on a Responses answer.
 *
 * And one thing that must *not* happen: a citation on a claim the model never
 * made. The citations are found by looking for the `[n]` markers the model was
 * asked to write, so a marker it did not write produces no link — the
 * alternative, inventing a range, puts a link next to a sentence that never
 * said it.
 */
import { describe, it, expect } from "vitest";

import {
  applyChatSearchAnnotations,
  applySearchAnnotations,
  buildSearchContext,
  chatSearchLimit,
  chatUrlCitations,
  lastChatUserText,
  lastUserText,
  sourcesFromResults,
  stripHostedSearchFields,
  wantsHostedChatSearch,
  wantsHostedWebSearch,
  withChatSearchAnnotationStream,
  withChatSearchContext,
  withSearchContext,
  type WebSearchSource,
} from "@/lib/proxy/web-search-tool";

const sources: WebSearchSource[] = [
  { index: 1, title: "文档", url: "https://docs.example/a", snippet: "第一条" },
  { index: 2, title: "公告", url: "https://news.example/b", snippet: "第二条" },
];

function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("the request says it wants a search", () => {
  it("in the Responses spelling", () => {
    expect(wantsHostedWebSearch([{ type: "web_search" }])).toBe(true);
    // The older spelling is still what some clients send.
    expect(wantsHostedWebSearch([{ type: "web_search_preview" }])).toBe(true);
    expect(wantsHostedWebSearch([{ type: "function", function: { name: "x" } }])).toBe(false);
    expect(wantsHostedWebSearch(undefined)).toBe(false);
  });

  it("in the Chat Completions spelling", () => {
    expect(wantsHostedChatSearch({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(wantsHostedChatSearch({ web_search_options: { search_context_size: "high" } })).toBe(true);
    // A plain chat request is not a search request.
    expect(wantsHostedChatSearch({})).toBe(false);
    // `null` is "not set", not "search with no options".
    expect(wantsHostedChatSearch({ web_search_options: null })).toBe(false);
  });

  it("and reads the size it asks for", () => {
    expect(chatSearchLimit({ search_context_size: "low" })).toBe(3);
    expect(chatSearchLimit({ search_context_size: "medium" })).toBe(6);
    expect(chatSearchLimit({ search_context_size: "high" })).toBe(8);
    // An unknown size is not a guess: it falls back to what the endpoint asks
    // for when nobody says anything.
    expect(chatSearchLimit({ search_context_size: "enormous" })).toBe(6);
    expect(chatSearchLimit(undefined)).toBe(6);
  });
});

describe("the upstream is not asked to search", () => {
  it("the hosted markers are taken out of the request", () => {
    const stripped = stripHostedSearchFields({
      model: "m",
      web_search_options: { search_context_size: "low" },
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "lookup" } },
      ],
    });
    // `web_search_options` is a field the upstream does not define, and a
    // `web_search` tool is a tool it cannot run: either one is a 400.
    expect(stripped).not.toHaveProperty("web_search_options");
    expect(stripped.tools).toEqual([{ type: "function", function: { name: "lookup" } }]);
  });

  it("and a tool list that was nothing but the search is removed entirely", () => {
    const stripped = stripHostedSearchFields({ tools: [{ type: "web_search" }] });
    expect(stripped).not.toHaveProperty("tools");
  });
});

describe("the question is the last thing the user said", () => {
  it("on a chat request", () => {
    expect(
      lastChatUserText([
        { role: "system", content: "你是助手" },
        { role: "user", content: "第一个问题" },
        { role: "assistant", content: "回答" },
        { role: "user", content: "第二个问题" },
      ]),
    ).toBe("第二个问题");
  });

  it("and a system prompt is not a question", () => {
    expect(lastChatUserText([{ role: "system", content: "今天天气如何" }])).toBe("");
    expect(lastChatUserText(undefined)).toBe("");
  });

  it("on a Responses request", () => {
    expect(
      lastUserText([
        { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] },
      ]),
    ).toBe("问题");
    expect(lastUserText("直接给字符串")).toBe("直接给字符串");
  });
});

describe("the results go in front of the model", () => {
  const context = buildSearchContext("问题", sources);

  it("numbered, with the sources named", () => {
    expect(context).toContain("[1] 文档");
    expect(context).toContain("https://docs.example/a");
    expect(context).toContain("[2] 公告");
    // And the instruction that is what makes the citations possible at all.
    expect(context).toContain("[1]");
  });

  it("into the last user message, not as a turn of its own", () => {
    const messages = withChatSearchContext(
      [
        { role: "user", content: "问题" },
        { role: "assistant", content: "之前的回答" },
      ],
      context,
    ) as Array<{ role: string; content: string }>;
    // The assistant's own last message is not where the results go: the
    // question is the user's, and the results answer it.
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain(context);
    expect(messages[1].content).toBe("之前的回答");
  });

  it("and the Responses face puts it into the last user turn too", () => {
    const input = withSearchContext(
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] }],
      context,
    ) as Array<{ content: Array<{ text?: string }> }>;
    expect(input[0].content.map((block) => block.text).join("")).toContain(context);
  });
});

describe("the sources reach the client", () => {
  it("as url_citation annotations on a Chat Completions answer", () => {
    const answer: {
      choices: Array<{
        index: number;
        message: { role: string; content: string; annotations?: unknown[] };
      }>;
    } = {
      choices: [{ index: 0, message: { role: "assistant", content: "结论 [1]，另一条 [2]。" } }],
    };
    applyChatSearchAnnotations(answer, sources);
    const citations = answer.choices[0].message.annotations as Array<{
      url_citation: { url: string; start_index: number };
    }>;
    expect(citations).toHaveLength(2);
    expect(citations[0].url_citation.url).toBe("https://docs.example/a");
    // The range is inside the message's own text, so a client knows which
    // words the link belongs to.
    expect(citations[0].url_citation.start_index).toBe(3);
  });

  it("and a marker the model never wrote gets no link", () => {
    const citations = chatUrlCitations("没有来源的一句话 [9]", sources);
    // There is no ninth source, so there is nothing to link to. Inventing a
    // range would put a link next to a sentence that never said it.
    expect(citations).toEqual([]);
  });

  it("and a Responses answer carries the search call and the annotations", () => {
    const output: {
      output: Array<{
        type: string;
        content?: Array<{ type?: string; text?: string; annotations?: unknown[] }>;
      }>;
    } = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "结论 [1]。" }],
        },
      ],
    };
    applySearchAnnotations(output, sources);
    // The search call goes **before** the answer: the answer is what the
    // search was for.
    expect(output.output[0].type).toBe("web_search_call");
    expect(output.output[1].type).toBe("message");
    const block = output.output[1].content?.[0];
    expect(block?.annotations).toHaveLength(1);
  });
});

describe("a streamed answer carries its sources too", () => {
  it("in the last frame, before the end", async () => {
    const upstream = sseStream(
      'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"答案 [1]"}}]}\n\n' +
        'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    );
    const out = await readAll(withChatSearchAnnotationStream(upstream, sources));

    // The text itself is untouched — the client asked for a stream and gets one.
    expect(out).toContain('"content":"答案 [1]"');
    expect(out).toContain("url_citation");
    // And the sources come before the end of the stream: a client that stops
    // reading at the end of the answer still gets them.
    expect(out.indexOf("url_citation")).toBeLessThan(out.indexOf("[DONE]"));
  });

  it("and a stream with no markers in it gets no extra frame", async () => {
    const upstream = sseStream(
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"没有来源"}}]}\n\n' +
        "data: [DONE]\n\n",
    );
    const out = await readAll(withChatSearchAnnotationStream(upstream, sources));
    expect(out).not.toContain("url_citation");
    // The end of the stream is still the end of the stream.
    expect(out).toContain("data: [DONE]");
  });
});

describe("the results become sources", () => {
  it("numbered from one, in the order the vendor gave them", () => {
    const built = sourcesFromResults([
      { title: "A", url: "https://a.example", snippet: "短", summary: "长" },
      { title: "B", url: "https://b.example", snippet: "只有摘要" },
    ]);
    expect(built.map((source) => source.index)).toEqual([1, 2]);
    // The vendor's longer text is the one a model reads.
    expect(built[0].snippet).toBe("长");
    expect(built[1].snippet).toBe("只有摘要");
  });
});
