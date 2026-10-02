/**
 * tests/unit/assistant-web-fetch.test.ts
 *
 * `fetch_page` — the assistant reading a public web page.
 *
 * Most of this file is about the addresses it must never reach, because a
 * relay that is publicly reachable and lets a caller name a URL is a proxy
 * into whatever the host can see: its cloud metadata endpoint, its own
 * database, whatever it has on localhost. A model that asks for those is not
 * an attacker, which is exactly why the check cannot be "would a user do
 * this".
 *
 * The tests use a stub fetch and a stub resolver, so nothing here touches the
 * network — the point is which URLs are refused *before* a request is made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPrivateAddress,
  assertPublicHost,
  htmlToText,
  fetchPage,
  WebFetchError,
  MAX_FETCH_BYTES,
} from "@/lib/assistant/web-fetch";
import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import { ADMIN_SYSTEM_PROMPT, USER_SYSTEM_PROMPT } from "@/lib/assistant/prompts";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    // Anything not listed below resolves to a public address, so a test that
    // is about something else does not have to think about DNS.
    const table: Record<string, string[]> = {
      "public.example": ["93.184.216.34"],
      "rebind.example": ["93.184.216.34"],
      "dual.example": ["93.184.216.34", "127.0.0.1"],
      "private.example": ["10.1.2.3"],
      "v6-local.example": ["fd00::1"],
      "maps-v4.example": ["::ffff:169.254.169.254"],
    };
    const addresses = table[hostname];
    if (!addresses) throw new Error(`no such host: ${hostname}`);
    return addresses.map((address) => ({ address, family: 4 }));
  }),
}));

const TOOLS_SOURCE = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

/** A stub that fails the test if it is ever asked for a blocked address. */
function guardedFetch(handler?: (url: string) => Response) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (/127\.|10\.|192\.168\.|169\.254\.|localhost|0\.0\.0\.0|\[?::1\]?/i.test(url)) {
      throw new Error(`the test made a request to a blocked address: ${url}`);
    }
    return handler ? handler(url) : new Response("ok", { headers: { "content-type": "text/plain" } });
  });
}

describe("addresses a request must never reach", () => {
  it("refuses loopback, in every spelling", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "0:0:0:0:0:0:0:1", "::"]) {
      expect(isPrivateAddress(a), `${a} should be refused`).toBe(true);
    }
  });

  it("refuses the private ranges", () => {
    for (const a of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isPrivateAddress(a), `${a} should be refused`).toBe(true);
    }
  });

  it("refuses link-local, which is where cloud metadata lives", () => {
    // 169.254.169.254 is how a hosted process reads its instance credentials.
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("refuses carrier NAT and the benchmarking range", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
  });

  it("refuses multicast, reserved and broadcast", () => {
    for (const a of ["224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1"]) {
      expect(isPrivateAddress(a), `${a} should be refused`).toBe(true);
    }
  });

  it("refuses unique-local and link-local IPv6", () => {
    for (const a of ["fd00::1", "fc00::1", "fe80::1", "fe80::abcd", "ff02::1"]) {
      expect(isPrivateAddress(a), `${a} should be refused`).toBe(true);
    }
  });

  it("sees through an IPv4 address wearing an IPv6 costume", () => {
    // `::ffff:127.0.0.1` is a loopback request, and NAT64 (`64:ff9b::`) is a
    // way to make one. Neither is a public destination.
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    for (const a of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPrivateAddress(a), `${a} should be allowed`).toBe(false);
    }
  });

  it("refuses something that is not an address at all", () => {
    // Guessing is the failure mode; a name that will not parse is refused.
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("hosts, before a request is made", () => {
  it("refuses a literal private address without asking DNS", async () => {
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(WebFetchError);
  });

  it("refuses a name that resolves into the private range", async () => {
    await expect(assertPublicHost("private.example")).rejects.toThrow(/内网/);
  });

  it("refuses a name with even one private answer", async () => {
    // The dangerous case: a host that will hand you whichever address you let
    // it pick, and a resolver that returns the public one first.
    await expect(assertPublicHost("dual.example")).rejects.toThrow(/内网/);
  });

  it("refuses an IPv4-mapped answer", async () => {
    await expect(assertPublicHost("maps-v4.example")).rejects.toThrow(/内网/);
  });

  it("refuses a name that does not resolve", async () => {
    await expect(assertPublicHost("nowhere.example")).rejects.toThrow(/解析不了/);
  });

  it("allows a name that resolves publicly", async () => {
    await expect(assertPublicHost("public.example")).resolves.toBeUndefined();
  });
});

describe("what fetch_page will and will not do", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a public page", async () => {
    const impl = guardedFetch(() => new Response("hello", { headers: { "content-type": "text/plain" } }));
    const page = await fetchPage("https://public.example/docs", impl as unknown as typeof fetch);
    expect(page.text).toBe("hello");
    expect(page.status).toBe(200);
  });

  it("refuses a loopback URL and never dials it", async () => {
    const impl = guardedFetch();
    await expect(fetchPage("http://127.0.0.1:3000/admin", impl as unknown as typeof fetch)).rejects.toThrow(
      /内网/,
    );
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses the cloud metadata address by name as well as by literal", async () => {
    const impl = guardedFetch();
    await expect(
      fetchPage("http://169.254.169.254/latest/meta-data/", impl as unknown as typeof fetch),
    ).rejects.toThrow(/内网/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses a non-web scheme", async () => {
    const impl = guardedFetch();
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "gopher://public.example/",
      "ftp://public.example/x",
    ]) {
      await expect(fetchPage(url, impl as unknown as typeof fetch), url).rejects.toThrow(/http/);
    }
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses credentials in the URL", async () => {
    const impl = guardedFetch();
    await expect(
      fetchPage("http://user:secret@public.example/", impl as unknown as typeof fetch),
    ).rejects.toThrow(/用户名或密码/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves into the private range, without dialling it", async () => {
    const impl = guardedFetch();
    await expect(
      fetchPage("https://private.example/secret", impl as unknown as typeof fetch),
    ).rejects.toThrow(/内网/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("checks a redirect target too, which is the one that is usually missed", async () => {
    // Following `Location` with the platform's own handling re-checks nothing,
    // so a public host answering 302 → 169.254.169.254 walks past every guard.
    const impl = guardedFetch(() =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } }),
    );
    await expect(fetchPage("https://public.example/go", impl as unknown as typeof fetch)).rejects.toThrow(
      /内网/,
    );
  });

  it("follows a redirect that stays on the public internet", async () => {
    const impl = guardedFetch((url) =>
      url.endsWith("/go")
        ? new Response(null, { status: 301, headers: { location: "https://public.example/final" } })
        : new Response("arrived", { headers: { "content-type": "text/plain" } }),
    );
    const page = await fetchPage("https://public.example/go", impl as unknown as typeof fetch);
    expect(page.text).toBe("arrived");
    expect(page.finalUrl).toBe("https://public.example/final");
  });

  it("stops after too many redirects", async () => {
    const impl = guardedFetch(() =>
      new Response(null, { status: 302, headers: { location: "https://public.example/loop" } }),
    );
    await expect(fetchPage("https://public.example/loop", impl as unknown as typeof fetch)).rejects.toThrow(
      /重定向超过/,
    );
  });

  it("refuses a binary response with a readable reason", async () => {
    const impl = guardedFetch(
      () => new Response(new Uint8Array(8), { headers: { "content-type": "image/png" } }),
    );
    await expect(fetchPage("https://public.example/a.png", impl as unknown as typeof fetch)).rejects.toThrow(
      /不是可以阅读的网页/,
    );
  });

  it("stops reading at the cap and says so", async () => {
    const huge = "x".repeat(MAX_FETCH_BYTES + 50_000);
    const impl = guardedFetch(() => new Response(huge, { headers: { "content-type": "text/plain" } }));
    const page = await fetchPage("https://public.example/big", impl as unknown as typeof fetch);
    expect(page.truncated).toBe(true);
    expect(page.bytes).toBeLessThanOrEqual(MAX_FETCH_BYTES + 8192);
  });

  it("asks the platform not to follow redirects for it", async () => {
    // Load-bearing in a way the behavioural tests above cannot see, because a
    // stubbed fetch ignores the option. With `follow`, the platform resolves
    // `Location` itself: the host check runs once, for the first URL, and
    // `302 Location: http://169.254.169.254/` walks straight past it.
    const impl = guardedFetch(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    await fetchPage("https://public.example/docs", impl as unknown as typeof fetch);
    const init = impl.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.redirect).toBe("manual");
  });

  it("reports a 404 as a fact rather than a crash", async () => {
    const impl = guardedFetch(() => new Response("nope", { status: 404 }));
    await expect(fetchPage("https://public.example/gone", impl as unknown as typeof fetch)).rejects.toThrow(
      /没有内容/,
    );
  });
});

describe("a documentation page, as the model receives it", () => {
  it("drops the script and style, whose contents only look like content", () => {
    const html = `<html><head><style>body{color:red}</style><script>var a=1;</script></head>
      <body><h1>Image generation</h1><p>Send a <code>prompt</code>.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Image generation");
    expect(text).toContain("prompt");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var a=1");
  });

  it("keeps block structure, so it is not one run-on line", () => {
    const html = "<ul><li>first</li><li>second</li></ul>";
    const text = htmlToText(html);
    expect(text.split("\n")).toEqual(["first", "second"]);
  });

  it("decodes the entities that would otherwise arrive as their own names", () => {
    expect(htmlToText("<p>a &amp; b &lt;tag&gt;</p>")).toBe("a & b <tag>");
  });

  it("drops comments", () => {
    // The point is the comment, not the words around it — and they must not be
    // welded together either, or the text reads as one token.
    expect(htmlToText("<p>keep<!-- drop this -->this</p>")).toBe("keep this");
  });
});

describe("the tool, through the same path a turn uses", () => {
  it("is offered to both tiers", () => {
    // Reading a vendor's documentation is not an administrative act, and the
    // model that cannot check a spec is the model that guesses one.
    for (const tier of [true, false]) {
      expect(toolDefinitions(tier).map((t) => t.function.name), `tier ${tier}`).toContain("fetch_page");
    }
  });

  it("returns a refusal as a result, so the turn survives it", async () => {
    // "That URL is on the private network" is something the model can report.
    // An exception would end the turn and lose whatever it had established.
    const result = await executeTool("fetch_page", JSON.stringify({ url: "http://127.0.0.1:3000/" }), {
      user: { id: "u1", username: "u", role: "user", timezone: "shanghai" },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/内网/);
  });

  it("refuses with no url at all", async () => {
    const result = await executeTool("fetch_page", "{}", {
      user: { id: "u1", username: "u", role: "user", timezone: "shanghai" },
    } as never);
    expect(result.ok).toBe(false);
  });
});

describe("the prompt tells the model what it can and cannot do", () => {
  it("says to look documentation up rather than recall it", () => {
    for (const prompt of [ADMIN_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/fetch_page/);
      expect(prompt).toMatch(/不要凭记忆/);
    }
  });

  it("admits there is no search engine", () => {
    // The one thing this cannot do. Saying "let me search" when there is no
    // search is the same class of lie as "I have already configured it".
    for (const prompt of [ADMIN_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/没有搜索引擎/);
      expect(prompt).toMatch(/不要说「我搜索一下」/);
    }
  });

  it("puts documentation ahead of a configuration change", () => {
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/查官方文档[\s\S]{0,80}再回答，再决定要不要提变更/);
  });

  it("has a tool description that says the same at the moment of the call", () => {
    expect(TOOLS_SOURCE).toMatch(/name: "fetch_page"[\s\S]{0,400}先调它再回答/);
  });
});
