/**
 * Three things a turn of work was getting wrong, checked where they can be
 * checked.
 *
 * The switch: a model that accepts `thinking: {type: "disabled"}` and thinks
 * anyway is not a model with a slow setting. It is a control that stores a
 * choice, sends it on every request, and produces no difference — the same
 * defect the effort dropdown had, in the field next to it, and the reason the
 * two are declared separately is that they fail independently: a model can take
 * levels and refuse a disable, or take a disable and have no levels.
 *
 * The ceilings: the tool-result cap was sized against a few thousand characters
 * of media configuration, and a vendor's API reference page came back at twelve
 * percent of itself, cut mid-sentence. The visible result was a model fetching
 * the same documentation five times, saying each time that the fetch was
 * truncated. That is a loop caused by a limit.
 *
 * The renderer: a stray unpaired backtick was rendered as a literal character at
 * the end of a sentence, and a run of text after a URL is what a browser
 * decides is a link. The reader got a long blue thing that is not one, with a
 * backtick hanging off it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToHtml } from "@/lib/markdown";
import { ModelConfigSchema } from "@/lib/db/types";
import {
  MAX_IDENTICAL_CALLS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TURN_MS,
} from "@/lib/assistant/chat";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");

describe("a switch the model ignores is greyed out", () => {
  it("the field exists, and it is separate from the levels", () => {
    // Merging them would mean one answer for two questions, and this deployment
    // has a model that takes neither.
    const row = ModelConfigSchema.parse({ upstreamId: "m", clientId: "c" });
    expect(row.thinkingSwitchSupported).toBe(true);
    expect(row.reasoningEffortSupported).toBe(true);
    expect(ModelConfigSchema.parse({ upstreamId: "m", clientId: "c", thinkingSwitchSupported: false })
      .thinkingSwitchSupported).toBe(false);
  });

  it("the form switches it off on an explicit false and not otherwise", () => {
    // `null` is the state of every row written before the field existed, and
    // reading it as false would grey a working control across the deployment.
    expect(PANEL).toContain("facts?.thinkingSwitchSupported === false");
    expect(PANEL).toMatch(/disabled=\{switchUnsupported\}/);
  });

  it("and says which control does work, so it is not a dead end", () => {
    expect(PANEL).toContain("thinkingSwitchNotSupported");
    expect(read("src", "lib", "i18n", "dict.ts")).toContain("thinkingSwitchNotSupported");
  });

  it("the assistant can declare it, the same as the editor", () => {
    const TOOLS = read("src", "lib", "assistant", "tools.ts");
    expect(TOOLS).toMatch(/thinkingSwitchSupported: \{\s*type: "boolean"/);
    expect(TOOLS).toMatch(/typeof args\.thinkingSwitchSupported === "boolean"/);
  });
});

describe("the ceilings leave room for the work", () => {
  it("a vendor reference page fits in one tool result", () => {
    // A typical MiniMax API reference is tens of thousands of characters. At
    // 24,000 it arrived cut mid-sentence and the model kept re-fetching.
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThanOrEqual(60_000);
  });

  it("a turn that reads many of them is allowed to finish", () => {
    expect(MAX_TURN_MS).toBe(30 * 60 * 1000);
  });

  it("and a stuck loop is still stopped, without waiting half an hour", () => {
    // The one guard that matters once the ceiling above is this high. It is
    // deliberately not raised further: four repeats is not learning, and a loop
    // that runs to the turn ceiling is half an hour of upstream spend.
    expect(MAX_IDENTICAL_CALLS).toBe(4);
  });
});

describe("a backtick nobody paired does not reach the screen", () => {
  it("the exact shape that read as one long link", () => {
    const out = markdownToHtml(
      "`https://api.minimaxi.com`，国际区；聊天走/v1/image_generation/v1/t2a_v2/v1/speech_to_text`",
    );
    // The URL stays inside its code span, and the run after it stays prose —
    // that part was already right. What is gone is the character that made it
    // look like something had been concatenated by mistake.
    expect(out).toContain("<code");
    expect(out).toContain("https://api.minimaxi.com</code>");
    expect(out).not.toContain("`");
  });

  it("a paired span is untouched", () => {
    const out = markdownToHtml("地址是 `https://api.minimaxi.com`，国际区。");
    expect(out).toContain("<code");
    expect(out).toContain("https://api.minimaxi.com</code>");
    expect(out).toContain("，国际区。");
  });

  it("and a bare URL is not turned into one", () => {
    // Not asserted as a feature so much as a floor: the renderer does not
    // linkify, so anything that looks like a long link came from the text.
    const out = markdownToHtml("地址是 https://api.minimaxi.com，国际区。");
    expect(out).not.toContain("<a ");
  });
});
