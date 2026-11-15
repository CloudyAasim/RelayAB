/**
 * tests/unit/search-markdown.test.ts
 *
 * The formatter behind `POST /v1/search?format=markdown` and the test page's
 * preview. One function, so the API and the panel cannot render the same
 * results two different ways.
 */
import { describe, it, expect } from "vitest";

import { searchResultsToMarkdown } from "@/lib/search/markdown";

describe("searchResultsToMarkdown", () => {
  it("numbers results and keeps the URL visible under each link", () => {
    const md = searchResultsToMarkdown("searxng", [
      { title: "Docs", url: "https://docs.searxng.org", snippet: "Search API docs", site_name: "searxng.org" },
      { title: "GitHub", url: "https://github.com/searxng/searxng", snippet: "Source" },
    ]);
    expect(md).toContain("# Search results: searxng");
    expect(md).toContain("1. **[Docs](https://docs.searxng.org)**");
    expect(md).toContain("2. **[GitHub](https://github.com/searxng/searxng)**");
    expect(md).toContain("- searxng.org");
    expect(md).toContain("> 2 results");
  });

  it("collapses newlines so a snippet cannot break the list", () => {
    const md = searchResultsToMarkdown("q", [
      { title: "t", url: "https://e.test/1", snippet: "line one\nline two" },
    ]);
    expect(md).toContain("- line one line two");
    expect(md.split("\n").filter((l) => l.startsWith("1."))).toHaveLength(1);
  });

  it("escapes brackets in titles, because they would end the link text", () => {
    const md = searchResultsToMarkdown("q", [{ title: "A [b] c", url: "https://e.test/1" }]);
    expect(md).toContain("**[A \\[b\\] c](https://e.test/1)**");
  });

  it("uses the URL as the title when the vendor gave none", () => {
    const md = searchResultsToMarkdown("q", [{ url: "https://e.test/1" }]);
    expect(md).toContain("**[https://e.test/1](https://e.test/1)**");
  });

  it("says so when there is nothing", () => {
    const md = searchResultsToMarkdown("q", []);
    expect(md).toContain("_No results._");
    expect(md).toContain("> 0 results");
  });

  it("names the provider when one is known", () => {
    const md = searchResultsToMarkdown("q", [{ title: "t", url: "https://e.test/1" }], { provider: "searxng" });
    expect(md).toContain("from searxng");
  });
});
