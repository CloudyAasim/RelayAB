/**
 * tests/unit/assistant-vision.test.ts
 *
 * What the *model* receives when a picture was attached.
 *
 * The interesting part is the shape of the answer, not the plumbing:
 *
 *  - the image travels as a data URL, because the upstream is the user's own
 *    provider and our artefact route is owner-scoped — a URL would 401 for a
 *    model that did nothing wrong;
 *  - a file the model cannot look at is *named* rather than dropped, so it
 *    knows something arrived instead of answering about nothing;
 *  - and none of it lands in the stored transcript, because a turn replays its
 *    whole history and a 2 MB screenshot would be paid for on every later
 *    question in the conversation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { runChat } from "@/lib/assistant/chat";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { createAssistantThread, listAssistantMessages } from "@/lib/db/assistant";
import { saveAssistantArtifact, artifactRef } from "@/lib/db/assistant-artifacts";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { MessageAttachment } from "@/lib/assistant/schema";
import type { AssistantSettings, AssistantThread } from "@/lib/assistant/schema";
import type { AuthedUser } from "@/lib/auth/session";

/** The tools only read the identity, and a stored user may carry no timezone. */
function authed(u: User): AuthedUser {
  return { ...u, timezone: u.timezone ?? "shanghai" };
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
]);

/** One streamed assistant turn, in the chunk shape the client accumulates. */
function sseTurn(delta: unknown, finishReason: string | null = "stop"): Response {
  const frame = {
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  const body = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** The chat-completions request the loop would have sent. */
function captured(): { messages: any[]; model?: string } {
  const calls = (globalThis.fetch as unknown as { mock: { calls: any[][] } }).mock.calls;
  const init = calls[calls.length - 1][1] as { body: string };
  return JSON.parse(init.body);
}

describe("assistant: what the model is shown", () => {
  let user: User;
  let thread: AssistantThread;

  beforeEach(async () => {
    __resetDbForTest();
    currentStore = new InMemoryCookieStore();
    user = (await createUser({
      username: "vision-owner",
      password: "correct horse battery",
      displayName: "vision-owner",
    }))!;
    const session = await getSessionFromStore(currentStore);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();
    thread = await createAssistantThread(user.id, "look at this");

    // One turn of prose and no tool calls, so the loop ends after one round and
    // the request it built is the thing under test.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, _init: RequestInit) => sseTurn({ content: "看到了" })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    currentStore = null;
  });

  /** Real row shape: runChat decrypts the key before its first request. */
  function settings(): AssistantSettings {
    const now = new Date().toISOString();
    return {
      userId: user.id,
      baseUrl: "https://upstream.example/v1",
      model: "vision-model",
      encryptedApiKey: encryptSecret("sk-upstream-key"),
      protocol: "openai",
      extraHeaders: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async function attach(kind: "image" | "audio", contentType: string, bytes = PNG): Promise<MessageAttachment> {
    const saved = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind,
      bytes,
      contentType,
    });
    return { ...artifactRef(saved), name: kind === "image" ? "shot.png" : "clip.mp3" };
  }


  async function turn(message: string, attachments: MessageAttachment[] = []): Promise<void> {
    await runChat({
      user: authed(user),
      settings: settings(),
      thread,
      message,
      attachments,
      credential: { kind: "none", reason: "not_configured" } as never,
      emit: () => {},
    });
  }

  it("sends the picture as a data URL, and the words beside it", async () => {
    await turn("这是什么？", [await attach("image", "image/png")]);
    const sent = captured().messages.find((m: any) => m.role === "user");
    expect(Array.isArray(sent.content)).toBe(true);
    expect(sent.content[0]).toEqual({ type: "text", text: "这是什么？" });
    expect(sent.content[1].type).toBe("image_url");
    // A data URL, not our own route: the upstream has no session here, and
    // /api/assistant/artifacts/:id answers 401 to anyone but the owner.
    expect(sent.content[1].image_url.url).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("tells the model about a file it cannot look at", async () => {
    // Silence here is the failure: a model asked about an audio clip it cannot
    // hear will answer about the text, as though the clip did not exist.
    await turn("听一下", [await attach("audio", "audio/mpeg")]);
    const sent = captured().messages.find((m: any) => m.role === "user");
    expect(sent.content[0].text).toContain("clip.mp3");
    expect(sent.content[0].text).toContain("看不到");
    expect(sent.content.some((p: any) => p.type === "image_url")).toBe(false);
  });

  it("says something when a turn is nothing but a file", async () => {
    await turn("", [await attach("image", "image/png")]);
    const sent = captured().messages.find((m: any) => m.role === "user");
    expect(sent.content[0].text).toContain("没有文字");
  });

  it("keeps the image out of the stored transcript", async () => {
    await turn("这是什么？", [await attach("image", "image/png")]);
    const rows = await listAssistantMessages(thread.id);
    const userRow = rows.find((m) => m.role === "user")!;
    // The reference is there, and it is small.
    expect(userRow.attachments).toHaveLength(1);
    expect(userRow.attachments[0].url).toMatch(/^\/api\/assistant\/artifacts\//);
    // The base64 is not, which is the whole reason attachments live beside
    // content rather than in it.
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(userRow.content).toBe("这是什么？");
  });

  it("says nothing extra for a plain turn", async () => {
    // The common case must keep the exact shape it has always sent, or every
    // existing upstream conversation changes underneath us.
    await turn("普通的一轮");
    const sent = captured().messages.find((m: any) => m.role === "user");
    expect(sent.content).toBe("普通的一轮");
  });

  it("still replays an earlier picture on a later turn", async () => {
    await turn("这是什么？", [await attach("image", "image/png")]);
    await runChat({
      user: authed(user),
      settings: settings(),
      thread,
      message: "再仔细看看",
      credential: { kind: "none", reason: "not_configured" } as never,
      emit: () => {},
    });
    const users = captured().messages.filter((m: any) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(Array.isArray(users[0].content)).toBe(true);
    expect(users[0].content.some((p: any) => p.type === "image_url")).toBe(true);
    expect(users[1].content).toBe("再仔细看看");
  });
});
