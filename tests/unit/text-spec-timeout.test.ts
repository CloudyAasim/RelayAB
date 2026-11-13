/**
 * tests/unit/text-spec-timeout.test.ts
 *
 * `limits.timeoutMs` in the **text** protocol used to be decoration: validated on
 * save, read by nothing. Media and search enforced theirs; a text provider whose
 * upstream never answered held the request open until the client gave up
 * (2026-11-13, 08 §90.3).
 *
 * Two behaviours are pinned here:
 *
 *   1. a silent upstream is abandoned at the spec's deadline;
 *   2. the deadline covers the wait for **headers**, not the stream — a response
 *      that has started arriving is never cut by it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { POST as chatPOST } from "@/app/api/v1/chat/completions/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function seed(timeoutMs?: number): Promise<{ plain: string }> {
  const user = await createUser({
    username: "t-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 100_000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Slow Text",
    kind: "openai",
    baseUrl: "https://text.test",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { m: "up" },
    ...(timeoutMs !== undefined
      ? {
          textSpecs: [
            JSON.stringify({
              specVersion: 1,
              protocol: "openai-chat",
              limits: { timeoutMs },
            }),
          ],
          activeMode: "advanced" as const,
        }
      : {}),
  });
  return { plain: created.plainKey };
}

function chatRequest(plain: string): Request {
  return new Request("http://localhost:3000/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("the text spec's limits.timeoutMs", () => {
  beforeEach(() => {
    __resetDbForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abandons an upstream that never answers, at the declared deadline", async () => {
    const { plain } = await seed(80);
    let sawSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: { signal?: AbortSignal } = {}) => {
        sawSignal = init.signal;
        // Silent forever, but abortable — exactly what a hung vendor looks like.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );

    const started = Date.now();
    const res = await chatPOST(chatRequest(plain));
    const elapsed = Date.now() - started;

    expect(sawSignal, "the deadline was never passed to fetch").toBeDefined();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(2_000);
  });

  it("does not cut an answer that has started arriving", async () => {
    const { plain } = await seed(80);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "c1",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const res = await chatPOST(chatRequest(plain));
    expect(res.status).toBe(200);
    // The timer was cleared when the headers arrived; waiting past the deadline
    // must not turn a delivered body into an abort.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await res.json()).choices[0].message.content).toBe("done");
  });

  it("invents no deadline when the spec declares none", async () => {
    const { plain } = await seed();
    let sawSignal: AbortSignal | undefined;
    let seen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { signal?: AbortSignal } = {}) => {
        seen = true;
        sawSignal = init.signal;
        return new Response(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await chatPOST(chatRequest(plain));
    expect(res.status).toBe(200);
    expect(seen).toBe(true);
    // Whatever signal it got is the client's (a request always has one); what it
    // must not have is a timer that fires on its own.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sawSignal?.aborted).toBe(false);
  });
});

describe("wired into every text surface", () => {
  it("each surface's upstream fetch goes through the deadline helper", () => {
    // Chat is covered behaviourally above; the other three are pinned by source
    // so a later refactor cannot quietly restore the old behaviour there.
    const files = [
      ["src", "lib", "proxy", "dialects", "chat.ts"],
      ["src", "lib", "proxy", "dialects", "responses.ts"],
      ["src", "lib", "proxy", "dialects", "gemini.ts"],
      ["src", "lib", "proxy", "anthropic.ts"],
    ];
    for (const parts of files) {
      const src = readFileSync(join(process.cwd(), ...parts), "utf8");
      expect(src, parts.join("/")).toContain("upstreamDeadline(signal");
    }
  });
});
