/**
 * tests/unit/assistant-media-proposal-mode.test.ts
 *
 * A media provider has a mode and, for the two passthrough modes, a path list.
 * The assistant could propose neither: a row could be created or edited in the
 * panel with a mode, and an assistant-built one was stuck on the route's
 * default. These are the two fields the gap was about.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkProposal } from "@/lib/assistant/proposal-validation";

const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

describe("media provider proposals can carry the mode", () => {
  it("accepts a mode and its passthrough paths on update", () => {
    const gate = checkProposal("media_provider.update", {
      mode: "passthrough",
      passthroughPaths: ["/v1/images/generations"],
    });
    expect(gate.ok).toBe(true);
  });

  it("accepts the same two fields on create", () => {
    const gate = checkProposal("media_provider.create", {
      name: "assistant-made",
      models: { "img-1": { upstreamId: "img-1" } },
      mode: "restricted",
      passthroughPaths: ["/v1/images/generations"],
    });
    expect(gate.ok).toBe(true);
  });

  it("refuses a mode the panel does not know", () => {
    const gate = checkProposal("media_provider.update", { mode: "native" });
    expect(gate.ok).toBe(false);
  });

  it("the tool schemas offer both fields", () => {
    expect(TOOLS).toContain('t("propose_media_provider_update.mode")');
    expect(TOOLS).toContain('t("propose_media_provider_update.passthroughPaths")');
    expect(TOOLS).toContain('t("propose_media_provider_create.mode")');
    // And the executors copy them into the payload rather than dropping them.
    expect(TOOLS).toContain("patch.mode = args.mode");
    expect(TOOLS).toContain("patch.passthroughPaths = args.passthroughPaths");
    expect(TOOLS).toContain("spec.mode = args.mode");
  });
});
