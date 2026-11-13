/**
 * tests/unit/assistant-doc-page-upsert.test.ts
 *
 * Changing ONE parameter-guide page.
 *
 * `propose_doc_pages` replaces the whole set, so adding one page meant resending
 * every page — roughly 40 KB for this deployment's guide. On 2026-11-13 an
 * assistant spent eleven attempts on that and never got a complete payload out;
 * it withdrew three proposals that would have deleted or stubbed the other seven
 * pages. The content was never the problem.
 *
 * What is pinned here:
 *   - a new page is appended and the rest are kept byte-for-byte;
 *   - editing an existing page keeps the fields the caller omitted;
 *   - `remove` takes exactly one page away;
 *   - the proposal that reaches the administrator carries the merged list, so
 *     nothing else can be lost by approving it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { updateSettings, getSettings } from "@/lib/db/settings";
import { listAssistantActions } from "@/lib/db/assistant";
import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import type { DocPage } from "@/lib/docs/custom";

const EXISTING: DocPage[] = [
  { id: "overview", title: "总览", body: "总览正文", order: 0 },
  { id: "minimax-image", title: "MiniMax Image", body: "image-01 正文", order: 1 },
  { id: "opencode", title: "OpenCode", body: "很长的 OpenCode 正文", order: 2 },
];

async function adminContext() {
  const user = await createUser({
    username: "doc-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    role: "admin",
  });
  return { user: { ...user!, timezone: "shanghai" as const }, canReadAdminDocs: true };
}

describe("propose_doc_page", () => {
  beforeEach(async () => {
    __resetDbForTest();
    await updateSettings({ docPages: EXISTING });
  });

  it("appends a new page and keeps every existing one untouched", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_page",
      JSON.stringify({
        summary: "补 H3 参数页",
        id: "minimax-h3-image",
        title: "MiniMax H3 Image",
        body: "H3 正文：文生图 + 1–16 张参考图",
      }),
      ctx as never,
    );
    expect(result.ok, result.content.slice(0, 300)).toBe(true);
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.mode).toBe("added");
    expect(payload.kept).toEqual(["overview", "minimax-image", "opencode"]);

    // The proposal the admin will approve must carry the whole merged list.
    const [action] = await listAssistantActions(ctx.user.id);
    const args = JSON.parse(String(action.args)) as { docPages: DocPage[] };
    expect(args.docPages.map((p) => p.id)).toEqual([
      "overview",
      "minimax-image",
      "opencode",
      "minimax-h3-image",
    ]);
    // Byte-for-byte: the three existing bodies are not re-typed by the caller,
    // so they must come from storage rather than from the tool call.
    expect(args.docPages[0]).toEqual(EXISTING[0]);
    expect(args.docPages[2].body).toBe("很长的 OpenCode 正文");
  });

  it("edits one field of an existing page and leaves the rest as stored", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_page",
      JSON.stringify({ summary: "改标题", id: "minimax-image", title: "MiniMax Image (image-01)" }),
      ctx as never,
    );
    expect(result.ok, result.content.slice(0, 300)).toBe(true);
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.mode).toBe("updated");

    const [action] = await listAssistantActions(ctx.user.id);
    const pages = (JSON.parse(String(action.args)) as { docPages: DocPage[] }).docPages;
    expect(pages).toHaveLength(3);
    expect(pages[1].title).toBe("MiniMax Image (image-01)");
    // Body and order were not mentioned, so they stay.
    expect(pages[1].body).toBe("image-01 正文");
    expect(pages[1].order).toBe(1);
  });

  it("removes exactly one page", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_page",
      JSON.stringify({ summary: "删掉 OpenCode 页", id: "opencode", remove: true }),
      ctx as never,
    );
    expect(result.ok, result.content.slice(0, 300)).toBe(true);

    const [action] = await listAssistantActions(ctx.user.id);
    const pages = (JSON.parse(String(action.args)) as { docPages: DocPage[] }).docPages;
    expect(pages.map((p) => p.id)).toEqual(["overview", "minimax-image"]);
  });

  it("refuses a page that does not exist rather than silently appending on remove", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_page",
      JSON.stringify({ summary: "删不存在的页", id: "nope", remove: true }),
      ctx as never,
    );
    expect(result.ok).toBe(false);
    expect((await getSettings()).docPages).toHaveLength(3);
    expect(await listAssistantActions(ctx.user.id)).toHaveLength(0);
  });

  it("refuses an id that cannot be a bookmark anchor", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_page",
      JSON.stringify({ summary: "坏 id", id: "H3 Image", title: "x", body: "y" }),
      ctx as never,
    );
    expect(result.ok).toBe(false);
    expect(await listAssistantActions(ctx.user.id)).toHaveLength(0);
  });
});

describe("the full replacement cannot quietly delete pages", () => {
  beforeEach(async () => {
    __resetDbForTest();
    await updateSettings({ docPages: EXISTING });
  });

  it("is offered to admins (the tool the assistant said it did not have)", () => {
    const names = toolDefinitions(true).map((tool) => tool.function.name);
    expect(names).toContain("propose_doc_page");
    expect(names).toContain("propose_doc_pages");
    // And a regular user is offered neither.
    const userNames = toolDefinitions(false).map((tool) => tool.function.name);
    expect(userNames).not.toContain("propose_doc_page");
    expect(userNames).not.toContain("propose_doc_pages");
  });

  it("refuses a one-page list that would drop the other pages, and names the right tool", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_pages",
      JSON.stringify({
        summary: "只发新页",
        pages: [{ id: "minimax-h3-image", title: "MiniMax H3 Image", body: "H3 正文" }],
      }),
      ctx as never,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("propose_doc_page");
    // A refusal is not a proposal: nothing reached the approval queue.
    expect(await listAssistantActions(ctx.user.id)).toHaveLength(0);
    expect((await getSettings()).docPages).toHaveLength(3);
  });

  it("still allows a deliberate full replacement when it says so", async () => {
    const ctx = await adminContext();
    const result = await executeTool(
      "propose_doc_pages",
      JSON.stringify({
        summary: "整份重排",
        confirmRemovals: true,
        pages: [{ id: "minimax-h3-image", title: "MiniMax H3 Image", body: "H3 正文" }],
      }),
      ctx as never,
    );

    expect(result.ok, result.content.slice(0, 300)).toBe(true);
    const [action] = await listAssistantActions(ctx.user.id);
    const pages = (JSON.parse(String(action.args)) as { docPages: DocPage[] }).docPages;
    expect(pages.map((page) => page.id)).toEqual(["minimax-h3-image"]);
  });
});
