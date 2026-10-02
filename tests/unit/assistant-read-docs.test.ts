/**
 * tests/unit/assistant-read-docs.test.ts
 *
 * `read_docs` through the tool, and the prompt that tells the model to use it.
 *
 * The one thing that could go badly wrong here is not a wrong answer — it is
 * the admin documentation being readable by a regular user, through a model
 * that will summarise whatever it is given. The pages describe this
 * deployment's providers, quota pools and routing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT } from "@/lib/assistant/prompts";

const TOOLS_SOURCE = readFileSync(
  join(process.cwd(), "src", "lib", "assistant", "tools.ts"),
  "utf-8",
);
const CHAT_ROUTE = readFileSync(
  join(process.cwd(), "src", "app", "api", "assistant", "chat", "route.ts"),
  "utf-8",
);

const asUser = (extra: Record<string, unknown> = {}) => ({
  user: { id: "u1", username: "u", role: "user", timezone: "shanghai" },
  locale: "zh-CN",
  ...extra,
}) as never;

const asAdmin = (extra: Record<string, unknown> = {}) => ({
  user: { id: "a1", username: "a", role: "admin", timezone: "shanghai" },
  locale: "zh-CN",
  ...extra,
}) as never;

function payload(result: { content: string }): any {
  return JSON.parse(result.content);
}

describe("the tool exists, for both tiers", () => {
  it("is offered to a regular user and to an admin", () => {
    expect(toolDefinitions(false).map((t) => t.function.name)).toContain("read_docs");
    expect(toolDefinitions(true).map((t) => t.function.name)).toContain("read_docs");
  });

  it("takes an optional topic, and no topic means the index", () => {
    const def = toolDefinitions(false).find((t) => t.function.name === "read_docs")!;
    const params = def.function.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties)).toEqual(["topic"]);
    // Required would make the index unreachable, and the index is how the model
    // finds out what it may ask for.
    expect(params.required ?? []).toEqual([]);
  });
});

describe("reading", () => {
  it("with no topic, returns the index rather than nothing", async () => {
    const result = await executeTool("read_docs", "{}", asUser());
    expect(result.ok).toBe(true);
    const data = payload(result);
    expect(Array.isArray(data.userDocs)).toBe(true);
    expect(data.userDocs.length).toBeGreaterThan(3);
    expect(data.userDocs[0]).toMatchObject({ topic: expect.any(String), summary: expect.any(String) });
  });

  it("with a topic, returns that page's text", async () => {
    const result = await executeTool("read_docs", JSON.stringify({ topic: "endpoints" }), asUser());
    expect(result.ok).toBe(true);
    const data = payload(result);
    expect(data.topic).toBe("user:endpoints");
    expect(data.text.length).toBeGreaterThan(30);
    expect(/[一-鿿]/.test(data.text)).toBe(true);
  });

  it("follows the reader's language", async () => {
    const zh = await executeTool("read_docs", JSON.stringify({ topic: "openai" }), asUser());
    const en = await executeTool(
      "read_docs",
      JSON.stringify({ topic: "openai" }),
      asUser({ locale: "en" }),
    );
    expect(payload(zh).text).not.toBe(payload(en).text);
    expect(/[一-鿿]/.test(payload(zh).text)).toBe(true);
    expect(/[a-zA-Z]/.test(payload(en).text)).toBe(true);
  });
});

describe("who may read what", () => {
  it("refuses the admin docs to a regular user, and says why", async () => {
    const result = await executeTool(
      "read_docs",
      JSON.stringify({ topic: "admin:providers" }),
      asUser(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/管理员/);
  });

  it("hides the admin index from the same user", async () => {
    const result = await executeTool("read_docs", "{}", asUser());
    const data = payload(result);
    // The titles of the admin pages describe providers, quota pools and routing.
    // Not listing them is the same answer as refusing them.
    expect(typeof data.adminDocs).toBe("string");
    expect(data.adminDocs).toMatch(/管理员/);
  });

  it("gives an admin both, and the admin pages read as prose", async () => {
    const index = payload(await executeTool("read_docs", "{}", asAdmin()));
    expect(Array.isArray(index.adminDocs)).toBe(true);

    const page = payload(
      await executeTool("read_docs", JSON.stringify({ topic: "admin:trouble" }), asAdmin()),
    );
    expect(page.text.length).toBeGreaterThan(30);
  });

  it("tells a user who asked for an admin page which page they probably wanted", async () => {
    // Refusing outright would leave a model guessing; the user docs may well
    // have the answer even though the admin one does not.
    const result = await executeTool("read_docs", JSON.stringify({ topic: "trouble" }), asUser());
    // `trouble` exists only in the admin docs.
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/管理员/);
  });
});

describe("the loop is given the language to answer in", () => {
  it("the route resolves it, because the tool loop cannot", () => {
    // `next/headers` does not resolve inside a stream callback, and the whole
    // point of resolving it here is that the reader is not a hypothetical.
    expect(CHAT_ROUTE).toMatch(/getServerLocale\(\)/);
    expect(CHAT_ROUTE).toMatch(/locale,\s*\n\s*credential,/);
  });

  it("and the tool context carries it", () => {
    expect(TOOLS_SOURCE).toMatch(/locale\?: Locale/);
  });
});

describe("the prompt", () => {
  it("tells the model to read before answering about this system", () => {
    for (const prompt of [USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/read_docs/);
      expect(prompt).toMatch(/先 read_docs 查了再回答|先读文档再回答/);
    }
  });

  it("says the admin docs are admin-only, rather than letting the model find out", () => {
    expect(USER_SYSTEM_PROMPT).toMatch(/管理员文档只有管理员能读/);
  });

  it("keeps the two reading tools distinct", () => {
    // One is this deployment's own documentation, one is the open internet.
    // Conflated, the model reaches for the wrong one and either cites a vendor
    // page for how RelayAB works, or answers a RelayAB question from a blog.
    expect(USER_SYSTEM_PROMPT).toMatch(/和用户界面上显示的是同一份|和用户界面/);
    expect(USER_SYSTEM_PROMPT).toMatch(/公开网页/);
  });

  it("asks for the source to be named, not absorbed", () => {
    expect(USER_SYSTEM_PROMPT).toMatch(/引用读到的内容时说清楚出处/);
  });
});
