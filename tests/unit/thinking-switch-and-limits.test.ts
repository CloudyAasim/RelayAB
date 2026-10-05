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
    // The one guard that matters once the ceiling above is this high. It is a
    // backstop and not a working limit: a model with somewhere to go
    // interleaves different calls, so many of the *identical* one in a row is a
    // loop and not a task. A value low enough to fire on real work is too low to
    // serve that purpose, which is what four was.
    expect(MAX_IDENTICAL_CALLS).toBeGreaterThanOrEqual(20);
  });
});

describe("the administrator's page about the assistant is a real page", () => {
  const SECTIONS = read("src", "lib", "docs", "sections.ts");
  const CONTENT = read("src", "app", "(admin)", "admin", "docs", "AdminDocsContent.tsx");

  it("registered in the admin outline, not among the user's chapters", () => {
    // Separate because what the assistant can change, and what it cannot, is a
    // question only the person behind the relay has. Filing it under the user
    // documentation would answer it for people who cannot act on it.
    expect(SECTIONS).toMatch(/export const ADMIN_SECTION_IDS = \[[\s\S]*"assistant"/);
    const userBlock = SECTIONS.slice(
      SECTIONS.indexOf("USER_SECTION_IDS"),
      SECTIONS.indexOf("ADMIN_SECTION_IDS"),
    );
    expect(userBlock).not.toContain('"assistant"');
  });

  it("and rendered from source rather than left to the operator to write", () => {
    // The operator's pages live in the database and the assistant can write
    // them. This one describing the assistant's own limits belongs in the
    // repository, where a deploy cannot remove it and where it cannot be
    // edited into saying something untrue.
    expect(CONTENT).toMatch(/if \(section === "assistant"\)/);
    expect(CONTENT).toContain("admin.docs.assistant.limits.approval");
    expect(SECTIONS).toContain('"admin.docs.nav.assistant"');
  });

  it("and it says plainly that nothing happens without the administrator", () => {
    const DICT = read("src", "lib", "i18n", "dict.ts");
    expect(DICT).toContain("admin.docs.assistant.limits.approval");
    const line = DICT
      .split("\n")
      .find((l) => l.includes('"admin.docs.assistant.limits.approval"'))!;
    expect(line).toContain("不能直接改");
    expect(line).toContain("确认");
  });
});

describe("the empty state asks a user, not an operator", () => {
  const DICT = read("src", "lib", "i18n", "dict.ts");

  it("points at this gateway rather than at deployment", () => {
    // "How do I deploy this" and "which env vars do I need" are questions from
    // the person standing behind the relay. Everyone else is asking what it
    // serves, what it costs, and why their call failed.
    const line = DICT.split("\n").find((l) => l.includes('"assistant.emptyState"'))!;
    expect(line).toContain("中转站");
    expect(line).not.toContain("部署");
    expect(line).not.toContain("环境变量");
  });

  it("and every suggestion is something an ordinary caller would ask", () => {
    for (const n of ["1", "2", "3", "4"]) {
      const line = DICT.split("\n").find(
        (l) => l.includes(`"assistant.suggestions.${n}":`),
      )!;
      expect(line, `suggestion ${n} is missing`).toBeTruthy();
      // The deployment question that used to be suggestion 3.
      expect(line).not.toContain("Dokku");
      expect(line).not.toContain("环境变量");
    }
    // And they are about *this* deployment, not a generic assistant.
    const s3 = DICT.split("\n").find((l) => l.includes('"assistant.suggestions.3":'))!;
    expect(s3).toContain("/v1/chat/completions");
  });

  it("no replacement characters anywhere in the dictionary", () => {
    // A character written as three replacement characters is what a reader sees
    // as broken text rather than as a bug, which is why one has been sitting in
    // the admin model-configuration description without anyone noticing.
    expect(DICT.includes("�")).toBe(false);
  });

  it("and it is one sentence, mentioning that it draws things", () => {
    // It is an invitation, not a summary of what the deployment is. It used to
    // run to a list of things the system can do and offered "I just set up
    // Dokku" as a suggestion, which is a question from whoever stands behind
    // the relay rather than from anyone using it.
    //
    // Found by the Chinese line, which is the one that has to be short; the
    // English one is wrapped across two lines in the file and a matcher
    // written for one layout silently finds nothing in the other.
    const line = DICT.split("\n").find((l) => l.includes('"assistant.emptyState": "'))!;
    expect(line).toBeTruthy();
    // The string literal including its quotes, so the trailing `",` is not
    // mistaken for a second sentence.
    const text = line.slice(line.indexOf('": "') + 2).replace(/",$/, "");
    expect(text.split("。").filter((s) => s.length > 0)).toHaveLength(1);
    expect(text).toContain("图片");
    expect(text).not.toContain("部署");
    expect(text).not.toContain("环境变量");
  });

  it("the suggestions ask about credits, never about money", () => {
    // This is a self-hosted relay that meters in credits. A page that talks
    // about cost in currency is describing something this deployment is not.
    for (const line of DICT.split("\n")) {
      if (!line.includes('"assistant.suggestions.')) continue;
      for (const word of ["多少钱", "美元", "美金", "人民币", "元/", "花费", "付费"]) {
        expect(line, `${word} in ${line.trim().slice(0, 60)}`).not.toContain(word);
      }
    }
    // And the ban is a ban, not a preference about which slot says what.
    //
    // This used to end with "suggestion 2 contains 收费", which was a way of
    // saying the set should include a metering question. It broke the first
    // time anybody edited a suggestion — and the breakage said nothing about
    // currency, which is the only thing this rule is for. A guard that fails
    // when the product is changed on purpose is a guard that gets deleted, and
    // the rule it was carrying goes with it.
    //
    // So the rule stays and the slot-pinning goes. Whether the set covers
    // metering is a product choice, not a correctness rule, and it is better
    // raised with whoever is choosing the words than asserted in a test.
    const suggestions = DICT.split("\n").filter((l) => l.includes('"assistant.suggestions.'));
    expect(suggestions.length).toBeGreaterThan(0);
    // Four examples that say the same thing teach one thing, not four.
    const bodies = suggestions.map((l) => (l.split('": ')[1] ?? "").replace(/[",]\s*$/, ""));
    expect(new Set(bodies).size).toBe(bodies.length);
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
