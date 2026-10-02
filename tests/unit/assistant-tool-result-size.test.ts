/**
 * What the listing costs, and the cap that fits it.
 *
 * The turn loop truncates a tool result at 8000 characters, and a truncation
 * lands wherever it lands. The faithful spec listing is 14807 pretty-printed,
 * so the cut fell inside the video spec's `async.poll` — and the model copied
 * a spec with no `statusMap`, which the approval then rejected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
} from "@/lib/media/seeds";

const SPECS = [
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
] as unknown as Record<string, unknown>[];

import { MAX_TOOL_RESULT_CHARS } from "@/lib/assistant/chat";

const CHAT = readFileSync(join(process.cwd(), "src", "lib", "assistant", "chat.ts"), "utf-8");

describe("a tool result big enough to be useful and small enough to survive", () => {
  it("the listing fits, compacted, under the cap the loop enforces", () => {
    const compact = JSON.stringify(SPECS);
    console.log(
      `      compact ${compact.length} · pretty ${JSON.stringify(SPECS, null, 2).length} · cap ${MAX_TOOL_RESULT_CHARS}`,
    );
    expect(compact.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });

  it("the cap is read from the one the loop uses, not a copy of it", () => {
    expect(CHAT).toContain("MAX_TOOL_RESULT_CHARS");
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThan(JSON.stringify(SPECS).length);
  });

  it("and the poll fields the validator needs are inside the listing", () => {
    // The exact fields that were missing from the rejected proposal.
    const compact = JSON.stringify(SPECS);
    for (const field of ["statusMap", "statusPath", "intervalMs", "submitTaskId"]) {
      expect(compact, `${field} would fall past the cap`).toContain(`"${field}"`);
    }
  });

  it("the payload is compact when it is sent", () => {
    // Otherwise the fit is theoretical.
    const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");
    const at = TOOLS.indexOf("async function listMediaProvidersTool");
    const fn = TOOLS.slice(at, at + 900);
    expect(fn).toContain("okCompact(");
  });
});
