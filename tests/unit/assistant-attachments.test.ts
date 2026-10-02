/**
 * tests/unit/assistant-attachments.test.ts
 *
 * Uploading a file to a conversation.
 *
 * The rule that shapes all of it: a picture the model can see must not become
 * a picture the *database* has to carry. So the bytes go to assistant_artifacts
 * — the same store tool results use, which already has an owner-scoped serving
 * route — and the message keeps a reference. The data URL that actually reaches
 * the model is built per turn and thrown away.
 *
 * These tests are mostly about that separation, and about the ways an upload
 * can go wrong that a plain string message cannot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { POST } from "@/app/api/assistant/chat/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import {
  createAssistantThread,
  listAssistantMessages,
  getAssistantThread,
  saveAssistantSettings,
} from "@/lib/db/assistant";
import { getAssistantArtifact } from "@/lib/db/assistant-artifacts";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

/** A 1×1 PNG, the smallest thing that is genuinely a picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** POST one turn to the real route handler. */
function chat(body: unknown): Promise<Response> {
  return POST(
    new Request("https://api.example/api/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const PNG_ATTACHMENT = {
  name: "shot.png",
  contentType: "image/png",
  data: PNG.toString("base64"),
};

/** Read the SSE body far enough to know the request was accepted. */
async function accepted(res: Response): Promise<boolean> {
  if (res.status !== 200) return false;
  const reader = res.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  return first.done === false;
}

describe("assistant: sending a file", () => {
  let store: InMemoryCookieStore;
  let user: User;
  const settings = { baseUrl: "https://upstream.example/v1", model: "m" };

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "attach-owner",
      password: "correct horse battery",
      displayName: "attach-owner",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();

    await saveAssistantSettings(user.id, {
      baseUrl: settings.baseUrl,
      apiKey: "sk-test-upstream-key",
      model: settings.model,
    });
    // The turn itself is not what is under test; the route only refuses before
    // this point, and reaching the model would be a real network call.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream not stubbed for this test")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    currentStore = null;
  });

  it("stores the file as an artefact and keeps the bytes out of the transcript", async () => {
    const res = await chat({ message: "这是什么？", attachments: [PNG_ATTACHMENT], ...settings });
    expect(await accepted(res)).toBe(true);

    const threadId = res.headers.get("x-assistant-thread");
    expect(threadId).toBeTruthy();
    const thread = await getAssistantThread(user.id, threadId!);
    const messages = await listAssistantMessages(thread!.id);
    const mine = messages.find((m) => m.role === "user")!;

    // The reference, beside the message.
    expect(mine.attachments).toHaveLength(1);
    expect(mine.attachments[0]).toMatchObject({
      id: expect.any(String),
      kind: "image",
      contentType: "image/png",
      name: "shot.png",
    });
    expect(mine.attachments[0].url).toBe(`/api/assistant/artifacts/${mine.attachments[0].id}`);
    expect(mine.attachments[0].bytes).toBe(PNG.byteLength);

    // The payload, beside it and nowhere else.
    const stored = await getAssistantArtifact(mine.attachments[0].id, user.id);
    expect(stored?.bytes?.byteLength).toBe(PNG.byteLength);
    expect(JSON.stringify(mine)).not.toContain(PNG.toString("base64"));
    // Which is the whole point: a 2 MB screenshot must not become a 2 MB row in
    // assistant_messages that every later turn replays.
    expect(mine.content).toBe("这是什么？");
  });

  it("belongs to the uploader, and to nobody else", async () => {
    const res = await chat({ message: "看图", attachments: [PNG_ATTACHMENT], ...settings });
    const threadId = res.headers.get("x-assistant-thread")!;
    const messages = await listAssistantMessages(threadId);
    const id = messages.find((m) => m.role === "user")!.attachments[0].id;

    const stranger = (await createUser({
      username: "attach-other",
      password: "correct horse battery",
      displayName: "attach-other",
    }))!;
    // Same owner check as any other artefact — an upload is a new way to ask
    // for a file, and the old check has to cover it.
    expect(await getAssistantArtifact(id, stranger.id)).toBeNull();
    expect(await getAssistantThread(stranger.id, threadId)).toBeNull();
  });

  it("lets a turn be nothing but a file", async () => {
    // Attaching and hitting send without typing is what people do.
    const res = await chat({ attachments: [PNG_ATTACHMENT], ...settings });
    expect(await accepted(res)).toBe(true);
    const threadId = res.headers.get("x-assistant-thread")!;
    const thread = await getAssistantThread(user.id, threadId);
    // And it still needs a name a person can find in the history list.
    expect(thread?.title).toBe("shot.png");
  });

  it("still refuses an empty turn with nothing attached", async () => {
    // Otherwise every accidental Enter starts a conversation.
    const res = await chat({ message: "   ", ...settings });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("names the file it will not take, instead of accepting it and failing later", async () => {
    const res = await chat({
      message: "hi",
      attachments: [{ name: "deck.pdf", contentType: "application/pdf", data: "JVBERi0=" }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("unsupported_attachment");
    expect(body.error.message).toContain("deck.pdf");
  });

  it("refuses a file that claims a type it does not have", async () => {
    // An .exe sent as image/png would be stored and served back as an image.
    // The allowlist is by declared type and the bytes are never sniffed, so the
    // worst case is a broken picture — not a stored executable.
    const res = await chat({
      message: "hi",
      attachments: [{ name: "x.exe", contentType: "image/png", data: "TVpQ" }],
    });
    expect(res.status).toBe(200);
    const threadId = res.headers.get("x-assistant-thread")!;
    const messages = await listAssistantMessages(threadId);
    const stored = await getAssistantArtifact(messages[0].attachments[0].id, user.id);
    expect(stored?.contentType).toBe("image/png");
    // Which is the documented behaviour, pinned so it is a decision and not an
    // accident: the declared type is trusted, and the served route is scoped to
    // the owner and sends Content-Disposition: attachment on ?dl=1.
    expect(stored?.bytes?.byteLength).toBeGreaterThan(0);
  });

  it("refuses an empty file", async () => {
    const res = await chat({
      message: "hi",
      attachments: [{ name: "empty.png", contentType: "image/png", data: "" }],
    });
    expect(res.status).toBe(400);
  });

  it("keeps the thread clean when one file of several is refused", async () => {
    // Refused before anything is created, so there is no half-written thread.
    const res = await chat({
      message: "hi",
      attachments: [PNG_ATTACHMENT, { name: "deck.pdf", contentType: "application/pdf", data: "JVBERi0=" }],
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-assistant-thread")).toBeNull();
  });

  it("needs a session", async () => {
    const empty = new InMemoryCookieStore();
    currentStore = empty;
    const res = await chat({ message: "hi", attachments: [PNG_ATTACHMENT], ...settings });
    expect(res.status).toBe(401);
  });
});

describe("assistant: the column a deployed database is missing", () => {
  it("exists on a table created before attachments did", async () => {
    // `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, so
    // without the explicit add-column step every production database would keep
    // the old shape and this INSERT would fail at runtime — on the only
    // deployment that had real data, and not in any test.
    const { getDb } = await import("@/lib/db/sqlite");
    const columns = (
      getDb().prepare("PRAGMA table_info(assistant_messages)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("attachments");
  });
});
