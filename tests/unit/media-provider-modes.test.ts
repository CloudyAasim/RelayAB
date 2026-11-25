/**
 * tests/unit/media-provider-modes.test.ts
 *
 * A media provider declares how it is spoken to, in one of two ways:
 * `spec` (the client speaks the OpenAI shape; a declarative spec translates it)
 * or `passthrough` (the vendor's own paths under /v1/raw, forwarded verbatim).
 *
 * The rules worth pinning are the ones an operator would only discover in
 * production: an empty allowlist on a passthrough provider means "any path",
 * a prefix that is not a path never matches, a mode typo must not silently fall
 * back to `spec` (which would quietly disable the passthrough they just set
 * up), and the legacy values still read as the mode they behaved as.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import {
  createMediaProvider,
  getMediaProviderById,
  updateMediaProvider,
  toPublicMediaProvider,
  MediaProviderValidationError,
} from "@/lib/db/media-providers";

function base(mode?: string, paths?: string[]) {
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

  it("defaults to spec", async () => {
    const provider = await createMediaProvider(base());
    expect(provider.mode).toBe("spec");
    expect(provider.passthroughPaths).toEqual([]);
  });

  it("stores a passthrough provider without paths — an unrestricted one", async () => {
    const provider = await createMediaProvider(base("passthrough"));
    expect(provider.mode).toBe("passthrough");
    expect(provider.passthroughPaths).toEqual([]);
    expect(toPublicMediaProvider(provider).mode).toBe("passthrough");
  });

  it("keeps and normalises a passthrough allowlist", async () => {
    const provider = await createMediaProvider(
      base("passthrough", ["/v1/videos", " /v1/videos ", "", "/v1/images/edits"]),
    );
    expect(provider.mode).toBe("passthrough");
    // Trimmed and de-duplicated; blanks dropped.
    expect(provider.passthroughPaths).toEqual(["/v1/videos", "/v1/images/edits"]);
  });

  it("drops the allowlist for a spec provider", async () => {
    const provider = await createMediaProvider(base("spec", ["/v1/videos"]));
    expect(provider.mode).toBe("spec");
    expect(provider.passthroughPaths).toEqual([]);
  });

  it("accepts the legacy spec values and stores them as spec", async () => {
    for (const legacy of ["advanced", "simple"]) {
      const provider = await createMediaProvider(base(legacy));
      expect(provider.mode).toBe("spec");
    }
  });

  it("accepts legacy restricted and stores it as passthrough with its allowlist", async () => {
    const provider = await createMediaProvider(base("restricted", ["/v1/videos"]));
    expect(provider.mode).toBe("passthrough");
    expect(provider.passthroughPaths).toEqual(["/v1/videos"]);
  });

  it("still requires at least one path for legacy restricted", async () => {
    // Old rows cannot be written this way, but an API caller spelling the
    // legacy value must not get the old "forward nothing" provider by accident.
    await expect(createMediaProvider(base("restricted"))).rejects.toBeInstanceOf(
      MediaProviderValidationError,
    );
  });

  it("refuses a prefix that is not a plain path", async () => {
    await expect(
      createMediaProvider(base("passthrough", ["v1/videos"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
    await expect(
      createMediaProvider(base("passthrough", ["/v1/../../admin"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
    await expect(
      createMediaProvider(base("passthrough", ["/v1/videos?x=1"])),
    ).rejects.toBeInstanceOf(MediaProviderValidationError);
  });

  it("refuses an unknown mode instead of falling back", async () => {
    await expect(createMediaProvider(base("passthrouh"))).rejects.toBeInstanceOf(
      MediaProviderValidationError,
    );
  });

  it("survives a round trip through the row mapper", async () => {
    const created = await createMediaProvider(base("passthrough", ["/v1/videos"]));
    const read = await getMediaProviderById(created.id);
    expect(read?.mode).toBe("passthrough");
    expect(read?.passthroughPaths).toEqual(["/v1/videos"]);
  });

  it("persists a mode and allowlist change on update", async () => {
    // The UPDATE used to bind mode and passthrough_paths without listing them
    // in the SET clause, so an edit in the panel never reached the row.
    const created = await createMediaProvider(base("spec"));
    const updated = await updateMediaProvider(created.id, {
      mode: "passthrough",
      passthroughPaths: ["/v1/videos"],
    });
    expect(updated?.mode).toBe("passthrough");
    expect(updated?.passthroughPaths).toEqual(["/v1/videos"]);

    const read = await getMediaProviderById(created.id);
    expect(read?.mode).toBe("passthrough");
    expect(read?.passthroughPaths).toEqual(["/v1/videos"]);
  });

  it("can turn a passthrough provider back into a spec one", async () => {
    const created = await createMediaProvider(base("passthrough", ["/v1/videos"]));
    const updated = await updateMediaProvider(created.id, {
      mode: "spec",
      passthroughPaths: ["/v1/videos"],
    });
    expect(updated?.mode).toBe("spec");
    expect(updated?.passthroughPaths).toEqual([]);
  });
});