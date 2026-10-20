/**
 * tests/unit/text-protocol-doc-page.test.ts
 *
 * The text protocol, and the two places it has to be reachable from.
 *
 * The protocol document has been in the repository for a long time, and
 * `text-protocol-doc.test.ts` has checked every mechanism it names against the
 * code for just as long. What neither test could check is the thing that
 * actually decides whether anybody reads it: **whether there is a way out of
 * the file.**
 *
 * The media protocol and the search protocol each had a reader, a chapter and
 * an assistant tool. The text protocol — the one every ordinary provider row
 * is configured with, the one the `/admin/providers` editor calls "上游协议" —
 * had none of the three. An operator who wanted to know what `clamp` meant
 * had to open the repository, and the assistant, asked to write a `textSpecs`
 * entry, wrote one from memory.
 *
 * So this file guards the two readers that make it reachable, and the third
 * guard in here is about the *other* documentation surface: the user-facing
 * document, where the only failure mode that matters is an endpoint that
 * exists and is not written down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { readTextProtocolDoc, TEXT_PROTOCOL_DOC_PATH } from "@/lib/docs/text-protocol-doc";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { DICTS } from "@/lib/i18n/dict";
import { CONFIGURABLE_PROTOCOLS, TEXT_PROTOCOL_PRESETS } from "@/lib/protocol/text-protocols";
import { WEB_DOC_SECTIONS } from "@/lib/assistant/docs-index.generated";

const ROOT = process.cwd();
const PROTOCOL_FILE = join(ROOT, "docs", "文本适配协议", "README.md");
const ADMIN_DOCS = readFileSync(join(ROOT, "src", "app", "(admin)", "admin", "docs", "AdminDocsContent.tsx"), "utf-8");
const REFERENCE = readFileSync(join(ROOT, "src", "components", "docs", "ProtocolReference.tsx"), "utf-8");
const PROMPTS = readFileSync(join(ROOT, "src", "lib", "assistant", "prompts.ts"), "utf-8");
const USER_DOCS = readFileSync(join(ROOT, "src", "app", "(user)", "dashboard", "docs", "DocsContent.tsx"), "utf-8");
const INTEGRATION = readFileSync(join(ROOT, "src", "components", "docs", "IntegrationDocs.tsx"), "utf-8");

describe("the admin documentation shows the text protocol", () => {
  it("the page renders it, from the repository file", () => {
    // The chapter that owns provider configuration renders it, and the
    // component renders it from the file rather than from a copy in the
    // dictionary — a copy is a second version of a protocol, and the second
    // version is the one that goes stale.
    expect(ADMIN_DOCS, "the providers chapter does not render the text protocol").toContain(
      '<ProtocolReference kind="text" />',
    );
    expect(REFERENCE).toContain("readTextProtocolDoc");
    expect(REFERENCE).toMatch(/kind\?: "media" \| "search" \| "text"/);
  });

  it("and the reader reads the file that is actually there", async () => {
    const { text, error } = await readTextProtocolDoc();
    expect(error, `the protocol could not be read: ${error}`).toBeUndefined();
    expect(text.length).toBeGreaterThan(1000);
    // The same bytes as the repository file — not a trimmed copy.
    expect(text).toBe(readFileSync(PROTOCOL_FILE, "utf-8"));
    expect(TEXT_PROTOCOL_DOC_PATH).toBe(PROTOCOL_FILE);
  });
});

describe("the assistant can read the text protocol", () => {
  let admin: User;
  let plain: User;

  beforeEach(async () => {
    __resetDbForTest();
    admin = (await createUser({
      username: "text-protocol-admin",
      password: "correct horse battery",
      displayName: "text-protocol-admin",
      role: "admin",
    }))!;
    plain = (await createUser({
      username: "text-protocol-plain",
      password: "correct horse battery",
      displayName: "text-protocol-plain",
      role: "user",
    }))!;
  });

  afterEach(() => {
    currentStore = null;
  });

  it("the tool is offered to an administrator and to nobody else", () => {
    const adminNames = toolDefinitions(true).map((t) => t.function.name);
    const plainNames = toolDefinitions(false).map((t) => t.function.name);
    expect(adminNames).toContain("get_text_spec_reference");
    expect(plainNames, "the text protocol is admin-only, like the other two").not.toContain(
      "get_text_spec_reference",
    );
  });

  it("and refused for a non-admin who tries anyway", async () => {
    const result = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "protocol" }),
      { user: plain } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("管理员");
  });

  it("what=\"protocol\" returns the document, in readable pieces", async () => {
    const whole = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "protocol" }),
      { user: admin } as never,
    );
    expect(whole.ok).toBe(true);
    const body = JSON.parse(whole.content) as {
      total: number;
      offset: number;
      returned: number;
      nextOffset?: number;
      text: string;
    };
    const file = readFileSync(PROTOCOL_FILE, "utf-8");
    expect(body.total).toBe(file.length);
    expect(body.text.length).toBe(file.length);
    expect(body.text).toBe(file);

    // And the chunking is real: a short window hands back a cursor rather than
    // a truncated document that looks complete.
    const first = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "protocol", limit: 500 }),
      { user: admin } as never,
    );
    const chunk = JSON.parse(first.content) as { text: string; nextOffset?: number };
    expect(chunk.text).toBe(file.slice(0, 500));
    expect(chunk.nextOffset).toBe(500);

    const second = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "protocol", offset: chunk.nextOffset, limit: 500 }),
      { user: admin } as never,
    );
    expect(JSON.parse(second.content).text).toBe(file.slice(500, 1000));
  });

  it("what=\"presets\" returns the configurable presets, ready to paste", async () => {
    const result = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "presets" }),
      { user: admin } as never,
    );
    expect(result.ok).toBe(true);
    const body = JSON.parse(result.content) as {
      presets: { protocol: string; clientPath: string; requiresFace: string; preset: unknown }[];
    };
    expect(body.presets.map((p) => p.protocol)).toEqual([...CONFIGURABLE_PROTOCOLS]);
    for (const preset of body.presets) {
      // The object is the one the repository holds, verbatim — a preset the
      // tool paraphrases is a preset that fails its own validator.
      expect(preset.preset).toEqual(TEXT_PROTOCOL_PRESETS[preset.protocol as keyof typeof TEXT_PROTOCOL_PRESETS]);
      // And it says which client endpoint it governs, so a rule is not
      // written for an interface nothing calls.
      expect(preset.clientPath).toBeTruthy();
      expect(["openai", "anthropic"]).toContain(preset.requiresFace);
    }
  });

  it("and refuses a preset nothing could ever select", async () => {
    // `gemini-generate` is a real protocol and the right answer the day this
    // gateway serves `v1beta/models/*:generateContent` — which it does not.
    // Handing it out would be the same lie the editor stopped telling.
    const result = await executeTool(
      "get_text_spec_reference",
      JSON.stringify({ what: "presets", protocol: "gemini-generate" }),
      { user: admin } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("gemini-generate");
  });
});

describe("the prompt sends the model to the right reader for each protocol", () => {
  it("all three readers are named, each for its own protocol", () => {
    for (const tool of [
      "get_media_spec_reference",
      "get_search_spec_reference",
      "get_text_spec_reference",
    ]) {
      expect(PROMPTS, `${tool} is not in the prompt`).toContain(tool);
    }
  });

  it("and the text one is named where the text rules are discussed", () => {
    // The guidance used to point every spec at the media reader, so a model
    // writing `textSpecs` had one reader offered and it was the wrong one.
    const section = PROMPTS.slice(
      PROMPTS.indexOf("### 3. 参数规则默认 passthrough"),
      PROMPTS.indexOf("### 3.1 写了规则还要确认引擎在读它"),
    );
    expect(section, "the text-parameter section does not point at the text reader").toContain(
      "get_text_spec_reference",
    );
  });

  it("and the media paragraph says it is about media", () => {
    // The paragraph was not wrong; it was unlabelled, and an unlabelled
    // paragraph is the one a model reaches for when the topic is anything.
    const paragraph = PROMPTS.slice(
      PROMPTS.indexOf("### 4.1 三个协议"),
      PROMPTS.indexOf("**关于 media spec 的形状"),
    );
    expect(paragraph).toContain("get_media_spec_reference");
    expect(paragraph).toContain("get_search_spec_reference");
    expect(paragraph).toContain("get_text_spec_reference");
  });
});

describe("the user documentation names every public endpoint", () => {
  /**
   * The public surface, derived from the route files rather than written out.
   *
   * A list written by hand in a test is a list that stops being true when a
   * route is added, and a list that stops being true is worse than no list:
   * the guard would keep passing while the gap it exists to catch widens.
   */
  function publicRoutes(): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (entry.name === "route.ts") {
          const rest = child.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, "");
          // The public surface is the two proxy prefixes; everything else
          // under /api is the dashboard's own API.
          if (rest.startsWith("v1/")) out.push(`/${rest}`);
          else if (rest.startsWith("anthropic/")) out.push(`/${rest}`);
        }
      }
    };
    walk("src/app/api");
    // …and the one public route that does not live under /api, because it
    // was never a rewrite of an /api handler.
    for (const extra of ["v1/chat/completions/responses"]) {
      if (statSync(join(ROOT, "src", "app", ...extra.split("/"), "route.ts")).isFile()) {
        out.push(`/${extra}`);
      }
    }
    return [...new Set(out)].sort();
  }

  it("the derivation found the endpoints", () => {
    // A guard that finds nothing passes forever.
    const routes = publicRoutes();
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain("/v1/chat/completions");
    expect(routes).toContain("/v1/models");
    expect(routes).toContain("/v1/search");
    expect(routes).toContain("/anthropic/v1/messages");
  });

  it("each one is written down in the user document, in both languages", () => {
    // Only the *user* surface counts. The administrator's document describes
    // how to run the gateway; it is not where a client author looks for the
    // endpoint list.
    //
    // The resolved dictionary rather than the source: a key that exists but
    // resolves to nothing is what a reader sees, and the source of a
    // multi-line value is not the value.
    const userText = (locale: "zh-CN" | "en"): string =>
      [
        USER_DOCS,
        INTEGRATION,
        Object.entries(DICTS[locale])
          .filter(([key]) => key.startsWith("docs."))
          .map(([key, value]) => `${key} ${value}`)
          .join("\n"),
      ].join("\n");

    const zh = userText("zh-CN");
    const en = userText("en");

    const missingZh = publicRoutes().filter((route) => !zh.includes(route));
    expect(
      missingZh,
      "these endpoints exist but the Chinese user document never names them: " + missingZh.join(", "),
    ).toEqual([]);

    const missingEn = publicRoutes().filter((route) => !en.includes(route));
    expect(
      missingEn,
      "these endpoints exist but the English user document never names them: " + missingEn.join(", "),
    ).toEqual([]);
  });

  it("and the dictionary has the new text in both languages", () => {
    // A key nothing resolves renders as the key itself — a line of
    // `docs.anthropic.modelsTitle` in the middle of a chapter.
    for (const key of [
      "docs.anthropic.modelsTitle",
      "docs.anthropic.modelsDesc",
      "docs.anthropic.modelsExample",
      "docs.anthropic.modelsResponse",
      "docs.responses.alias",
      "admin.docs.provider.textProtocol",
      "admin.docs.textProtocol.title",
      "admin.docs.textProtocol.desc",
    ]) {
      expect(DICTS["zh-CN"][key], `${key} is missing in zh-CN`).toBeTruthy();
      expect(DICTS.en[key], `${key} is missing in en`).toBeTruthy();
    }
  });
});

describe("the generated index describes the pages as they are", () => {
  it("the providers chapter points at the text protocol reader", () => {
    const providers = WEB_DOC_SECTIONS.find((s) => s.surface === "admin" && s.id === "providers");
    expect(providers?.after, "the providers chapter does not say where the protocol text is").toContain(
      "get_text_spec_reference",
    );
    expect(providers?.keys).toContain("admin.docs.textProtocol.title");
  });

  it("and the ops chapter is named for what it is", () => {
    // It used to be described as a pair of reference files that live on two
    // other pages, which made the model look for a protocol on a page of
    // shell commands.
    const ops = WEB_DOC_SECTIONS.find((s) => s.surface === "admin" && s.id === "ops");
    expect(ops?.summary).toContain("运维命令");
    expect(ops?.note ?? "").not.toContain("模型适配协议");
    // …and it has its own words, rather than having them filed elsewhere.
    expect(ops?.keys).toContain("admin.docs.ops.title");
  });
});
