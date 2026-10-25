/**
 * tests/unit/search-result-fields.test.ts
 *
 * The extra fields a search result can carry.
 *
 * A search answer used to have three fields and no more: a title, a URL and a
 * snippet. That was enough for a list of links and not enough for anything
 * else — a model asked to answer from the results had titles to work with and
 * nothing to quote, and a page's date and its site were nowhere to be found.
 *
 * So the protocol grew the rest, and the rule that matters is the one about
 * what the relay may **not** do:
 *
 *  - **the vendor's fields, or none.** A relay cannot invent a relevance
 *    score: a made-up one is worse than a missing one, because the reader has
 *    no way to tell it from a real one. The vendor's own scale is carried
 *    across as it is — the score is the vendor's, not a rescaled one.
 *  - **no duplicates.** Several vendors have exactly one text field, and the
 *    spec maps it to both the short line and the long read. On a short page
 *    the two are the same string, and a second field saying the same thing
 *    is not more information — so the duplicate goes.
 */
import { describe, it, expect } from "vitest";

import { buildSearchRequest, parseSearchResults } from "@/lib/search/engine";
import { SEARXNG_TEMPLATE, TAVILY_TEMPLATE } from "@/lib/search/templates";

describe("the vendor's extra fields come through", () => {
  it("with the vendor's own scale, not a rescaled one", () => {
    const results = parseSearchResults(SEARXNG_TEMPLATE.spec, {
      results: [
        {
          title: "图像生成",
          url: "https://docs.example/images",
          content: "一段摘要",
          score: 3.5,
          publishedDate: "2026-01-02",
        },
      ],
    });
    expect(results[0]).toMatchObject({
      title: "图像生成",
      url: "https://docs.example/images",
      snippet: "一段摘要",
      // SearXNG's own score, on SearXNG's own scale.
      score: 3.5,
      date: "2026-01-02",
    });
  });

  it("and the page body when the vendor sent one", () => {
    const results = parseSearchResults(TAVILY_TEMPLATE.spec, {
      results: [
        {
          title: "图像生成",
          url: "https://docs.example/images",
          content: "给模型读的摘要",
          raw_content: "网页正文",
        },
      ],
    });
    expect(results[0].snippet).toBe("给模型读的摘要");
    expect(results[0].content).toBe("网页正文");
  });

  it("and nothing at all when the vendor sent nothing", () => {
    const results = parseSearchResults(SEARXNG_TEMPLATE.spec, {
      results: [{ title: "A", url: "https://a.example", content: "摘要" }],
    });
    // No score, no date: the relay does not make them up.
    expect(results[0].score).toBeUndefined();
    expect(results[0].date).toBeUndefined();
    expect(results[0]).not.toHaveProperty("content");
  });
});

describe("a field that repeats another one is dropped", () => {
  it("because the same string in two fields is not more information", () => {
    // SearXNG has one text field, and the spec maps it to both the short line
    // and the long read — cut at two lengths. On a short page they are the
    // same string, so only the shorter one is kept.
    const results = parseSearchResults(SEARXNG_TEMPLATE.spec, {
      results: [{ title: "A", url: "https://a.example", content: "短" }],
    });
    expect(results[0].snippet).toBe("短");
    expect(results[0]).not.toHaveProperty("summary");
  });

  it("but the longer read is kept when there really is one", () => {
    const long = "x".repeat(400);
    const results = parseSearchResults(SEARXNG_TEMPLATE.spec, {
      results: [{ title: "A", url: "https://a.example", content: long }],
    });
    expect(results[0].snippet).toHaveLength(320);
    expect(results[0].summary).toHaveLength(400);
  });
});

describe("the caller can ask for the page bodies", () => {
  it("and the request says so", () => {
    const request = buildSearchRequest(
      TAVILY_TEMPLATE.spec,
      "https://api.tavily.com",
      { query: "文档", limit: 5, needContent: true },
    );
    const body = JSON.parse(request.body ?? "{}") as { include_raw_content: boolean };
    expect(body.include_raw_content).toBe(true);
  });

  it("and it is off when nobody asked", () => {
    const request = buildSearchRequest(
      TAVILY_TEMPLATE.spec,
      "https://api.tavily.com",
      { query: "文档", limit: 5 },
    );
    const body = JSON.parse(request.body ?? "{}") as { include_raw_content: boolean };
    expect(body.include_raw_content).toBe(false);
  });
});
