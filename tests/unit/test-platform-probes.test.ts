/**
 * tests/unit/test-platform-probes.test.ts
 *
 * The test platform's server routes: one per shape (chat, media, search, raw).
 *
 * What is pinned here is what the page cannot check from the outside: the
 * outbound URL, the body actually sent, the key only in the Authorization header
 * (never persisted), and the refusal of non-http(s) targets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

async function loginAs(store: InMemoryCookieStore, userId: string, username: string): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = userId;
  s.username = username;
  s.role = "user";
  await s.save();
}

async function signIn(): Promise<void> {
  const user = await createUser({ username: `probe-${Date.now()}`, password: "longenoughpw" });
  currentStore = new InMemoryCookieStore();
  await loginAs(currentStore, user.id, user.username);
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/models/probe-chat", () => {
  it("requires a session", async () => {
    currentStore = new InMemoryCookieStore();
    const { POST } = await import("@/app/api/models/probe-chat/route");
    const res = await POST(jsonRequest("/api/models/probe-chat", { baseUrl: "https://x/v1", apiKey: "k", model: "m" }));
    expect(res.status).toBe(401);
  });

  it("sends the parameters to {base}/chat/completions and reports the endpoint", async () => {
    await signIn();
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "PONG" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/models/probe-chat/route");
    const res = await POST(
      jsonRequest("/api/models/probe-chat", {
        baseUrl: "https://probe.example/v1/",
        apiKey: "sk-ephemeral",
        model: "m1",
        prompt: "Say PONG",
        stream: false,
        parameters: { temperature: 0.2, presence_penalty: 0 },
      }),
    );
    const json = (await res.json()) as { ok: boolean; data: { endpoint: string; json: unknown } };

    expect(seen[0]?.url).toBe("https://probe.example/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("m1");
    expect(seen[0]?.body.stream).toBe(false);
    expect(seen[0]?.body).toMatchObject({ temperature: 0.2, presence_penalty: 0 });
    expect(seen[0]?.auth).toBe("Bearer sk-ephemeral");
    expect(json.data.endpoint).toBe("https://probe.example/v1/chat/completions");
  });

  it("passes a stream through instead of buffering it", async () => {
    await signIn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"PO"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const { POST } = await import("@/app/api/models/probe-chat/route");
    const res = await POST(
      jsonRequest("/api/models/probe-chat", {
        baseUrl: "https://probe.example/v1",
        apiKey: "k",
        model: "m1",
        prompt: "hi",
        stream: true,
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("data: [DONE]");
  });

  it("refuses a non-http endpoint", async () => {
    await signIn();
    const { POST } = await import("@/app/api/models/probe-chat/route");
    const res = await POST(
      jsonRequest("/api/models/probe-chat", { baseUrl: "file:///etc/passwd", apiKey: "k", model: "m" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/models/probe-media", () => {
  it("uses the image endpoint and returns a data URL for binary answers", async () => {
    await signIn();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const { POST } = await import("@/app/api/models/probe-media/route");
    const res = await POST(
      jsonRequest("/api/models/probe-media", {
        capability: "image.generate",
        baseUrl: "https://vendor.example/v1",
        apiKey: "k",
        model: "img-1",
        prompt: "a cat",
      }),
    );
    const json = (await res.json()) as { data: { endpoint: string; dataUrl: string } };
    expect(seen[0]).toBe("https://vendor.example/v1/images/generations");
    expect(json.data.endpoint).toBe("https://vendor.example/v1/images/generations");
    expect(json.data.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("sends speech-to-text as multipart", async () => {
    await signIn();
    let multipart = false;
    let method = "";
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      multipart = init?.body instanceof FormData;
      method = init?.method ?? "";
      return new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/models/probe-media/route");
    await POST(
      jsonRequest("/api/models/probe-media", {
        capability: "audio.stt",
        baseUrl: "https://vendor.example/v1",
        apiKey: "k",
        model: "whisper-1",
        dataUrl: "data:audio/wav;base64,AAAA",
      }),
    );
    expect(method).toBe("POST");
    // The browser/fetch sets the multipart boundary itself; the route must not
    // set a content-type by hand or the boundary is lost.
    expect(multipart).toBe(true);
  });
});

describe("POST /api/models/probe-search", () => {
  it("asks searxng via GET with q and format=json", async () => {
    await signIn();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/models/probe-search/route");
    await POST(
      jsonRequest("/api/models/probe-search", {
        kind: "searxng",
        baseUrl: "http://relay-search.web:8080",
        query: "hello",
      }),
    );
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("hello");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("asks tavily with its documented body", async () => {
    await signIn();
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { POST } = await import("@/app/api/models/probe-search/route");
    await POST(
      jsonRequest("/api/models/probe-search", {
        kind: "tavily",
        baseUrl: "https://api.tavily.com/search",
        apiKey: "tvly-x",
        query: "hello",
        limit: 3,
      }),
    );
    expect(body).toMatchObject({ api_key: "tvly-x", query: "hello", max_results: 3 });
  });
});

describe("POST /api/models/probe-raw", () => {
  it("sends the method, URL and body exactly as given", async () => {
    await signIn();
    const seen: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "", body: String(init?.body ?? "") });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });

    const { POST } = await import("@/app/api/models/probe-raw/route");
    const res = await POST(
      jsonRequest("/api/models/probe-raw", {
        method: "PUT",
        url: "https://vendor.example/v1/anything",
        headers: { "X-Test": "1" },
        body: '{"a":1}',
      }),
    );
    const json = (await res.json()) as { data: { status: number; text: string } };
    expect(seen[0]).toMatchObject({ method: "PUT", body: '{"a":1}' });
    expect(json.data.status).toBe(200);
    expect(json.data.text).toContain("ok");
  });

  it("refuses a non-http URL", async () => {
    await signIn();
    const { POST } = await import("@/app/api/models/probe-raw/route");
    const res = await POST(jsonRequest("/api/models/probe-raw", { method: "GET", url: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
  });
});
