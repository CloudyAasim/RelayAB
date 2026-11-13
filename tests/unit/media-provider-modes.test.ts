/**
 * tests/unit/media-provider-modes.test.ts
 *
 * A media provider declares how it is spoken to, the way text providers do:
 * `advanced` (hand-written spec), `simple` (template spec), `passthrough` (any
 * vendor path) or `restricted` (only the listed paths).
 *
 * The rules worth pinning are the ones an operator would only discover in
 * production: a `restricted` provider with no paths forwards nothing, a prefix
 * that is not a path never matches, and a mode typo must not silently fall back
 * to "advanced" (which would quietly disable the passthrough they just set up).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import {
  createMediaProvider,
  getMediaProviderById,
  toPublicMediaProvider,
  MediaProviderValidationError,
} from "@/lib/db/media-providers";

function base(mode?: "pastrough" | string, paths?: string[]) {
  return {
    name: "Vendor",
    baseUrl: "https://v.test",
    apiKey: "k",
    ...(mode ? { mode: mode as never } : {}),
    ...(paths ? { passthroughPaths: paths } : {}),
  };
}

describe("media provider modes", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("defaults to advanced, the mode every pre-existing row is", async () => {
    const provider = await createMediaProvider(base());
    expect(provider.mode).toBe("advanced");
    expect(provider.passthroughPaths).toEqual([]);
  });

  it("stores a passthrough provider without paths", async () => {
    const provider = await createMediaProvider(base("passthrough"));
    expect(provider.mode).toBe("passthrough");
    expect(provider.passthroughPaths).toEqual([]);
    expect(toPublicMediaProvider(provider).mode).toBe("passthrough");
  });

  it("requires at least one path for restricted", async () => {
    await expect(createMediaProvider(base("restricted"))).rejects.toBeInstanceOf(
      MediaProviderValidationError,
    );
  });

  it("keeps and normalises the restricted allowlist", async () => {
    const provider = await createMediaProvider(
      base("restricted", ["/v1/videos", " /v1/videos ", "", "/v1/images/edits"]),
    );
    expect(provider.mode).toBe("restricted");
    // Trimmed and de-duplicated; blanks dropped.
    expect(provider.passthroughPaths).toEqual(["/v1/videos", "/v1/images/edits"]);
  });

  it("refuses a prefix that is not a plain path", async () => {
    await expect(
      createMediaProvider(base("restricted", ["v1/videos"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
    await expect(
      createMediaProvider(base("restricted", ["/v1/../../admin"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
    await expect(
      createMediaProvider(base("restricted", ["/v1/videos?x=1"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
  });

  it("refuses an unknown mode instead of falling back", async () => {
    await expect(createMediaProvider(base("passthrouh"))).rejects.toBeInstanceOf(
      MediaProviderValidationError,
    );
  });

  it("drops the allowlist when the mode is not restricted", async () => {
    const provider = await createMediaProvider(base("passthrough", ["/v1/videos"]));
    expect(provider.passthroughPaths).toEqual([]);
  });

  it("survives a round trip through the row mapper", async () => {
    const created = await createMediaProvider(base("restricted", ["/v1/videos"]));
    const read = await getMediaProviderById(created.id);
    expect(read?.mode).toBe("restricted");
    expect(read?.passthroughPaths).toEqual(["/v1/videos"]);
  });
});
