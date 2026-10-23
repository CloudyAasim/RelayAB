/**
 * tests/integration/moderations-endpoint.test.ts
 *
 * `POST /v1/moderations` — the content moderation surface.
 *
 * A moderation call has no messages and no output tokens: it is a verdict per
 * input. So it gets its own path rather than being a chat call in a hat, and
 * its billing is the one thing the vendor does not report — the prompt's
 * tokens are estimated, the same way a stream that ends without a usage frame
 * is billed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as moderationsPOST } from "@/app/api/v1/moderations/route";

const MODERATION_JSON = JSON.stringify({
  id: "modr-1",
  model: "omni-moderation-latest",
  results: [
    {
      flagged: false,
      categories: { violence: false, hate: false },
      category_scores: { violence: 0.001, hate: 0.0001 },
    },
  ],
});

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: UpstreamCall[] = [];

function stubUpstream(body = MODERATION_JSON, status = 200): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { headers?: Record<string, string>; body?: unknown } = {}) => {
      calls.push({
        url: String(url),
        headers: init.headers ?? {},
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function seed(
  over: Partial<Parameters<typeof createProvider>[0]> = {},
): Promise<{ plain: string; keyId: string }> {
  const user = await createUser({
    username: "mod-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Upstream",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat: "responses",
    modelMapping: { "omni-moderation-latest": "omni-moderation-latest" },
    ...over,
  });
  return { plain: created.plainKey, keyId: created.key.id };
}

function post(plain: string, body: unknown): Promise<Response> {
  return moderationsPOST(
    new Request("http://localhost:3000/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plain}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("the moderation endpoint", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the request and returns the verdict untouched", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await post(plain, {
      model: "omni-moderation-latest",
      input: "a sentence to judge",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; results: Array<{ flagged: boolean }> };
    expect(body.id).toBe("modr-1");
    expect(body.results[0].flagged).toBe(false);

    // The vendor's own endpoint, the vendor's own model name.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.test/v1/moderations");
    expect(calls[0].body).toEqual({
      model: "omni-moderation-latest",
      input: "a sentence to judge",
    });
  });

  it("accepts a list of inputs", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await post(plain, {
      model: "omni-moderation-latest",
      input: ["one", "two"],
    });

    expect(res.status).toBe(200);
    expect(calls[0].body.input).toEqual(["one", "two"]);
  });

  it("bills the prompt's tokens, since the vendor reports none", async () => {
    const { plain, keyId } = await seed();
    stubUpstream();

    await post(plain, { model: "omni-moderation-latest", input: "a sentence to judge" });

    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBeGreaterThan(0);
    expect(rows[0].completionTokens).toBe(0);
    expect(rows[0].status).toBe("success");
  });

  it("refuses a body it cannot forward", async () => {
    const { plain } = await seed();
    stubUpstream();

    // A bad input is named here rather than reported by the vendor in its own
    // words, which costs a round trip to say less.
    const res = await post(plain, { model: "omni-moderation-latest", input: { text: "no" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("does not reach for a provider that has no moderation endpoint", async () => {
    // The Anthropic Messages protocol has no `/moderations`, and there is
    // nothing to translate a verdict into.
    const { plain } = await seed({
      kind: "anthropic",
      upstreamFormat: "anthropic",
      anthropicEnabled: true,
    });
    stubUpstream();

    const res = await post(plain, { model: "omni-moderation-latest", input: "hi" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
