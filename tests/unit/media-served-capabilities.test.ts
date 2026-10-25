/**
 * tests/unit/media-served-capabilities.test.ts
 *
 * What a media provider can do, listed once.
 *
 * A provider may hold several specs of the same capability — a vendor that
 * ships both a v1 and a v2 API — and each spec declares the models it serves.
 * That is a legitimate shape, and `validateMediaSpecs` enforces the scoping
 * that makes it safe.
 *
 * The administrator's media list, though, printed **one badge per spec** and
 * labelled each with the capability alone, so a provider with one image
 * capability and two specs of it read as
 *
 *     image.generate  image.generate
 *
 * Two identical labels, side by side, with nothing to tell them apart — the
 * one thing the list is for ("what can this provider do?") said twice.
 */
import { describe, it, expect } from "vitest";
import { servedCapabilities, type MediaSpec } from "@/lib/media/spec";

function spec(capability: string, models?: string[]): MediaSpec {
  return {
    specVersion: 1,
    capability: capability as MediaSpec["capability"],
    ...(models ? { models } : {}),
    transport: { method: "POST", path: "/v1/x" },
  } as MediaSpec;
}

describe("the capabilities a provider serves", () => {
  it("lists each capability once", () => {
    const served = servedCapabilities([
      spec("image.generate", ["image-a"]),
      spec("image.generate", ["image-b"]),
      spec("video.generate", ["video-a"]),
      spec("video.generate", ["video-b"]),
    ]);
    expect(served.map((s) => s.capability)).toEqual(["image.generate", "video.generate"]);
  });

  it("and says which models each one covers", () => {
    // The models are what tells two specs of the same capability apart, so
    // they ride along rather than being lost with the duplicate.
    const [image] = servedCapabilities([
      spec("image.generate", ["image-a"]),
      spec("image.generate", ["image-b"]),
    ]);
    expect(image.models).toEqual(["image-a", "image-b"]);
    expect(image.specCount).toBe(2);
  });

  it("does not repeat a model that two specs both claim", () => {
    const [image] = servedCapabilities([
      spec("image.generate", ["image-a", "image-b"]),
      spec("image.generate", ["image-b"]),
    ]);
    expect(image.models).toEqual(["image-a", "image-b"]);
  });

  it("a provider with no specs has no capabilities", () => {
    expect(servedCapabilities([])).toEqual([]);
    expect(servedCapabilities(undefined)).toEqual([]);
  });

  it("an unscoped spec still counts as a capability", () => {
    // One spec serving every model of its capability — no `models` array, and
    // no models to report.
    const served = servedCapabilities([spec("audio.tts")]);
    expect(served).toHaveLength(1);
    expect(served[0].capability).toBe("audio.tts");
    expect(served[0].models).toEqual([]);
    expect(served[0].specCount).toBe(1);
  });
});
