/**
 * tests/unit/assistant-artifact-meta.test.ts
 *
 * `?meta=1` — "what is this file, without sending it".
 *
 * A generated image normally lives at an upstream CDN link, so its size and its
 * real content type were never measured here. The reader is shown both, and the
 * row was showing neither: the size line was simply absent, and the format line
 * read "application/octet-stream" because that is what a linked row stores.
 *
 * These tests pin the part that costs something: one HEAD to the upstream, only
 * for a row that has no bytes of its own, and never a number nobody measured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { GET } from "@/app/api/assistant/artifacts/[id]/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { createAssistantThread } from "@/lib/db/assistant";
import { saveAssistantArtifact } from "@/lib/db/assistant-artifacts";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

function request(url: string): Request {
  return new Request(`https://api.example${url}`);
}

function call(id: string, url: string): Promise<Response> {
  return GET(request(url), { params: Promise.resolve({ id }) });
}

async function signIn(store: InMemoryCookieStore, user: User): Promise<void> {
  const session = await getSessionFromStore(store);
  session.userId = user.id;
  session.username = user.username;
  session.role = user.role;
  await session.save();
}

describe("assistant: what a linked artefact weighs", () => {
  let store: InMemoryCookieStore;
  let user: User;
  let stranger: User;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    user = (await createUser({
      username: "meta-owner",
      password: "correct horse battery",
      displayName: "meta-owner",
    }))!;
    stranger = (await createUser({
      username: "meta-other",
      password: "correct horse battery",
      displayName: "meta-other",
    }))!;
    await signIn(store, user);

    // The upstream is the only thing standing between this route and the
    // network, so it is the only thing stubbed.
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    currentStore = null;
  });

  it("measures a linked file with one HEAD and reports the real type", async () => {
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://cdn.example/cat.png",
      // What a linked row actually stores: a placeholder, not the truth.
      contentType: "application/octet-stream",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        headers: { "content-length": "184320", "content-type": "image/png" },
      }),
    );

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { bytes: 184320, contentType: "image/png" },
    });
    // A HEAD, exactly once. Not a GET — this must not download a 2 MB picture
    // in order to label it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://cdn.example/cat.png");
  });

  it("reports bytes we already hold without touching the network at all", async () => {
    const thread = await createAssistantThread(user.id, "a sound");
    const bytes = new Uint8Array(2048);
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "audio",
      bytes,
      contentType: "audio/mpeg",
    });

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect(await res.json()).toEqual({
      ok: true,
      data: { bytes: 2048, contentType: "audio/mpeg" },
    });
    // There is no upstream to ask: the file is here.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows nothing rather than a number nobody measured", async () => {
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://cdn.example/gone.png",
      contentType: "application/octet-stream",
    });

    // The link has expired, which is the common case for a CDN URL days later.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    // And the awkward one: a 200 with no length header at all.
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/webp" } }));

    const missingLength = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect((await missingLength.json()).data.bytes).toBeNull();

    const noLength = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    const data = (await noLength.json()).data;
    expect(data.bytes).toBeNull();
    // A type the upstream did send is still worth using.
    expect(data.contentType).toBe("image/webp");
  });

  it("does not leak the size of somebody else's artefact", async () => {
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://cdn.example/private.png",
      bytes: new Uint8Array(4096),
      contentType: "image/png",
    });

    const strangerStore = new InMemoryCookieStore();
    await signIn(strangerStore, stranger);
    currentStore = strangerStore;

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    // The metadata endpoint is a new way to ask about a file, so it has to obey
    // the same owner check as serving it. A 200 here would hand over the
    // existence and size of every artefact id the reader ever saw.
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a session before describing anything", async () => {
    // A store with no session in it: an anonymous visitor, which is a real
    // request, not a missing cookie bag.
    currentStore = new InMemoryCookieStore();
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      bytes: new Uint8Array(16),
      contentType: "image/png",
    });

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect(res.status).toBe(401);
  });
});
