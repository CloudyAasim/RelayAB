/**
 * tests/unit/assistant-web-fetch-discovery.test.ts
 *
 * A documentation page whose body never arrives.
 *
 * The concrete failure: `docs.bigmodel.cn` answers the API-reference URL with
 * a 200 and a JavaScript shell. `fetch_page` extracted navigation and nothing
 * else, so the assistant concluded the page was empty — while the request and
 * response schemas were sitting in `/openapi/openapi.json` the whole time.
 * Agnes needed `/llms.txt` and `<page>.md` for the same reason.
 *
 * So a page with almost no visible text is treated as "the body did not
 * render" and probed for the three conventions that answer for it:
 * `<page>.md`, `/llms.txt`, `/openapi.json`. The probes are best-effort: they
 * may never turn a readable page into an error, and they may not outlive the
 * call they are helping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchPage, DOC_TEXT_MIN_CHARS } from "@/lib/assistant/web-fetch";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const SHELL = `<html><body><div id="root">Loading…</div></body></html>`;
const RICH = `<html><body><h1>Image generation</h1><p>${"real documentation body. ".repeat(
  Math.ceil(DOC_TEXT_MIN_CHARS / 20),
)}</p></body></html>`;

function responder(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes[url] ?? routes[url.split("?")[0]];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
}

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const text = (body: string) =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a page that renders to nothing", () => {
  it("uses the Markdown source at <page>.md, and says that it did", async () => {
    const impl = responder({
      "https://docs.example/api-reference": () => html(SHELL),
      "https://docs.example/api-reference.md": () =>
        text("# Image generation\n\nPOST /v1/images/generations\n\n| field | type |\n| prompt | string |"),
    });

    const page = await fetchPage("https://docs.example/api-reference", impl);

    expect(page.source).toBe("markdown");
    expect(page.text).toContain("POST /v1/images/generations");
    // The reader must not think the URL it asked for contains this.
    expect(page.text).toContain("Markdown");
    expect(page.discovered?.some((d) => d.kind === "markdown")).toBe(true);
  });

  it("offers llms.txt and openapi.json as next reads", async () => {
    const impl = responder({
      "https://docs.example/api-reference": () => html(SHELL),
      "https://docs.example/llms.txt": () =>
        text("- [Image API](https://docs.example/images.md)\n- [Audio API](https://docs.example/audio.md)"),
      "https://docs.example/openapi.json": () =>
        json({
          paths: {
            "/paas/v4/images/generations": {},
            "/paas/v4/audio/speech": {},
            "/paas/v4/audio/transcriptions": {},
          },
        }),
    });

    const page = await fetchPage("https://docs.example/api-reference", impl);

    // No Markdown version, so the original shell stays — but the useful
    // documents beside it are named.
    expect(page.source).toBeUndefined();
    const llms = page.discovered?.find((d) => d.kind === "llms");
    expect(llms?.preview).toContain("Image API");
    const openapi = page.discovered?.find((d) => d.kind === "openapi");
    expect(openapi?.paths).toEqual([
      "/paas/v4/images/generations",
      "/paas/v4/audio/speech",
      "/paas/v4/audio/transcriptions",
    ]);
    expect(openapi?.note).toContain("3 个端点");
  });

  it("prefers the Markdown body over the shell when both are present", async () => {
    const impl = responder({
      "https://docs.example/page": () => html(SHELL),
      "https://docs.example/page.md": () => text("# Full page\n".repeat(40)),
      "https://docs.example/llms.txt": () => text("- [Page](https://docs.example/page.md)"),
      "https://docs.example/openapi.json": () => json({ paths: { "/x": {} } }),
    });

    const page = await fetchPage("https://docs.example/page", impl);

    expect(page.source).toBe("markdown");
    expect(page.text).toContain("Full page");
    // Both facts are still reported, so the model can go back if it wants.
    expect(page.discovered?.map((d) => d.kind).sort()).toEqual(["llms", "markdown", "openapi"]);
  });
});

describe("what must not change", () => {
  it("does not probe an ordinary page that rendered its own body", async () => {
    const impl = responder({ "https://www.example/full": () => html(RICH) });
    const page = await fetchPage("https://www.example/full", impl);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(page.discovered).toBeUndefined();
    expect(page.source).toBeUndefined();
  });

  it("asks a documentation page for its Markdown source even when it returned text", async () => {
    // `docs.bigmodel.cn` extracts thousands of characters of navigation and no
    // API fields at all. Length is not proof that the body rendered, so a
    // documentation-shaped URL is probed for `<page>.md` regardless — and only
    // for that one document, since the index and schema are for the empty case.
    const impl = responder({
      "https://docs.example/guide/install": () => html(RICH),
      "https://docs.example/guide/install.md": () => text("# Install\n\n" + "real body. ".repeat(100)),
    });

    const page = await fetchPage("https://docs.example/guide/install", impl);

    expect(page.source).toBe("markdown");
    expect(page.text).toContain("# Install");
    // One page request plus one `.md` probe; no llms/openapi on this path.
    expect(impl).toHaveBeenCalledTimes(2);
    expect(page.discovered?.map((d) => d.kind)).toEqual(["markdown"]);
  });

  it("leaves a documentation page alone when it has no Markdown source", async () => {
    const impl = responder({ "https://docs.example/guide/install": () => html(RICH) });
    const page = await fetchPage("https://docs.example/guide/install", impl);
    expect(page.source).toBeUndefined();
    expect(page.text).toContain("real documentation body");
  });

  it("does not probe a JSON or text response, however short", async () => {
    for (const [url, response] of [
      ["https://docs.example/openapi.json", () => json({ ok: true })],
      ["https://docs.example/notes.txt", () => text("short")],
    ] as const) {
      const impl = responder({ [url]: response });
      await fetchPage(url, impl);
      expect(impl, url).toHaveBeenCalledTimes(1);
    }
  });

  it("survives every probe failing", async () => {
    // A documentation host that 404s all three is the common case, and it must
    // read as "this page was empty", not as a fetch error.
    const impl = responder({ "https://docs.example/empty": () => html(SHELL) });
    const page = await fetchPage("https://docs.example/empty", impl);
    expect(page.text).toContain("Loading");
    expect(page.discovered).toBeUndefined();
  });

  it("ignores a probe that answers the site's HTML shell instead of a document", async () => {
    // Many SPA hosts answer `/anything.md` with the same index.html. Treating
    // that as a Markdown document would replace a body with the shell again.
    const impl = responder({
      "https://docs.example/page": () => html(SHELL),
      "https://docs.example/page.md": () => html(SHELL),
    });
    const page = await fetchPage("https://docs.example/page", impl);
    expect(page.source).toBeUndefined();
  });

  it("does not recurse: a probe's own sparse HTML is not probed again", async () => {
    // `<page>.md` returns HTML and 404s everywhere else; without the flag the
    // probe would start its own three probes.
    const impl = responder({
      "https://docs.example/page": () => html(SHELL),
      "https://docs.example/page.md": () => html(SHELL),
    });
    await fetchPage("https://docs.example/page", impl);
    expect(impl.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("still refuses a probe that redirects into the private range", async () => {
    // Probes go through the same `fetchPage`, so the SSRF checks apply to them
    // too: a public host answering `<page>.md` with `302 → 169.254.169.254`
    // is dropped like any other forbidden hop.
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://docs.example/page") return html(SHELL);
      if (url === "https://docs.example/page.md") {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

    const page = await fetchPage("https://docs.example/page", impl);
    expect(page.text).toContain("Loading");
    expect(page.source).toBeUndefined();
  });
});
