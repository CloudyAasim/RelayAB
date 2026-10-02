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
    // Both probes are refused, and neither refusal carries a size we may use.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const gone = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    const goneData = (await gone.json()).data;
    expect(goneData.bytes).toBeNull();
    expect(goneData.contentType).toBe("application/octet-stream");

    // And the awkward one: a HEAD that succeeds but carries no length at all.
    // No second probe there - the upstream answered, it just had nothing to
    // say, and asking again would not change that.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { headers: { "content-type": "image/webp" } }),
    );
    const noLength = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    const data = (await noLength.json()).data;
    expect(data.bytes).toBeNull();
    // A type the upstream did send is still worth using.
    expect(data.contentType).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to one byte when the upstream refuses the HEAD", async () => {
    // The real shape of the problem. A presigned URL is signed for the method
    // that was signed, and Aliyun OSS - where every image this deployment
    // generates lives - answers HEAD with 403 and a 1225-byte `application/xml`
    // error body. So the HEAD is tried, refused, and then the first byte is
    // asked for instead, which is enough to learn the whole length.
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://oss.example/prod/cat_aigc.jpeg?Signature=…",
      contentType: "application/octet-stream",
    });

    fetchMock.mockResolvedValueOnce(
      new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', {
        status: 403,
        headers: { "content-length": "1225", "content-type": "application/xml" },
      }),
    );
    // 206: the refusal's own headers are never what we report.
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(1), {
        status: 206,
        headers: { "content-range": "bytes 0-0/286812", "content-type": "image/jpeg" },
      }),
    );

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect(await res.json()).toEqual({
      ok: true,
      data: { bytes: 286812, contentType: "image/jpeg" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ headers: { range: "bytes=0-0" } });
  });

  it("believes nothing when both probes are refused", async () => {
    // HEAD refused, and the ranged GET refused too - a link that has expired.
    // The answer is "we do not know", not the error document's own headers,
    // which is what the first version of this endpoint reported.
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://oss.example/prod/gone.jpeg?Signature=…",
      contentType: "application/octet-stream",
    });

    const refusal = () =>
      new Response(null, {
        status: 403,
        headers: { "content-length": "1225", "content-type": "application/xml" },
      });
    fetchMock.mockResolvedValueOnce(refusal());
    fetchMock.mockResolvedValueOnce(refusal());

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    // Still a 200: the caller asked what we know, and the answer is nothing.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { bytes: null, contentType: "application/octet-stream" },
    });
  });

  it("reads the length off a server that ignores Range", async () => {
    // Asked for one byte, answered 200 with the whole file. The length is
    // still in the headers, and that is all we came for.
    const thread = await createAssistantThread(user.id, "a picture");
    const artifact = await saveAssistantArtifact({
      userId: user.id,
      threadId: thread.id,
      kind: "image",
      url: "https://cdn.example/no-range.png",
      contentType: "application/octet-stream",
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 405 }));
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(64), {
        status: 200,
        headers: { "content-length": "64", "content-type": "image/png" },
      }),
    );

    const res = await call(artifact.id, `/api/assistant/artifacts/${artifact.id}?meta=1`);
    expect(await res.json()).toEqual({
      ok: true,
      data: { bytes: 64, contentType: "image/png" },
    });
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
