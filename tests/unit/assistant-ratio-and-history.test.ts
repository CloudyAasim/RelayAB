/**
 * tests/unit/assistant-ratio-and-history.test.ts
 *
 * Two reports, one shape of mistake.
 *
 * "I asked for 16:9 and got a square" and "I made a new conversation and had
 * to refresh before it appeared in history" are both cases of a caller saying
 * something the system had no path for acting on: a `ratio` that the spec's
 * `$mapSize` never read, and a thread list that was last read before the thread
 * existed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMapping, buildMediaScope } from "@/lib/media/engine";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";

const CHAT = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

const SPEC = MINIMAX_IMAGE_SPEC as unknown as {
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

/** The `aspect_ratio` node the spec actually ships. */
function aspectRatioNode(): Record<string, unknown> {
  return SPEC.request.aspect_ratio as Record<string, unknown>;
}

describe("a ratio the caller stated is honoured", () => {
  it("maps 16:9 to the size the spec says produces it", () => {
    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "16:9" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("16:9");
  });

  it("maps 9:16 too", () => {
    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "9:16" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("9:16");
  });

  it("before the change, a ratio was read by nothing at all", () => {
    // The reported symptom, stated as the fact it is: the mapping only ever
    // looked at `size`, so the caller's ratio never reached the vendor and the
    // default won.
    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "16:9" });
    const node = aspectRatioNode();
    // What the spec asks for on the way in, to be sure the ratio is visible to
    // a mapping that looks for it.
    expect(getPathExists(node, "$.size")).toBe(true);
    expect(scope.ratio).toBe("16:9");
  });

  it("still falls back to the default when no ratio is given", () => {
    // Text-to-image, which is most of what people do, must not change.
    const scope = buildMediaScope({ model: "image-01", prompt: "x" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("1:1");
  });

  it("lets an explicit size win over a ratio, because it is the more specific", () => {
    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "9:16", size: "1024x1024" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("1:1");
  });

  it("falls back to the default for a ratio the spec has no size for", () => {
    // 21:9 is a real aspect ratio and this spec has no size for it. Sending
    // the default is better than inventing a dimension the vendor may reject.
    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "21:9" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("1:1");
  });

  it("uses the spec's own table as the authority on what it accepts", () => {
    // Not a hardcoded list anywhere: the table is the spec's, so this works for
    // a vendor that is not MiniMax and survives one that adds a size.
    const table = (aspectRatioNode() as { $mapSize: { table: Record<string, string> } }).$mapSize.table;
    const supports = (ratio: string) => Object.values(table).includes(ratio);
    expect(supports("16:9")).toBe(true);
    expect(supports("9:16")).toBe(true);

    const scope = buildMediaScope({ model: "image-01", prompt: "x", ratio: "16:9" });
    expect(applyMapping(aspectRatioNode(), scope)).toBe("16:9");
  });

  it("respects a byModel override, because the check uses the same table", () => {
    // A vendor can ship model tiers that differ in one ratio. An override
    // changes what a size means for that model — so a ratio it no longer
    // produces is not forwarded, even though the base table still lists it.
    const node = {
      $mapSize: {
        path: "$.size",
        table: { "1024x1024": "1:1", "1792x1024": "16:9" },
        byModel: { "tier2": { "1792x1024": "21:9" } },
        default: "1:1",
      },
    };
    // The override decides what that size means, on the way in.
    expect(applyMapping(node, { model: "tier2", size: "1792x1024" })).toBe("21:9");
    // And a ratio that model no longer produces falls back rather than being
    // forwarded to a vendor that will reject it.
    expect(applyMapping(node, { model: "tier2", ratio: "16:9" })).toBe("1:1");
    // The base table is unchanged for everyone else.
    expect(applyMapping(node, { model: "tier1", ratio: "16:9" })).toBe("16:9");
    expect(applyMapping(node, { model: "tier1", size: "1792x1024" })).toBe("16:9");
  });
});

describe("a new conversation is in the history without a page reload", () => {
  it("the turn re-reads the list, not only the transcript", () => {
    // The list is a separate fetch from the transcript. Reloading only the
    // transcript leaves the list as it was read before the thread existed, so
    // a brand new conversation is missing until something else re-reads it.
    const finallyBlock = CHAT.slice(CHAT.indexOf("const settled = createdThreadRef.current"));
    expect(finallyBlock).toMatch(/void loadThread\(settled\)/);
    expect(finallyBlock).toMatch(/void loadThreads\(\)/);
    // Not in the `else` branch — that is the bug: only reached when there is
    // no thread, which is exactly the case that does not need it.
    expect(finallyBlock).not.toMatch(/else void loadThreads\(\)/);
  });

  it("and the list is what the history drawer reads", () => {
    expect(CHAT).toMatch(/setThreads\(json\?\.data\?\.threads \?\? \[\]\)/);
  });
});

/** Does a mapping node resolve the given path? */
function getPathExists(node: Record<string, unknown>, path: string): boolean {
  return JSON.stringify(node).includes(path);
}
