/**
 * tests/unit/assistant-pretty-reaches-everything.test.ts
 *
 * The output-format switch only reached half the reply.
 *
 * It was wired to the assistant's prose and nowhere else, so turning it off
 * gave a plain-text answer sitting next to a decorated tool-result card — two
 * renderings of one reply, which is the single thing a switch like that must
 * not produce. The hint says "关掉就是模型原样的纯文本"; the tool JSON stayed
 * a card.
 *
 * Artefacts are the deliberate exception: a picture has no raw form, so
 * generated media still appears with its type and download either way. What
 * changes is the text around it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ARTIFACTS = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "MediaArtifacts.tsx"),
  "utf-8",
);
const CHAT = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

describe("the switch reaches every part of the reply", () => {
  it("the tool card takes it, and the screen passes it", () => {
    expect(ARTIFACTS).toMatch(/export function ToolResultCard\([\s\S]{0,600}pretty\?: boolean/);
    expect(ARTIFACTS).toMatch(/export function ToolResultCard\([\s\S]{0,600}pretty = true/);
    expect(CHAT).toMatch(/<ToolResultCard[\s\S]{0,300}pretty=\{pretty\}/);
  });

  it("with it off, the tool result is plain text rather than a card", () => {
    expect(ARTIFACTS).toMatch(/if \(!pretty\) \{[\s\S]{0,400}whitespace-pre-wrap/);
  });

  it("and artefacts survive it, because a picture has no raw form", () => {
    // Scoped to the card's own branch: `AssistantBody` has an earlier
    // `if (!pretty)`, and slicing from the first one finds the prose path.
    const card = ARTIFACTS.slice(ARTIFACTS.indexOf("export function ToolResultCard"));
    const off = card.slice(card.indexOf("if (!pretty) {"), card.indexOf("if (!pretty) {") + 600);
    expect(off).toMatch(/<MediaArtifacts/);
  });

  it("the prose still takes it", () => {
    expect(CHAT).toMatch(/<AssistantBody[\s\S]{0,300}pretty=\{pretty\}/);
  });
});
