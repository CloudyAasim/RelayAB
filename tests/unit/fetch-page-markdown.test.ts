/**
 * tests/unit/fetch-page-markdown.test.ts
 *
 * The fetch endpoint, and the Markdown it hands back.
 *
 * Two things are being pinned here, and they are the two halves of one
 * promise:
 *
 *  - **the page comes back as Markdown.** The other fetch APIs return
 *    Markdown, and for a reader it is not a formatting preference: a heading
 *    says what a section is, a link says where something else is, a list says
 *    what belongs together. Stripped text turns a documentation page into a
 *    wall of sentences.
 *  - **only public pages come back.** The endpoint takes a URL from the
 *    caller and the gateway makes the request, so a URL pointing inside a
 *    network — or at a cloud metadata address — is a way to read the host's
 *    own internals. The check is on the *resolved* addresses, because
 *    "localhost" and "127.0.0.1.nip.io" are the same request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { htmlToMarkdown } from "@/lib/assistant/web-markdown";

/**
 * The resolver, faked.
 *
 * The address a hostname answers with is the thing the guard is about, and a
 * test that really resolves `docs.example` would be a test that depends on
 * the internet.
 */
const dns = vi.hoisted(() => ({ addresses: ["93.184.216.34"] }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => dns.addresses.map((address) => ({ address, family: 4 })),
}));

import { POST } from "@/app/api/v1/fetch/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";

let plainKey = "";

const PAGE = `<!doctype html>
<html><head><title>图像生成 API</title><style>body{color:red}</style></head>
<body>
  <nav><a href="/">首页</a></nav>
  <h1>图像生成 API</h1>
  <p>用 <strong>GLM-Image</strong> 从文本生成图像，支持 <code>image-01</code> 模型。</p>
  <h2>请求参数</h2>
  <ul><li>prompt：文本提示</li><li>size：尺寸</li></ul>
  <ol><li>第一步</li><li>第二步</li></ol>
  <pre><code class="language-json">{"model": "image-01"}</code></pre>
  <p>详见 <a href="https://docs.example/ref">接口参考</a> &amp; 常见问题。</p>
</body></html>`;

beforeEach(async () => {
  __resetDbForTest();
  dns.addresses = ["93.184.216.34"];
  const user = await createUser({
    username: "fetcher",
    password: "pw-123456",
    role: "user",
    quotaType: "credits",
    quotaLimit: 100_000,
  });
  const key = await createApiKey({ userId: user.id, label: "test" });
  plainKey = key.plainKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPage(body: string, contentType = "text/html; charset=utf-8") {
  const impl = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType } }),
  );
  vi.stubGlobal("fetch", impl);
  return impl;
}

function post(body: unknown, key = plainKey): Promise<Response> {
  return POST(
    new Request("https://api.example/v1/fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("the page comes back as Markdown", () => {
  it("with its structure", () => {
    const markdown = htmlToMarkdown(PAGE);
    expect(markdown).toContain("# 图像生成 API");
    expect(markdown).toContain("## 请求参数");
    // A list is a list, not a run-on sentence.
    expect(markdown).toContain("- prompt：文本提示");
    expect(markdown).toContain("1. 第一步");
    // And the code keeps its fence and its language.
    expect(markdown).toContain('```json');
    expect(markdown).toContain('{"model": "image-01"}');
  });

  it("with its links and its emphasis", () => {
    const markdown = htmlToMarkdown(PAGE);
    expect(markdown).toContain("[接口参考](https://docs.example/ref)");
    expect(markdown).toContain("**GLM-Image**");
    expect(markdown).toContain("`image-01`");
  });

  it("and without the parts that are not content", () => {
    const markdown = htmlToMarkdown(PAGE);
    // The stylesheet's text and the page's own furniture are not content.
    expect(markdown).not.toContain("color:red");
    expect(markdown).not.toContain("<style");
    expect(markdown).not.toContain("<nav");
  });

  it("and the entities are decoded", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt;c&gt;</p>")).toContain("a & b <c>");
  });
});

describe("the endpoint", () => {
  it("hands the page back as Markdown", async () => {
    stubPage(PAGE);
    const res = await post({ url: "https://docs.example/images" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      url: string;
      finalUrl: string;
      title?: string;
      content: string;
      truncated: boolean;
    };
    expect(body.title).toBe("图像生成 API");
    expect(body.content).toContain("# 图像生成 API");
    expect(body.content).toContain("**GLM-Image**");
    expect(body.finalUrl).toBe("https://docs.example/images");
    expect(body.truncated).toBe(false);
  });

  it("refuses a request with no key", async () => {
    stubPage(PAGE);
    const res = await post({ url: "https://docs.example/images" }, "sk-relay-not-a-real-key");
    expect(res.status).toBe(401);
  });

  it("refuses a request with no url", async () => {
    stubPage(PAGE);
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it("refuses a page that resolves to an address inside the network", async () => {
    // The host answers with a private address: the request must never be made.
    dns.addresses = ["169.254.169.254"];
    const impl = stubPage(PAGE);
    const res = await post({ url: "https://metadata.example/latest" });
    expect(res.status).toBe(403);
    // And nothing was fetched — refusing after the request would be too late.
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses a scheme that is not http", async () => {
    stubPage(PAGE);
    const res = await post({ url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });
});
