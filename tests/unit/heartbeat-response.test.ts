/**
 * tests/unit/heartbeat-response.test.ts
 *
 * A six-minute generation produces no bytes for six minutes, and every proxy in
 * between measures *idle* time. This is the wrapper that keeps the connection
 * fed, and the three behaviours that matter are here:
 *
 *   1. a fast call keeps its real status and body (no streaming at all);
 *   2. a slow call emits whitespace — JSON-significant, so the body still parses
 *      as the same document — and says so in a header;
 *   3. a call that fails after the threshold arrives as an error envelope inside
 *      that 200, which is the documented trade-off.
 */
import { describe, it, expect } from "vitest";
import { respondWithHeartbeat } from "@/lib/http/heartbeat";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("respondWithHeartbeat", () => {
  it("passes a fast answer straight through, status and all", async () => {
    const res = await respondWithHeartbeat(Promise.resolve(json({ ok: true })), {
      afterMs: 5_000,
      intervalMs: 50,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Relay-Heartbeat")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("keeps an error status for a fast failure", async () => {
    const res = await respondWithHeartbeat(
      Promise.resolve(json({ error: { code: "bad_request" } }, 400)),
      { afterMs: 5_000, intervalMs: 50 },
    );
    expect(res.status).toBe(400);
  });

  it("feeds the connection once the call goes slow, and the body still parses", async () => {
    const slow = new Promise<Response>((resolve) => setTimeout(() => resolve(json({ n: 1 })), 120));
    const res = await respondWithHeartbeat(slow, { afterMs: 20, intervalMs: 25 });

    expect(res.headers.get("X-Relay-Heartbeat")).toBe("1");
    // Without these two the beats are buffered by the app's gzip or by nginx's
    // proxy_buffering and arrive when the response ends — which is too late.
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(res.headers.get("Cache-Control")).toContain("no-transform");
    expect(res.status).toBe(200);

    const text = await res.text();
    // Whitespace first — that is the keep-alive — then the document.
    expect(text.startsWith(" ")).toBe(true);
    // Leading whitespace is legal JSON, which is why this works at all.
    expect(JSON.parse(text)).toEqual({ n: 1 });
  });

  it("surfaces a failure that happens after the threshold as an error envelope", async () => {
    const failing = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error("upstream died")), 120),
    );
    const res = await respondWithHeartbeat(failing, { afterMs: 20, intervalMs: 25 });

    // 200 is the documented cost of committing headers before the work is done.
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("upstream died");
  });
});
