/**
 * tests/unit/assistant-media-test-account.test.ts
 *
 * `/api/assistant/test-media` on the account path, including the one capability
 * that used to be excluded from it.
 *
 * Speech recognition was refused here because it carries a file and this route
 * spoke JSON. The panel said so, which was honest — and it also meant the one
 * capability that most needs testing could not spend the credential the user
 * had just switched on. The route now takes multipart for exactly that case.
 *
 * The upstream is stubbed, so what is under test is the route's own decisions:
 * what it accepts, what it refuses, and whether it charges before it answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { POST } from "@/app/api/assistant/test-media/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import {
  createAssistantCredential,
  getAssistantCredential,
  setAssistantCredentialEnabled,
} from "@/lib/db/assistant-keys";
import { __resetAssistantRateLimitForTest } from "@/lib/assistant/rate-limit";
import { createMediaProvider } from "@/lib/db/media-providers";
import { MINIMAX_IMAGE_SPEC, MINIMAX_STT_SPEC } from "@/lib/media/seeds";

function json(body: unknown): Request {
  return new Request("https://api.example/api/assistant/test-media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sttUpload(model: string, bytes: number = 64): Request {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new File([new Uint8Array(bytes)], "clip.mp3", { type: "audio/mpeg" }));
  form.append("language", "zh");
  return new Request("https://api.example/api/assistant/test-media", { method: "POST", body: form });
}

describe("the media test page, spending the caller's own identity", () => {
  let store: InMemoryCookieStore;
  let user: User;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetDbForTest();
    __resetAssistantRateLimitForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "mediatest",
      password: "correct horse battery",
      displayName: "mediatest",
      quotaType: "credits",
      quotaLimit: 1_000_000,
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    currentStore = null;
  });

  async function seedStt(): Promise<void> {
    await createMediaProvider({
      name: "MiniMax ASR",
      baseUrl: "https://upstream.test",
      apiKey: "vendor-key",
      models: { "asr-1.0": { upstreamId: "asr-1.0", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_STT_SPEC as unknown as Record<string, unknown>],
    });
  }

  async function switchOn(): Promise<void> {
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);
  }

  it("accepts a transcription upload and runs it on the account credential", async () => {
    await switchOn();
    await seedStt();

    // Whatever the vendor answers, the route must not refuse on the grounds
    // that it is an account call with a file.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "这是一段转写", base_resp: { status_code: 0, status_msg: "success" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await POST(sttUpload("asr-1.0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.via).toBe("account");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still refuses the whole turn when the switch is off", async () => {
    // Adding a content type must not have loosened the credential check, which
    // is the thing that actually decides who pays.
    await createAssistantCredential(user.id);
    const res = await POST(sttUpload("asr-1.0"));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("no_credential");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a transcription with no file, by name", async () => {
    await switchOn();
    const form = new FormData();
    form.append("model", "speech-02");
    const res = await POST(
      new Request("https://api.example/api/assistant/test-media", { method: "POST", body: form }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("音频文件");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    await switchOn();
    const form = new FormData();
    form.append("model", "speech-02");
    form.append("file", new File([], "empty.mp3", { type: "audio/mpeg" }));
    const res = await POST(
      new Request("https://api.example/api/assistant/test-media", { method: "POST", body: form }),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still takes the three JSON capabilities the way it always did", async () => {
    // Adding a branch must not have changed the shape the other three arrive in.
    await switchOn();
    await createMediaProvider({
      name: "MiniMax Media",
      baseUrl: "https://upstream.test",
      apiKey: "vendor-key",
      models: { "image-01": { upstreamId: "image-01", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { image_base64: [Buffer.from("PNG").toString("base64")] },
          metadata: { success_count: 1 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const res = await POST(
      json({ capability: "image.generate", model: "image-01", prompt: "一只猫", size: "1024x1024" }),
    );
    expect(res.status).toBe(200);
    // The image came back inline, so the route reports it as a count rather
    // than a list of links.
    expect((await res.json()).data.b64).toBe(1);
  });

  it("still refuses an empty prompt on a JSON capability", async () => {
    await switchOn();
    const res = await POST(json({ capability: "image.generate", model: "image-01", prompt: "  " }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs a session, like everything else", async () => {
    currentStore = new InMemoryCookieStore();
    const res = await POST(sttUpload("asr-1.0"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the credential on the caller's own account, not somebody else's", async () => {
    await switchOn();
    await seedStt();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "ok", base_resp: { status_code: 0, status_msg: "success" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const other = (await createUser({
      username: "mediatrst",
      password: "correct horse battery",
      displayName: "mediatrst",
    }))!;
    const otherStore = new InMemoryCookieStore();
    const otherSession = await getSessionFromStore(otherStore);
    otherSession.userId = other.id;
    otherSession.username = other.username;
    otherSession.role = other.role;
    await otherSession.save();
    currentStore = otherStore;

    // The switch is on for `user`, not for `other`. A turn here must not spend
    // the first account's credential.
    const res = await POST(sttUpload("asr-1.0"));
    expect(res.status).toBe(409);
    expect((await getAssistantCredential(user.id))?.enabled).toBe(true);
  });
});
