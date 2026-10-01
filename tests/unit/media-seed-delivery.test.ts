/**
 * tests/unit/media-seed-delivery.test.ts
 *
 * The shipped `MINIMAX_TTS_SPEC` mapped its audio to a `kind: "url"` item while
 * asking the vendor for `output_format: "url"`. `/v1/audio/speech` has to answer
 * with bytes, and `audioDelivery` accepts only a binary body or a `base64` item
 * — so a synthesis that succeeded upstream was discarded and the client got
 * 502 `no_audio`.
 *
 * The repository already ships a judge for exactly this shape
 * (`scripts/spec-check.ts`, `public/spec-check.html`, and the case in
 * `spec-check-standalone.test.ts` whose comment cites this incident). The gap
 * was that nothing ever ran the judge over the seeds that ship in the box.
 *
 * This test closes that gap for the capability that can silently fail, by
 * driving the real engine with the real seed rather than a hand-written copy
 * of it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { executeMedia, buildMediaScope } from "@/lib/media/engine";
import { audioDelivery } from "@/lib/media/handler";
import { MINIMAX_TTS_SPEC } from "@/lib/media/seeds";
import type { MediaProvider } from "@/lib/media/spec";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p1",
  name: "MiniMax Speech",
  baseUrl: "https://api.minimaxi.com",
  encryptedApiKey: encryptSecret("vendor-key"),
  enabled: true,
  priority: 1,
  models: { "speech-2.8-hd": { upstreamId: "speech-2.8-hd", pricePerItem: 1, enabled: true } },
  specs: [MINIMAX_TTS_SPEC],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as MediaProvider;

/** The hex a `t2a_v2` call with `output_format: "hex"` actually returns. */
const UPSTREAM_HEX = "49443304000000fffb90c4"; // "ID3\x04…"

function stubT2aV2(captured: string[]) {
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({ data: { audio: UPSTREAM_HEX, status: 2 }, base_resp: { status_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shipped MiniMax TTS seed", () => {
  it("asks the vendor for hex rather than a link", () => {
    // A URL artefact is unusable for this endpoint, so the request must not
    // ask for one in the first place.
    expect(JSON.stringify(MINIMAX_TTS_SPEC.request)).toContain('"hex"');
    expect(JSON.stringify(MINIMAX_TTS_SPEC.request)).not.toContain('"url"');
  });

  it("yields bytes the speech endpoint can hand back", async () => {
    const captured: string[] = [];
    stubT2aV2(captured);

    const out = await executeMedia({
      spec: MINIMAX_TTS_SPEC,
      provider,
      input: buildMediaScope({ model: "speech-2.8-hd", input: "hello", voice: "English_Trustworth_Man" }),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const delivery = audioDelivery(out.result, "mp3");
    expect(delivery).not.toBeNull();
    if (!delivery || delivery.kind !== "bytes") return;

    // "ID3" is the MP3 frame header, so the hex really was decoded rather than
    // passed through.
    expect(Array.from(delivery.bytes.slice(0, 3))).toEqual([0x49, 0x44, 0x33]);
    expect(delivery.contentType).toBe("audio/mpeg");

    // And the request that produced it asked for hex.
    expect(captured[0]).toContain('"output_format":"hex"');
  });

  it("never maps a URL item on an audio.tts capability", () => {
    // The invariant, stated once so a future edit cannot reintroduce it by
    // another route: this endpoint answers with bytes, and only a base64 item
    // or a binary body can satisfy that.
    const items = (MINIMAX_TTS_SPEC.response as { items?: unknown }).items;
    expect(Array.isArray(items)).toBe(true);
    for (const item of (items ?? []) as Array<{ kind?: string; encoding?: string }>) {
      expect(item.kind).toBe("base64");
      expect(item.encoding).toBe("hex");
    }
  });
});
