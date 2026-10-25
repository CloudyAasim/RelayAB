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
 *
 * **The prompt exists in two languages**, and this file holds both to the same
 * standard. The English one is a parallel copy rather than a summary — every
 * rule, every tool name and every prescribed phrase has an English counterpart
 * — so a rule that is quietly missing from one of them is a defect the reader
 * of that language would have hit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT, systemPrompt } from "@/lib/assistant/prompts";
import { EN_SHARED, EN_USER_TIER, EN_ADMIN_TIER } from "@/lib/assistant/prompts.en";
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

/**
 * The two prompts, and the words each language uses for the same rule.
 *
 * The assertions below run against both, so a rule that survives in Chinese
 * and is missing in English is caught here rather than by a user.
 */
const PROMPTS = {
  "zh-CN": {
    admin: ADMIN_SYSTEM_PROMPT,
    user: USER_SYSTEM_PROMPT,
    replaces: ["整份替换", "不是增量", "不是合并"],
    notUndoable: /无法在提交后撤回|点确认就真的生效/,
    neverTouchesKeys: /永远不碰密钥/,
    neverAsksForKey: /绝对不要.{0,10}向用户索取密钥/,
    adminTypesTheKey: /自己填上 API 密钥/,
    cannotDelete: /不能删除服务商/,
    cannotChangeUserKeys: /不能改用户自己的密钥/,
    cannotChangeAnything: /你不能直接修改任何配置/,
    notAlreadyDone: /不要说「已经改好了」/,
    userTierLacksAdmin: /你不具备管理员权限/,
    adminTierHasAdmin: /你在管理员模式下/,
    credentialAlreadyOn: /设置里创建并开启了助手凭据/,
    notPointAtThisDeployment: /把助手地址指向本部署/,
    mentionsAttachments: /图片、文档、音频|图片/,
    answerLanguage: /回答用简体中文/,
  },
  en: {
    admin: `${EN_SHARED}\n\n${EN_ADMIN_TIER}`,
    user: `${EN_SHARED}\n\n${EN_USER_TIER}`,
    replaces: ["wholesale replacement", "not incremental edits", "not a merge"],
    notUndoable: /You cannot undo it after submitting|clicks confirm, it really takes effect/,
    neverTouchesKeys: /You never touch a key/,
    neverAsksForKey: /never.{0,30}ask the user for a key/,
    adminTypesTheKey: /paste the API key into the confirmation box/,
    cannotDelete: /You cannot delete a provider/,
    cannotChangeUserKeys: /You cannot change a user's own keys/,
    cannotChangeAnything: /You cannot modify any configuration directly/,
    notAlreadyDone: /Do not say "it is fixed"/,
    userTierLacksAdmin: /You do not have administrator privileges/,
    adminTierHasAdmin: /You are in administrator mode/,
    credentialAlreadyOn: /created and enabled the assistant credential in the settings/,
    notPointAtThisDeployment: /point the assistant.{0,40}this deployment/,
    mentionsAttachments: /image|document|audio/,
    answerLanguage: /Answer in English/,
  },
} as const;

/** Every locale, so a third one is not silently left out of the checks. */
const LOCALES = Object.keys(PROMPTS) as Array<keyof typeof PROMPTS>;

describe("assistant: the admin prompt", () => {
  for (const locale of LOCALES) {
    const prompt = PROMPTS[locale];

    it(`says the three fields replace the table rather than merge into it (${locale})`, () => {
      // The one that bites. A model that means to add one model mapping sends
      // one mapping, every other model the provider had is gone, and the diff
      // reads like a deliberate change because to the tool it is one.
      for (const phrase of prompt.replaces) {
        expect(prompt.admin, `the prompt never says ${phrase}`).toContain(phrase);
      }
    });

    it(`says the replacement is not undoable, and what to do instead (${locale})`, () => {
      expect(prompt.admin).toContain("list_providers");
      expect(prompt.admin).toContain("list_media_providers");
      expect(prompt.admin).toMatch(prompt.notUndoable);
    });

    it(`says how a new provider is made, and that the key is the admin's to type (${locale})`, () => {
      // The assistant can create one now. What it must never do is handle the
      // key, and what it must never do is ask the user for one in the chat.
      expect(prompt.admin).toMatch(/propose_provider_create/);
      expect(prompt.admin).toMatch(prompt.neverTouchesKeys);
      expect(prompt.admin).toMatch(prompt.neverAsksForKey);
      expect(prompt.admin).toMatch(prompt.adminTypesTheKey);
    });

    it(`still says the parts it genuinely cannot do (${locale})`, () => {
      expect(prompt.admin).toMatch(prompt.cannotDelete);
      expect(prompt.admin).toMatch(prompt.cannotChangeUserKeys);
    });

    it(`routes a question to a tool instead of leaving it to recall (${locale})`, () => {
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
        expect(prompt.admin, `${tool} is never mentioned`).toContain(tool);
      }
    });

    it(`keeps the rule that it cannot change anything itself (${locale})`, () => {
      expect(prompt.admin).toMatch(prompt.cannotChangeAnything);
      expect(prompt.admin).toMatch(prompt.notAlreadyDone);
    });

    it(`still refuses the two tiers different things (${locale})`, () => {
      expect(prompt.user).toMatch(prompt.userTierLacksAdmin);
      expect(prompt.admin).toMatch(prompt.adminTierHasAdmin);
    });

    it(`does not tell the user to do something the tools already do (${locale})`, () => {
      // The old prompt told the user to paste a key once the assistant pointed
      // at this deployment, which is the account credential now — so the advice
      // sent people to a field that no longer exists.
      expect(prompt.user).toMatch(prompt.credentialAlreadyOn);
      expect(prompt.user).not.toMatch(prompt.notPointAtThisDeployment);
    });

    it(`tells the model what an attachment is (${locale})`, () => {
      expect(prompt.user).toMatch(prompt.mentionsAttachments);
      expect(prompt.admin.length).toBeGreaterThan(0);
    });

    it(`answers in the reader's language (${locale})`, () => {
      expect(prompt.user).toMatch(prompt.answerLanguage);
    });
  }
});

describe("assistant: the two prompts stay in step", () => {
  /** The structural facts a reader of either language can rely on. */
  function shape(prompt: string): {
    /** The depth of each heading, in order — the text is translated. */
    headingLevels: string[];
    tableRows: number;
    tools: string[];
  } {
    return {
      headingLevels: [...prompt.matchAll(/^(#{2,3}) .+$/gm)].map((m) => m[1]),
      tableRows: (prompt.match(/^\|/gm) ?? []).length,
      // The tool names the prompt tells the model to reach for.
      tools: [...new Set([...prompt.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)].map((m) => m[0]))].sort(),
    };
  }

  it("the English prompt has the same headings as the Chinese one", () => {
    // The rules are the same rules. A heading that exists in one language and
    // not the other is a rule one of the two readers never gets. The *text* of
    // a heading is translated, so what is compared is how many there are and
    // how deep each one is.
    expect(shape(PROMPTS.en.admin).headingLevels).toEqual(
      shape(PROMPTS["zh-CN"].admin).headingLevels,
    );
    expect(shape(PROMPTS.en.user).headingLevels).toEqual(
      shape(PROMPTS["zh-CN"].user).headingLevels,
    );
  });

  it("and the same tables", () => {
    expect(shape(PROMPTS.en.admin).tableRows).toBe(shape(PROMPTS["zh-CN"].admin).tableRows);
    expect(shape(PROMPTS.en.user).tableRows).toBe(shape(PROMPTS["zh-CN"].user).tableRows);
  });

  it("and names the same tools", () => {
    // The routing table is the part that decides whether the model reaches for
    // the right tool, and it is the part a translation most easily drops.
    expect(shape(PROMPTS.en.admin).tools).toEqual(shape(PROMPTS["zh-CN"].admin).tools);
    expect(shape(PROMPTS.en.user).tools).toEqual(shape(PROMPTS["zh-CN"].user).tools);
  });
});

describe("assistant: the prompt follows the reader's language", () => {
  it("the default is the deployment's own", () => {
    expect(systemPrompt(true)).toBe(ADMIN_SYSTEM_PROMPT);
    expect(systemPrompt(false)).toBe(USER_SYSTEM_PROMPT);
  });

  it("and a reader who chose English gets the English one", () => {
    const prompt = systemPrompt(true, {}, "en");
    expect(prompt).toContain("You are in administrator mode.");
    expect(prompt).not.toContain("你在管理员模式下");
    expect(prompt).toContain("Answer in English");
  });

  it("and the web-search note comes in the same language", () => {
    expect(systemPrompt(false, { webSearch: false }, "en")).toMatch(
      /web search is off for this turn/i,
    );
    expect(systemPrompt(false, { webSearch: false })).toContain("本轮关闭了网页搜索");
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
    // The size is written in the dictionary now: it was Chinese in the source,
    // so the English interface refused a file in Chinese.
    expect(CHAT).toMatch(/assistant\.upload\.tooLarge/);
    expect(CHAT).toContain("MAX_UPLOAD_LABEL");
  });

  it("converts big files without blowing the argument limit", () => {
    // String.fromCharCode(...bytes) throws above a megabyte or so, and a phone
    // photo is comfortably past that.
    expect(CHAT).toMatch(/subarray\(i, i \+ CHUNK\)/);
  });
});
