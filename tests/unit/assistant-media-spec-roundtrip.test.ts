/**
 * tests/unit/assistant-media-spec-roundtrip.test.ts
 *
 * The admin pressed approve and it failed with "Invalid media provider
 * configuration", three times, with nothing further.
 *
 * Two things were wrong, and they compounded:
 *
 *  1. `list_media_providers` showed the model a *summary* of each spec —
 *     `capability`, `displayName`, and `method`/`path` hoisted out of the
 *     `transport` object they actually live in, with `request`, `response`,
 *     `auth` and the rest omitted. The model then proposed specs in exactly
 *     that shape, because it had only ever seen that shape. A spec like that
 *     cannot work: it has no request mapping and no response mapping, so
 *     nothing upstream is ever called.
 *
 *  2. The validator knew exactly what was wrong — `MediaProviderValidationError`
 *     carries an `issues` list — and the apply route threw all of it away,
 *     keeping only the class name. So the admin got a refusal with no reason,
 *     and the model got a refusal with no reason, and the second could only
 *     guess again.
 *
 * This file pins the round trip: what the tool shows, and what the validator
 * accepts, have to be the same thing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMediaSpecs, parseMediaSpec } from "@/lib/media/spec";
import {
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
} from "@/lib/media/seeds";

const STORED = [
  MINIMAX_IMAGE_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_STT_SPEC,
  OPENAI_TTS_SPEC,
  OPENAI_STT_SPEC,
] as unknown as Record<string, unknown>[];

function errorsOf(specs: unknown[]): string[] {
  return validateMediaSpecs(specs).errors;
}

describe("what the model is shown is what it must send back", () => {
  it("the stored specs validate", () => {
    expect(errorsOf(STORED)).toEqual([]);
  });

  it("the summary shape does not, and that is the whole problem", () => {
    // Exactly the shape `list_media_providers` used to hand over.
    const summary = STORED.map((s) => ({
      capability: s.capability,
      displayName: s.displayName,
      method: (s.transport as { method?: string } | undefined)?.method,
      path: (s.transport as { path?: string } | undefined)?.path,
      models: s.models ?? null,
    }));
    expect(errorsOf(summary).length).toBeGreaterThan(0);
  });

  it("a spec with no transport is refused rather than half-accepted", () => {
    // A media spec without a path is a spec that calls nothing, which reads as
    // "configured" in a list and fails on first use.
    const parsed = parseMediaSpec({ capability: "image.generate", displayName: "x", method: "POST", path: "/v1/x" });
    expect(parsed.ok).toBe(false);
  });
});

describe("the refusal explains itself", () => {
  it("carries issues, which is the part that was being thrown away", () => {
    const errors = errorsOf([{ capability: "image.generate" }]);
    expect(errors.length).toBeGreaterThan(0);
    // Something a person can act on, not a class name.
    for (const e of errors) {
      expect(e.length).toBeGreaterThan(4);
      expect(e).not.toBe("Invalid media provider configuration");
    }
  });

  it("names what is missing, so the model can fix it rather than guess again", () => {
    const errors = errorsOf([{ capability: "image.generate", method: "POST", path: "/v1/x" }]).join(" ");
    expect(errors).toMatch(/transport|request|response|spec/i);
  });
});

describe("the read tool stops teaching the wrong shape", () => {
  const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

  it("hands over the stored spec rather than a summary of it", () => {
    // The summary hoisted `method` and `path` out of `transport` and dropped
    // everything that makes a spec work. A model shown only that will propose
    // only that, and it will not validate.
    const fn = TOOLS.slice(TOOLS.indexOf("async function listMediaProvidersTool"));
    expect(fn.slice(0, 1200)).toContain("specs: (m.specs ?? []).map(specForTheModel)");
    expect(fn.slice(0, 1200)).not.toMatch(/method: s\.transport\?\.method/);
  });

  it("tells the model to copy a spec rather than compose one", () => {
    // Both the read that shows them and the write that validates them.
    expect(TOOLS).toMatch(/与 list_media_providers 返回的形状逐字一致/);
    expect(TOOLS).toMatch(/整份复制，再只改/);
  });

  it("and the prompt says so in words, before any tool is chosen", () => {
    const PROMPTS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "prompts.ts"), "utf-8");
    expect(PROMPTS).toMatch(/不要自己编/);
    // The reason, not just the rule: a spec without a request/response mapping
    // saves cleanly and then calls nothing.
    expect(PROMPTS).toMatch(/调用不了任何东西/);
  });
});

describe("the refusal reaches the person who pressed approve", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
    "utf-8",
  );

  it("uses the issues, which are the only actionable part of the error", () => {
    expect(ROUTE).toMatch(/err instanceof MediaProviderValidationError[\s\S]{0,160}err\.issues\.join/);
  });

  it("uses the issues for a validation error, not the class name", () => {
    // The last catch is the one that wraps the apply; the first is the admin
    // guard. A validation error has to be answered from `issues` — the class
    // name is what the admin saw, and it is what the model saw, and it is the
    // reason the second attempt was another guess.
    const at = ROUTE.lastIndexOf("} catch (err) {");
    const catchBlock = ROUTE.slice(at, ROUTE.indexOf("export async function GET", at));
    const validation = catchBlock.indexOf("instanceof MediaProviderValidationError");
    const join = catchBlock.indexOf("err.issues.join");
    const bare = catchBlock.indexOf("err.message");
    expect(validation, "no validation branch").toBeGreaterThan(-1);
    expect(join, "the issues are not used").toBeGreaterThan(validation);
    // The generic fallback is fine and necessary for every other error; what
    // matters is that it is second.
    expect(bare, "the generic message is gone entirely").toBeGreaterThan(join);
  });
});
