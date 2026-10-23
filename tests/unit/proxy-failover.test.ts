/**
 * tests/unit/proxy-failover.test.ts
 *
 * The whole point of failover, end to end: **one upstream is down, the
 * request still succeeds, and the owner is charged once.**
 *
 * The charging is the part worth proving. Usage is settled after a successful
 * response, so a failed attempt never reaches it — but that is a property of
 * the code, not a law, and a change that moved the settlement earlier would
 * silently start charging people for requests that failed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import { resetBreakers } from "@/lib/proxy/selection";
import type { ApiKey } from "@/lib/db/types";

const MODEL = "gpt-4o-mini";

/** A provider that serves `MODEL`, with a price so the charging is visible. */
async function makeProvider(name: string, priority: number, weight = 0): Promise<string> {
  const p = await createProvider({
    name,
    kind: "openai",
    apiKey: `sk-upstream-${name}`,
    priority,
    weight,
    modelConfigs: {
      [MODEL]: {
        clientId: MODEL,
        upstreamId: `${MODEL}-2024-07-18`,
        inputCost: 15,
        outputCost: 60,
      },
    },
    modelMapping: { [MODEL]: `${MODEL}-2024-07-18` },
  });
  return p.id;
}

async function setupUserAndKey(): Promise<{ key: ApiKey; userId: string }> {
  const u = await createUser({
    username: "failover-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const result = await createApiKey({ userId: u.id, label: "l" });
  return { key: result.key, userId: u.id };
}

/** The body a healthy upstream answers with. */
function okBody(): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe("failover, end to end", () => {
  beforeEach(() => {
    __resetDbForTest();
    resetBreakers();
  });

  it("serves the request from the second provider when the first is down", async () => {
    const { key, userId } = await setupUserAndKey();
    await makeProvider("first", 1);
    await makeProvider("second", 2);

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      // The first provider is the one that is down.
      if (String(url).includes("api.openai.com")) {
        return new Response("upstream exploded", { status: 500 });
      }
      return new Response(JSON.stringify(okBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await proxyChatCompletion({
      req: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: (p) => (p.name === "first" ? "https://api.openai.com/v1" : "https://backup.example/v1"),
      },
    });

    expect(result.ok).toBe(true);
    // Both were tried: the dead one first, then the one that worked.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("charges the owner once, for the provider that served it", async () => {
    const { key, userId } = await setupUserAndKey();
    await makeProvider("first", 1);
    await makeProvider("second", 2);

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.openai.com")) {
        return new Response("upstream exploded", { status: 500 });
      }
      return new Response(JSON.stringify(okBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await proxyChatCompletion({
      req: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: (p) => (p.name === "first" ? "https://api.openai.com/v1" : "https://backup.example/v1"),
      },
    });

    const rows = await listUsageByKey(key.id);
    const served = rows.filter((r) => r.status === "success");
    const failed = rows.filter((r) => r.status === "error");
    // One successful call — and one recorded failure, which is free: a failed
    // attempt is worth keeping in the log for the audit trail, but it costs
    // the owner nothing.
    expect(served).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].creditsUsed).toBe(0);
    // And the pool moved by exactly what one call costs — not two.
    const after = await getUserById(userId);
    expect(after!.quotaUsed).toBe(served[0].creditsUsed);
    expect(after!.quotaUsed).toBeGreaterThan(0);
  });

  it("does not try a second provider when the request itself was refused", async () => {
    const { key, userId } = await setupUserAndKey();
    await makeProvider("first", 1);
    await makeProvider("second", 2);

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "bad parameter" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await proxyChatCompletion({
      req: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: (p) => (p.name === "first" ? "https://api.openai.com/v1" : "https://backup.example/v1"),
      },
    });

    expect(result.ok).toBe(false);
    // A 400 is about the request. Another provider would answer the same.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The refusal is recorded, and it is free.
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].creditsUsed).toBe(0);
    expect((await getUserById(userId))!.quotaUsed).toBe(0);
  });
});
