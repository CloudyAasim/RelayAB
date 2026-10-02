/**
 * tests/unit/assistant-prompt.test.ts
 *
 * What the assistant is told about changing model configuration.
 *
 * It was told it *couldn't* change anything, and roughly how to propose a
 * change. What it was not told was the two things that actually went wrong:
 * that the mapping and spec fields replace the whole table rather than merge
 * into it, and that there is no tool for creating a provider at all. Both are
 * cheap to state and expensive to discover.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT, systemPrompt } from "@/lib/assistant/prompts";
import { toolDefinitions } from "@/lib/assistant/tools";

const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");
const CHAT = readFileSync(join(process.cwd(), "src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"), "utf-8");

/** The description the model actually reads when it is about to call a tool. */
function paramDescription(tool: string, field: string): string {
  const at = TOOLS.indexOf(`name: "${tool}"`);
  expect(at, `${tool} is not defined`).toBeGreaterThan(-1);
  const from = TOOLS.slice(at, at + 2600);
  const hit = from.match(new RegExp(`${field}:\\s*\\{[\\s\\S]{0,80}?description:\\s*\\n?\\s*"([\\s\\S]*?)",\\n`));
  return hit?.[1] ?? "";
}

describe("assistant: the admin prompt", () => {
  it("says the three fields replace the table rather than merge into it", () => {
    // The one that bites. A model that means to add one model mapping sends
    // one mapping, every other model the provider had is gone, and the diff
    // reads like a deliberate change because to the tool it is one.
    for (const phrase of ["整份替换", "不是增量", "不是合并"]) {
      expect(ADMIN_SYSTEM_PROMPT, `the prompt never says ${phrase}`).toContain(phrase);
    }
  });

  it("says the replacement is not undoable, and what to do instead", () => {
    expect(ADMIN_SYSTEM_PROMPT).toContain("list_providers");
    expect(ADMIN_SYSTEM_PROMPT).toContain("list_media_providers");
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/无法在提交后撤回|点确认就真的生效/);
  });

  it("says how a new provider is made, and that the key is the admin's to type", () => {
    // The assistant can create one now. What it must never do is handle the
    // key, and what it must never do is ask the user for one in the chat.
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/propose_provider_create/);
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/永远不碰密钥/);
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/绝对不要.{0,10}向用户索取密钥/);
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/自己填上 API 密钥/);
  });

  it("still says the parts it genuinely cannot do", () => {
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/不能删除服务商/);
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/不能改用户自己的密钥/);
  });

  it("routes a question to a tool instead of leaving it to recall", () => {
    // A short table beats another paragraph: the descriptions were long and the
    // model still reached for the wrong one.
    for (const tool of [
      "list_gateway_models",
      "test_gateway_model",
      "list_providers",
      "list_media_providers",
      "probe_provider_host",
      "propose_provider_update",
      "propose_media_provider_update",
      "list_users",
    ]) {
      expect(ADMIN_SYSTEM_PROMPT, `${tool} is never mentioned`).toContain(tool);
    }
  });

  it("keeps the rule that it cannot change anything itself", () => {
    expect(ADMIN_SYSTEM_PROMPT).toContain("你不能直接修改任何配置");
    expect(ADMIN_SYSTEM_PROMPT).toMatch(/不要说「已经改好了」/);
  });

  it("still refuses the two tiers different things", () => {
    expect(USER_SYSTEM_PROMPT).toContain("你不具备管理员权限");
    expect(ADMIN_SYSTEM_PROMPT).toContain("你在管理员模式下");
    expect(systemPrompt(true)).toBe(ADMIN_SYSTEM_PROMPT);
    expect(systemPrompt(false)).toBe(USER_SYSTEM_PROMPT);
  });

  it("does not tell the user to do something the tools already do", () => {
    // The old prompt told the user to paste a key once the assistant pointed
    // at this deployment, which is the account credential now — so the advice
    // sent people to a field that no longer exists.
    expect(USER_SYSTEM_PROMPT).toMatch(/设置里创建并开启了助手凭据/);
    expect(USER_SYSTEM_PROMPT).not.toMatch(/把助手地址指向本部署/);
  });

  it("tells the model what an attachment is", () => {
    expect(USER_SYSTEM_PROMPT).toMatch(/图片、文档、音频|图片/);
    expect(ADMIN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});

describe("assistant: the tool descriptions the model reads at call time", () => {
  it("warns on modelMapping that it replaces", () => {
    const d = paramDescription("propose_provider_update", "modelMapping");
    expect(d).toContain("完整");
    expect(d).toMatch(/整份替换|不是增量/);
    expect(d).toMatch(/list_providers/);
  });

  it("warns on media models, and points at the patch for specs", () => {
    const models = paramDescription("propose_media_provider_update", "models");
    expect(models).toMatch(/完整|整份替换/);
    expect(models).toContain("list_media_providers");

    // Specs no longer ask the model to retype them: it does that badly, and the
    // broken JSON it produced is what the admin was looking at.
    const specs = paramDescription("propose_media_provider_update", "specs");
    expect(specs).toMatch(/specEdits/);
    expect(specs).toMatch(/新增或删除/);
  });

  it("offers specEdits, which is how a spec changes now", () => {
    const def = toolDefinitions(true).find((t) => t.function.name === "propose_media_provider_update")!;
    const props = (def.function.parameters as { properties?: Record<string, { description?: string }> })
      .properties ?? {};
    expect(Object.keys(props)).toContain("specEdits");
    const item = (props.specEdits as { items?: { properties?: Record<string, unknown> } }).items;
    // It has to say which spec, or the patch is not addressable.
    expect(Object.keys(item?.properties ?? {})).toContain("index");
  });

  it("offers a create tool with nowhere to put a key", () => {
    const admin = toolDefinitions(true);
    const names = admin.map((t) => t.function.name);
    expect(names).toContain("propose_provider_create");
    expect(names).toContain("propose_media_provider_create");

    // The point of the whole design: there is no parameter a model could use
    // to smuggle a secret into the stored action. Not "we tell it not to" —
    // there is nowhere to put it.
    for (const tool of ["propose_provider_create", "propose_media_provider_create"]) {
      const def = admin.find((t) => t.function.name === tool)!;
      const props = Object.keys(
        (def.function.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props, `${tool} has a field a key could go in`).not.toContain("apiKey");
      expect(def.function.description).toMatch(/密钥/);
    }
  });

  it("keeps a create out of the regular user's tool set", () => {
    const names = toolDefinitions(false).map((t) => t.function.name);
    expect(names).not.toContain("propose_provider_create");
    expect(names).not.toContain("propose_media_provider_create");
    expect(names).not.toContain("propose_provider_update");
  });
});

describe("assistant: what the composer can do", () => {
  it("offers a file picker", () => {
    expect(CHAT).toContain('type="file"');
    expect(CHAT).toMatch(/<Paperclip/);
  });

  it("lets a turn be nothing but a file", () => {
    expect(CHAT).toMatch(/\(!text && picked\.length === 0\)/);
    expect(CHAT).toMatch(/disabled=\{\(!input\.trim\(\) && uploads\.length === 0\)/);
  });

  it("refuses an unuploadable file by name, before sending it", () => {
    // A turn that only fails after the bytes have crossed the network costs the
    // most when the file is the biggest one.
    expect(CHAT).toMatch(/if \(!UPLOADABLE\.has\(type\)\)/);
    expect(CHAT).toMatch(/超过 25MB/);
  });

  it("converts big files without blowing the argument limit", () => {
    // String.fromCharCode(...bytes) throws above a megabyte or so, and a phone
    // photo is comfortably past that.
    expect(CHAT).toMatch(/subarray\(i, i \+ CHUNK\)/);
  });
});
