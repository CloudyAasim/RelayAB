/**
 * tests/unit/assistant-image-to-image.test.ts
 *
 * `generate_image` and a reference picture.
 *
 * Reported as "the assistant doesn't know how to do image-to-image", and it
 * was right for a reason that had nothing to do with the model: the tool had
 * three parameters — model, prompt, size. The model read the spec, saw
 * `subject_reference` and `metadata.modes: ["text-to-image","image-to-image"]`
 * sitting right there, correctly concluded that the *tool* was the thing that
 * could not express it, and fell back to handing the user a curl command with
 * an empty `image` field.
 *
 * So the spec was already right. What was missing was a way to say "use the
 * picture attached to this message" without pasting a megabyte of base64 into
 * a tool call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { resolveReferenceImage, executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { createAssistantThread, listAssistantMessages } from "@/lib/db/assistant";
import { saveAssistantArtifact, artifactRef } from "@/lib/db/assistant-artifacts";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import type { MessageAttachment } from "@/lib/assistant/schema";

const PROMPT_SOURCE = readFileSync(
  join(process.cwd(), "src", "lib", "assistant", "prompts.ts"),
  "utf-8",
);

/** A 1×1 PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15,
  0xc4, 0x89,
]);

describe("the reference image, in the three forms a caller can give it", () => {
  let store: InMemoryCookieStore;
  let user: User;
  let thread: { id: string };

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "i2i",
      password: "correct horse battery",
      displayName: "i2i",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();
    thread = await createAssistantThread(user.id, "照着这张图画");
  });

  afterEach(() => {
    currentStore = null;
  });

  const ctx = (attachments?: MessageAttachment[]) => ({
    user: { ...user, timezone: "shanghai" as const },
    ...(attachments ? { attachments } : {}),
  });

  async function attachImage(bytes = PNG): Promise<MessageAttachment> {
    const saved = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      bytes,
      contentType: "image/png",
    });
    return { ...artifactRef(saved), name: "参考图.png" };
  }

  it("attachment becomes the data URL the spec asked for", async () => {
    // The whole point: the model can see the picture and now it can *name* it.
    const picture = await attachImage();
    const resolved = await resolveReferenceImage("attachment", ctx([picture]));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    );
  });

  it("takes the newest when several were sent, because the last is the correction", async () => {
    const first = await attachImage(PNG);
    const second = await attachImage(new Uint8Array([1, 2, 3, 4]));
    const resolved = await resolveReferenceImage("attachment", ctx([first, second]));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.dataUrl).toContain(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("ignores attachments that are not pictures", async () => {
    const audio = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "audio",
      bytes: new Uint8Array([9, 9]),
      contentType: "audio/mpeg",
    });
    const resolved = await resolveReferenceImage("attachment", ctx([
      { ...artifactRef(audio), name: "a.mp3" },
    ]));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/没有附上图片/);
  });

  it("an http URL is passed through — that is how most vendors want one", async () => {
    const resolved = await resolveReferenceImage(
      "https://cdn.example/ref.png",
      ctx([await attachImage()]),
    );
    expect(resolved).toEqual({ ok: true, dataUrl: "https://cdn.example/ref.png" });
  });

  it("a data URL is passed through", async () => {
    const url = "data:image/png;base64,iVBOR";
    expect(await resolveReferenceImage(url, ctx())).toEqual({ ok: true, dataUrl: url });
  });

  it("anything else is refused with the three forms, not silently dropped", async () => {
    // Silently sending text-to-image when the user asked for image-to-image is
    // the worst outcome: it looks like it worked.
    const resolved = await resolveReferenceImage("参考图.png", ctx([await attachImage()]));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/attachment/);
    expect(resolved.reason).toMatch(/http/);
  });

  it("says so when the message carried no picture", async () => {
    const resolved = await resolveReferenceImage("attachment", ctx());
    expect(resolved.ok).toBe(false);
  });

  it("cannot reach a picture the user did not attach to this turn", async () => {
    // The owner check, on the path that turns an id into bytes. An artefact id
    // is a short base62 string; a tool that could resolve any of them would be
    // a way to read anybody's uploads.
    const stranger = (await createUser({
      username: "i2i2",
      password: "correct horse battery",
      displayName: "i2i2",
    }))!;
    const picture = await attachImage();
    const resolved = await resolveReferenceImage("attachment", {
      user: { ...stranger, timezone: "shanghai" as const },
      attachments: [picture],
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/读不出来/);
  });

  it("refuses a picture too large to be a sane reference", async () => {
    const huge = new Uint8Array(9 * 1024 * 1024);
    const picture = await attachImage(huge);
    const resolved = await resolveReferenceImage("attachment", ctx([picture]));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/MB/);
  });
});

describe("the tool says it can do this", () => {
  const tools = toolDefinitions(false);
  const def = tools.find((t) => t.function.name === "generate_image")!;
  const props = (def.function.parameters as { properties?: Record<string, { description?: string }> })
    .properties ?? {};

  it("has an image parameter, and says attachment is one of its values", () => {
    // The report was the model concluding from the signature that this was
    // impossible. It has to be visible in the signature.
    expect(Object.keys(props)).toContain("image");
    expect(props.image.description).toMatch(/attachment/);
  });

  it("has a ratio, because a wall paper is asked for by ratio", () => {
    expect(Object.keys(props)).toContain("ratio");
  });

  it("points at the spec for whether the model supports it", () => {
    expect(def.function.description).toMatch(/list_media_providers/);
    expect(def.function.description).toMatch(/image-to-image/);
  });

  it("and the prompt tells the model to use it rather than hand out a curl command", () => {
    expect(PROMPT_SOURCE).toMatch(/generate_image[^\n]*attachment/);
  });

  it("the turn loop passes this turn's attachments to the tools", () => {
    const CHAT = readFileSync(join(process.cwd(), "src", "lib", "assistant", "chat.ts"), "utf-8");
    expect(CHAT).toMatch(/attachments: opts\.attachments/);
  });
});

describe("and the reference actually leaves in the request", () => {
  let store: InMemoryCookieStore;
  let user: User;
  let seen: Record<string, unknown>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "i2i4",
      password: "correct horse battery",
      displayName: "i2i4",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();

    seen = {};
    fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/out.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    currentStore = null;
    vi.unstubAllGlobals();
  });

  it("puts the picture in the body, not just in the conversation", async () => {
    // The gap this file exists to close: `resolveReferenceImage` could be
    // perfect and the tool could still not send it. The key path goes over HTTP,
    // so the request body is observable — the reference is either in it or the
    // feature does not exist.
    const thread = await createAssistantThread(user.id, "照这张图");
    const saved = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      bytes: PNG,
      contentType: "image/png",
    });

    const result = await executeTool(
      "generate_image",
      JSON.stringify({ model: "image-01", prompt: "照着画一张壁纸", ratio: "16:9", image: "attachment" }),
      {
        user: { ...user, timezone: "shanghai" as const },
        relayKey: "sk-relay-test",
        gatewayBase: "https://relay.example.com",
        attachments: [{ ...artifactRef(saved), name: "参考图.png" }],
      } as never,
    );
    expect(result.ok, result.content.slice(0, 200)).toBe(true);

    expect(seen.model).toBe("image-01");
    expect(seen.ratio).toBe("16:9");
    // The thing the whole change is for.
    expect(String(seen.image)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("sends no image at all when none was asked for", async () => {
    await executeTool(
      "generate_image",
      JSON.stringify({ model: "image-01", prompt: "一只猫" }),
      {
        user: { ...user, timezone: "shanghai" as const },
        relayKey: "sk-relay-test",
        gatewayBase: "https://relay.example.com",
      } as never,
    );
    // Sending an empty `image` would be a request for image-to-image with no
    // picture, which vendors answer with an error about the reference.
    expect("image" in seen).toBe(false);
  });
});

describe("a turn with a picture the model can actually use", () => {
  let store: InMemoryCookieStore;
  let user: User;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "i2i3",
      password: "correct horse battery",
      displayName: "i2i3",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();
  });

  afterEach(() => {
    currentStore = null;
    vi.unstubAllGlobals();
  });

  it("records the attachment on the message the tools then read", async () => {
    // The chain the feature depends on, end to end and without a network call:
    // the picture the user sent is on the message, and that is the list the
    // tool resolves `attachment` against.
    const { runChat } = await import("@/lib/assistant/chat");
    const thread = await createAssistantThread(user.id, "照这张图画壁纸");
    const saved = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      bytes: PNG,
      contentType: "image/png",
    });
    const attachment: MessageAttachment = { ...artifactRef(saved), name: "参考图.png" };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const { encryptSecret } = await import("@/lib/crypto/secrets");
    await runChat({
      user: { ...user, timezone: "shanghai" as const } as never,
      settings: {
        userId: user.id,
        baseUrl: "https://upstream.example/v1",
        model: "m",
        credentialMode: null,
        accountModel: null,
        encryptedApiKey: encryptSecret("sk-upstream"),
        protocol: "openai",
        extraHeaders: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      thread,
      message: "照这张图画一张壁纸",
      attachments: [attachment],
      credential: { kind: "none", reason: "not_configured" } as never,
      emit: () => {},
    });

    const rows = await listAssistantMessages(thread.id);
    const mine = rows.find((m) => m.role === "user")!;
    expect(mine.attachments).toHaveLength(1);
    // The stored row carries the reference, not the megabytes behind it.
    expect(JSON.stringify(rows)).not.toContain(Buffer.from(PNG).toString("base64"));
  });
});
