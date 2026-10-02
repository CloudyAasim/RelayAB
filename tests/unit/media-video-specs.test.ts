/**
 * tests/unit/media-video-specs.test.ts
 *
 * Two gaps in the shipped video specs, both found by running the live
 * endpoint rather than by reading the spec:
 *
 *  1. `MINIMAX_VIDEO_V2_SPEC` had no `ratio` in its request mapping, so a
 *     caller supplying a perfectly good ratio had it dropped before the
 *     request left, and MiniMax answered
 *     "必须显式指定 ratio 且不能为 adaptive". The field was accepted by the
 *     gateway and then thrown away.
 *  2. Token Plan exhaustion (status 2067) answers 2xx with an empty
 *     `task_id`, so it used to fall through to the generic no-task-id branch
 *     and read like a permissions problem. It is a billing ceiling.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { executeMedia } from "@/lib/media/engine";
import {
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
} from "@/lib/media/seeds";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { MediaProvider } from "@/lib/media/spec";

afterEach(() => vi.unstubAllGlobals());

function provider(): MediaProvider {
  return {
    id: "p1",
    name: "V",
    baseUrl: "https://v.example",
    encryptedApiKey: encryptSecret("k"),
    enabled: true,
    priority: 0,
    models: { m: { upstreamId: "m", enabled: true } },
    specs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MediaProvider;
}

describe("video V2 spec", () => {
  it("forwards a supplied ratio to the upstream", async () => {
    let sent: unknown = null;
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      // The submit call is the one whose body proves the mapping; the poll
      // that follows needs a terminal state or the call never converges.
      if (calls === 1) {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ task_id: "t1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ task: { status: "succeeded", content: { url: "https://cdn/v.mp4" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const out = await executeMedia({
      spec: { ...MINIMAX_VIDEO_V2_SPEC, models: ["m"] } as never,
      provider: provider(),
      input: { model: "m", prompt: "a cat", duration: 6, ratio: "21:9" } as never,
    });

    // The point of the test: the field survives the mapping.
    expect(sent).toMatchObject({ ratio: "21:9", duration: 6 });
    expect(out.ok).toBe(true);
  });

  it("declares the durations and ratios the vendor accepts", () => {
    const meta = MINIMAX_VIDEO_V2_SPEC.metadata as Record<string, unknown>;
    expect(meta.durations).toEqual([6, 10]);
    expect(meta.ratios).toContain("16:9");
  });
});

describe("video V1 spec", () => {
  it("names Token Plan exhaustion instead of calling it a missing task", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          task_id: "",
          base_resp: {
            status_code: 2067,
            status_msg: "当前已达到 Token Plan 用量上限",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const out = await executeMedia({
      spec: { ...MINIMAX_VIDEO_V1_SPEC, models: ["m"] } as never,
      provider: provider(),
      input: { model: "m", prompt: "a cat", duration: 6 } as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    // 2067 is a billing ceiling, not a permissions failure.
    expect(out.error.code).toBe("upstream_credit_exhausted");
    expect(out.error.status).toBe(402);
  });

  it("declares the durations the vendor accepts", () => {
    const meta = MINIMAX_VIDEO_V1_SPEC.metadata as Record<string, unknown>;
    expect(meta.durations).toEqual([6, 10]);
  });
});
