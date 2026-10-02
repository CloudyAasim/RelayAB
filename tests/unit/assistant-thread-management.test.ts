/**
 * tests/unit/assistant-thread-management.test.ts
 *
 * A conversation belongs to the person who started it, and they have to be able
 * to do two things with it: give it a name they will recognise later, and get
 * rid of one they never want to see again. The route handlers for both existed
 * but nothing in the UI reached them.
 *
 * The first half exercises the handlers against a real database, because the
 * property that matters is ownership: a thread id from another account has to be
 * indistinguishable from one that does not exist. The second half is a guard on
 * the drawer itself, so the endpoints cannot quietly become unreachable again
 * the way they were.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import {
  appendAssistantMessage,
  createAssistantThread,
  deleteAssistantThread,
  getAssistantThread,
  listAssistantMessages,
  listAssistantThreads,
} from "@/lib/db/assistant";
import { PATCH, DELETE } from "@/app/api/assistant/threads/[id]/route";

const SRC = join(__dirname, "..", "..", "src");
const CHAT_UI = readFileSync(
  join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

async function makeUser(username: string): Promise<User> {
  // Usernames have a 3-character minimum.
  const name = username.padEnd(3, "x");
  const user = await createUser({ username: name, password: "correct horse battery", displayName: name });
  expect(user).not.toBeNull();
  return user!;
}

async function loginAs(store: InMemoryCookieStore, user: User): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = user.id;
  s.username = user.username;
  s.role = user.role;
  await s.save();
}

/** Route handlers take the id through a promise, as Next 15 delivers it. */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(title: unknown): Request {
  return new Request("http://localhost/fake", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

function deleteRequest(): Request {
  return new Request("http://localhost/fake", { method: "DELETE" });
}

async function asJson(res: Response): Promise<{ status: number; body: any }> {
  const status = res.status;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status, body: body as any };
}

describe("assistant history: rename", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("stores the new title and hands it back", async () => {
    const user = await makeUser("rename-me");
    const store = new InMemoryCookieStore();
    await loginAs(store, user);
    currentStore = store;
    const thread = await createAssistantThread(user.id, "新对话");

    const res = await PATCH(patchRequest("部署踩坑记录"), ctx(thread.id));
    const { status, body } = await asJson(res);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The stored value is the answer, not the input: the route trims and caps.
    expect(body.data.thread.title).toBe("部署踩坑记录");
    expect((await getAssistantThread(user.id, thread.id))?.title).toBe("部署踩坑记录");
  });

  it("rejects a title that is empty or only whitespace", async () => {
    const user = await makeUser("blank-title");
    const store = new InMemoryCookieStore();
    await loginAs(store, user);
    currentStore = store;
    const thread = await createAssistantThread(user.id, "原标题");

    for (const bad of ["", "   "]) {
      const res = await PATCH(patchRequest(bad), ctx(thread.id));
      const { status } = await asJson(res);
      expect(status, `title ${JSON.stringify(bad)}`).toBe(400);
    }
    expect((await getAssistantThread(user.id, thread.id))?.title).toBe("原标题");
  });

  it("refuses to rename somebody else's thread and leaves it alone", async () => {
    const owner = await makeUser("owner-one");
    const other = await makeUser("other-one");
    const thread = await createAssistantThread(owner.id, "别人的对话");

    const store = new InMemoryCookieStore();
    await loginAs(store, other);
    currentStore = store;

    const res = await PATCH(patchRequest("我改你的"), ctx(thread.id));
    const { status, body } = await asJson(res);

    // 404, not 403: the caller learns nothing about whether the id is real.
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect((await getAssistantThread(owner.id, thread.id))?.title).toBe("别人的对话");
  });

  it("needs a session", async () => {
    currentStore = new InMemoryCookieStore(); // nobody logged in
    const { status } = await asJson(await PATCH(patchRequest("x"), ctx("whatever")));
    expect(status).toBe(401);
  });
});

describe("assistant history: delete", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("removes the thread along with its messages", async () => {
    const user = await makeUser("deleter");
    const store = new InMemoryCookieStore();
    await loginAs(store, user);
    currentStore = store;
    const thread = await createAssistantThread(user.id, "要删的对话");
    await appendAssistantMessage({ threadId: thread.id, role: "user", content: "第一句" });
    await appendAssistantMessage({ threadId: thread.id, role: "assistant", content: "回答" });
    expect(await listAssistantMessages(thread.id)).toHaveLength(2);

    const { status, body } = await asJson(await DELETE(deleteRequest(), ctx(thread.id)));
    expect(status).toBe(200);
    expect(body.data.deleted).toBe(true);

    expect(await getAssistantThread(user.id, thread.id)).toBeNull();
    // Cascading is the point: a thread that kept its messages would be a
    // conversation the user "deleted" and can still page through.
    expect(await listAssistantMessages(thread.id)).toEqual([]);
    expect((await listAssistantThreads(user.id)).map((t) => t.id)).not.toContain(thread.id);
  });

  it("refuses to delete somebody else's thread and leaves it in place", async () => {
    const owner = await makeUser("owner-two");
    const other = await makeUser("other-two");
    const thread = await createAssistantThread(owner.id, "别人的对话");

    const store = new InMemoryCookieStore();
    await loginAs(store, other);
    currentStore = store;

    const { status } = await asJson(await DELETE(deleteRequest(), ctx(thread.id)));
    expect(status).toBe(404);
    expect(await getAssistantThread(owner.id, thread.id)).not.toBeNull();
  });

  it("needs a session", async () => {
    currentStore = new InMemoryCookieStore();
    const { status } = await asJson(await DELETE(deleteRequest(), ctx("whatever")));
    expect(status).toBe(401);
  });

  it("a deleted thread cannot be appended to, so the client starts a new one", async () => {
    // The reason the drawer clears the selected id on delete instead of leaving
    // it in place: the next message would be written against a row that no
    // longer exists, and the turn would fail on the foreign key.
    const user = await makeUser("cascader");
    const thread = await createAssistantThread(user.id, "要删的对话");
    expect(await deleteAssistantThread(user.id, thread.id)).toBe(true);

    await expect(
      appendAssistantMessage({ threadId: thread.id, role: "user", content: "迟到的消息" }),
    ).rejects.toThrow();
    expect(await getAssistantThread(user.id, thread.id)).toBeNull();
  });
});

describe("assistant history: the drawer reaches those endpoints", () => {
  it("renames through PATCH and deletes through DELETE", () => {
    expect(CHAT_UI).toMatch(/method:\s*"PATCH"/);
    expect(CHAT_UI).toMatch(/method:\s*"DELETE"/);
    // Both are scoped to the thread route, not some other resource.
    expect(CHAT_UI).toContain("`/api/assistant/threads/${id}`");
    expect(CHAT_UI).toContain("`/api/assistant/threads/${target.id}`");
  });

  it("offers both actions on every conversation, with accessible names", () => {
    // Revealing the buttons on hover alone would hide them from touch screens
    // and from anyone tabbing through the drawer.
    expect(CHAT_UI).not.toMatch(/opacity-0[^\n]*group-hover:opacity-100/);
    expect(CHAT_UI).toContain('aria-label={t("assistant.renameThread")}');
    expect(CHAT_UI).toContain('aria-label={t("assistant.deleteThread")}');
    expect(CHAT_UI).toContain("<Pencil");
    expect(CHAT_UI).toContain("<Trash2");
  });

  it("renames in an input rather than a blocking prompt()", () => {
    expect(CHAT_UI).not.toContain("window.prompt");
    expect(CHAT_UI).not.toMatch(/[^.\w]prompt\(/);
  });

  it("clears the open conversation when it is the one deleted", () => {
    // Otherwise the next message goes out on a dead id and comes back 404.
    expect(CHAT_UI).toMatch(/if \(threadId === target\.id\) \{\s*setThreadId\(null\);/);
  });
});
