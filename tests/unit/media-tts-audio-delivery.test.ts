/**
 * tests/unit/media-tts-audio-delivery.test.ts
 *
 * The TTS test reported no audio over a result that carried the audio.
 *
 * `executeMedia` puts the result in one of two places, and which one depends on
 * the spec: `result.binary` when the spec declares `responseMode: "binary"` or
 * `"stream"`, and a `base64` item otherwise. `MINIMAX_TTS_SPEC` has no such
 * mode — it maps the audio to `{ kind: "base64", encoding: "hex" }` — so its
 * audio arrives as an item.
 *
 * `handler.ts` knows that: `audioDelivery` looks for the binary first and then
 * for a base64 item, and `/v1/audio/speech` uses it. The assistant's test route
 * read `result.binary` directly, so for a spec that did not use a response mode
 * it reported `no_audio` — after the engine had succeeded, the upstream had
 * answered, and the audio was sitting in the result the whole time.
 *
 * That is the second time these two routes have disagreed about one engine's
 * output, after the TTS request body sending `prompt` where the spec reads
 * `$.input`. The route is the thing to pin, not the engine.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audioDelivery } from "@/lib/media/handler";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const TEST_ROUTE = read("src", "app", "api", "assistant", "test-media", "route.ts");
const SPEECH = read("src", "app", "api", "v1", "audio", "speech", "route.ts");
const SEEDS = read("src", "lib", "media", "seeds.ts");

describe("audio is found wherever the spec put it", () => {
  it("the test route asks the same helper the public endpoint does", () => {
    // The two routes are the same engine reached two ways. When they answer
    // "there is no audio" for different reasons, it is because one of them
    // re-derived the rule — twice now.
    expect(SPEECH).toMatch(/audioDelivery\(/);
    expect(TEST_ROUTE).toMatch(/audioDelivery\(/);
    // And it no longer reaches into the engine's result itself. The comment
    // above the call quotes the old expression, which is why this looks for
    // code rather than the bare name.
    expect(TEST_ROUTE).not.toMatch(/= outcome\.value\.result\.binary/);
    expect(TEST_ROUTE).not.toMatch(/const binary = outcome/);
  });

  it("audioDelivery reads both places a spec can put it", () => {
    const hex = "4944330400000000000000"; // "ID3\x04" plus zeros — any bytes will do.
    const base64 = Buffer.from(hex, "hex").toString("base64");

    // A spec that maps to a base64 item, which is what MINIMAX_TTS_SPEC does.
    const fromItem = audioDelivery({
      items: [{ kind: "base64", encoding: "base64", value: base64 }],
    } as never);
    expect(fromItem).not.toBeNull();
    expect(fromItem?.kind).toBe("bytes");

    // A spec that declares a response mode and streams the bytes.
    const fromBinary = audioDelivery({
      binary: { body: Buffer.from(hex, "hex") as unknown as ArrayBuffer },
      items: [],
    } as never);
    expect(fromBinary?.kind).toBe("bytes");

    // Neither: the honest "no audio".
    expect(audioDelivery({ items: [] } as never)).toBeNull();
  });

  it("and the seeded TTS spec is one of the item-shaped ones", () => {
    // The premise of the bug. The MiniMax TTS spec maps its audio to a base64
    // item and declares no response mode; the OpenAI-compatible one below it
    // does declare one, and therefore took the path this route got right by
    // accident. If MINIMAX_TTS_SPEC ever gains a `responseMode`, this test
    // should be revisited rather than left looking like it still covers it.
    const tts = SEEDS.slice(SEEDS.indexOf("MINIMAX_TTS_SPEC"), SEEDS.indexOf("MINIMAX_STT_SPEC"));
    expect(tts).toMatch(/capability: "audio\.tts"/);
    expect(tts).toMatch(/kind: "base64"/);
    expect(tts).not.toMatch(/responseMode/);
  });
});
