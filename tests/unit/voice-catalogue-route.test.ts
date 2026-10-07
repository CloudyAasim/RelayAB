/**
 * tests/unit/voice-catalogue-route.test.ts
 *
 * `GET /v1/audio/voices`, and the collector behind it.
 *
 * The catalogue is the first media read that is *not* a production call, which
 * is what makes it interesting: it walks every enabled provider, reaches out to
 * some of them, and answers with whatever came back. Every way that can go
 * wrong is a way a client believes something false:
 *  - a failed vendor listing that reads as "this account has no voices", so the
 *    failing provider has to be named in `unavailable` while the others answer;
 *  - a declaration silently overwriting the vendor's own answer, because
 *    `declared` is remembered and `remote` is live;
 *  - `models: []` standing in for "nobody narrowed this voice", which is the
 *    claim "works with no model at all".
 *
 * And the two structural facts worth pinning: a `declared`-only catalogue never
 * touches the network (OpenAI has no listing endpoint, so reaching for one would
 * mean inventing it), and the route answers on an empty pool, because a read
 * cannot spend and "what can I speak with" is asked when the balance is short.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, incrementUserQuotaUsed } from "@/lib/db/users";
import { createMediaProvider } from "@/lib/db/media-providers";
import { MINIMAX_TTS_SPEC, OPENAI_TTS_SPEC } from "@/lib/media/seeds";
import type { MediaSpec } from "@/lib/media/spec";
import {
  __resetVoiceCatalogueCacheForTest,
  collectVoiceCatalogue,
  type CatalogueVoice,
} from "@/lib/media/voices";
import { GET } from "@/app/api/v1/audio/voices/route";

/** A TTS spec with a flat listing endpoint, for the merge cases. */
function ttsSpec(voices: Record<string, unknown>): MediaSpec {
  return {
    specVersion: 1,
    capability: "audio.tts",
    displayName: "Test TTS",
    models: ["tts-test"],
    transport: { method: "POST", path: "/v1/t2a_v2" },
    auth: { type: "bearer" },
    response: { items: [{ kind: "base64", encoding: "hex", value: "$.data.audio" }] },
    voices,
  } as unknown as MediaSpec;
}

const FLAT_REMOTE = {
  transport: { method: "POST", path: "/v1/voices" },
  request: { kind: "all" },
  response: { voices: { $from: "$.voices", $to: { id: "$.voice_id", name: "$.voice_name", models: "$.models" } } },
};

async function provider(input: {
  name: string;
  baseUrl: string;
  specs: MediaSpec[];
  models?: Record<string, unknown>;
}): Promise<string> {
  const created = await createMediaProvider({
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: "vendor-key",
    specs: input.specs as unknown as Record<string, unknown>[],
    ...(input.models
      ? { models: input.models as Record<string, { upstreamId: string; pricePerItem: number; enabled: boolean }> }
      : {}),
  });
  return created.id;
}

/** A fetch that records its calls and answers with one fixed body. */
function stubFetch(body: unknown): { impl: typeof fetch; state: { calls: number } } {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls += 1;
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { impl, state };
}

function byId(voices: CatalogueVoice[], id: string): CatalogueVoice {
  const found = voices.filter((v) => v.id === id);
  expect(found, `no voice ${id} in [${voices.map((v) => v.id).join(", ")}]`).toHaveLength(1);
  return found[0];
}

describe("the voice catalogue collector", () => {
  beforeEach(() => {
    __resetDbForTest();
    __resetVoiceCatalogueCacheForTest();
  });

  it("prefers the vendor's entry over a declaration of the same id", async () => {
    await provider({
      name: "Both",
      baseUrl: "https://both.test",
      specs: [
        ttsSpec({
          remote: FLAT_REMOTE,
          declared: [
            { id: "alloy", name: "Declared Alloy", models: ["gpt-4o-mini-tts"] },
          ],
        }),
      ],
    });
    const fetchImpl = stubFetch({
      voices: [
        { voice_id: "alloy", voice_name: "Live Alloy", models: ["speech-2.8-hd"] },
        { voice_id: "fresh", voice_name: "Fresh" },
      ],
    });

    const { voices } = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl });
    // One entry per id, and it is the vendor's: a live account says what it has.
    const alloy = byId(voices, "alloy");
    expect(alloy.source).toBe("vendor");
    expect(alloy.name).toBe("Live Alloy");
    // The vendor's narrowing beats the operator's, even though both named models.
    expect(alloy.models).toEqual(["speech-2.8-hd"]);
    expect(alloy.narrowedBy).toBe("vendor");
    expect(voices.filter((v) => v.id === "alloy")).toHaveLength(1);
  });

  it("keeps a declared name or model the vendor stayed silent about", async () => {
    // Field by field, not source by source: the vendor not knowing a display name
    // is not a reason to throw away the operator's.
    await provider({
      name: "Partial",
      baseUrl: "https://partial.test",
      specs: [
        ttsSpec({
          remote: FLAT_REMOTE,
          declared: [{ id: "alloy", name: "Declared Alloy", models: ["gpt-4o-mini-tts"] }],
        }),
      ],
    });
    const fetchImpl = stubFetch({ voices: [{ voice_id: "alloy" }] });

    const { voices } = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl });
    const alloy = byId(voices, "alloy");
    expect(alloy.name).toBe("Declared Alloy");
    // The declared narrowing survives, and is labelled as the operator's claim —
    // not passed off as the vendor's.
    expect(alloy.models).toEqual(["gpt-4o-mini-tts"]);
    expect(alloy.narrowedBy).toBe("declared");
    expect(alloy.source).toBe("vendor");
  });

  it("leaves models null (never []) when nobody narrowed the voice", async () => {
    await provider({
      name: "Unnarrowed",
      baseUrl: "https://unnarrowed.test",
      specs: [ttsSpec({ remote: FLAT_REMOTE })],
    });
    const fetchImpl = stubFetch({ voices: [{ voice_id: "plain" }] });

    const { voices } = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl });
    const plain = byId(voices, "plain");
    // `[]` would claim the voice works with no model at all; `null` is "not
    // narrowed", which is the truth and applies to every model the spec serves.
    expect(plain.models).toBeNull();
    expect(plain.narrowedBy).toBeNull();
    expect(JSON.parse(JSON.stringify({ data: [plain] })).data[0].models).toBeNull();
  });

  it("reports a failed provider in `unavailable` while the others still answer", async () => {
    await provider({ name: "Broken", baseUrl: "https://broken.test", specs: [ttsSpec({ remote: FLAT_REMOTE })] });
    await provider({ name: "Working", baseUrl: "https://working.test", specs: [OPENAI_TTS_SPEC] });

    const impl = (async (url: string) => {
      if (url.startsWith("https://broken.test")) throw new Error("socket hang up");
      throw new Error(`unexpected host: ${url}`);
    }) as unknown as typeof fetch;

    const { voices, unavailable } = await collectVoiceCatalogue({ fetchImpl: impl });
    // An empty list here would read as "this account has no voices".
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].provider).toBe("Broken");
    expect(unavailable[0].reason).toContain("socket hang up");
    // The provider that did answer is unaffected.
    expect(voices.length).toBe(13);
    expect(byId(voices, "verse").models).toEqual(["gpt-4o-mini-tts"]);
  });

  it("does not cache a failure, so a recovered vendor is picked up next time", async () => {
    await provider({ name: "Flaky", baseUrl: "https://flaky.test", specs: [ttsSpec({ remote: FLAT_REMOTE })] });
    const state = { calls: 0 };
    const impl = (async () => {
      state.calls += 1;
      if (state.calls === 1) throw new Error("boom");
      return Response.json({ voices: [{ voice_id: "back" }] });
    }) as unknown as typeof fetch;

    const first = await collectVoiceCatalogue({ fetchImpl: impl, now: 1000 });
    expect(first.unavailable).toHaveLength(1);
    expect(first.voices).toHaveLength(0);

    const second = await collectVoiceCatalogue({ fetchImpl: impl, now: 2000 });
    expect(second.unavailable).toEqual([]);
    expect(byId(second.voices, "back")).toBeTruthy();
  });

  it("reads MiniMax's three buckets as one list, through the shipped spec", async () => {
    await provider({
      name: "MiniMax Speech",
      baseUrl: "https://api.minimaxi.com",
      specs: [MINIMAX_TTS_SPEC],
      models: { "speech-2.8-hd": { upstreamId: "speech-2.8-hd", pricePerItem: 0, enabled: true } },
    });
    const fetchImpl = stubFetch({
      system_voice: [
        { voice_id: "English_Trustworth_Man", voice_name: "Trustworthy Man", description: ["Calm", "Male"], created_time: 1 },
        { voice_id: "Chinese_Exuberant_Girl", voice_name: "Exuberant Girl", description: ["Bright"], created_time: 2 },
      ],
      voice_cloning: [{ voice_id: "my_clone", description: ["Cloned from a sample"], created_time: 3 }],
      voice_generation: [],
      base_resp: { status_code: 0, status_msg: "success" },
    });

    const { voices, unavailable } = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl });
    expect(unavailable).toEqual([]);
    expect(voices).toHaveLength(3);

    const built = byId(voices, "English_Trustworth_Man");
    expect(built.name).toBe("Trustworthy Man");
    // Upstream describes a voice with a list of strings; the catalogue carries
    // text, so it is flattened rather than exposed as a second shape.
    expect(built.description).toBe("Calm,Male");
    expect(built.source).toBe("vendor");

    // A clone has no display name upstream — reported as absent, not invented.
    const clone = byId(voices, "my_clone");
    expect(clone.name).toBeNull();
    expect(clone.description).toBe("Cloned from a sample");

    // It is the account's own library, so it is reported under the client model
    // a caller would actually send.
    expect(built.provider).toContain("speech-2.8-hd");
  });

  it("takes a bare id string as a voice and nothing else", async () => {
    // A vendor that answers `["one","two"]` is described with a pass-through
    // projector. That is the spec's decision, not the collector's: a projector
    // that reads `$.voice_id` off a string resolves nothing, and the entries are
    // correctly unusable rather than mysteriously missing.
    await provider({
      name: "Bare",
      baseUrl: "https://bare.test",
      specs: [
        ttsSpec({
          remote: {
            transport: { method: "GET", path: "/v1/voices" },
            response: { voices: { $from: "$.voices", $to: "$" } },
          },
        }),
      ],
    });
    const fetchImpl = stubFetch({ voices: ["one", "two"] });

    const { voices } = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl });
    expect(voices.map((v) => v.id)).toEqual(["one", "two"]);
    // A bare string says an id and nothing else, so the rest stays null rather
    // than being filled in with plausible-looking defaults.
    expect(voices[0].name).toBeNull();
    expect(voices[0].description).toBeNull();
    expect(voices[0].models).toBeNull();
  });

  it("reuses a provider's cached voices for five minutes, then asks again", async () => {
    await provider({ name: "Cached", baseUrl: "https://cached.test", specs: [ttsSpec({ remote: FLAT_REMOTE })] });
    const fetchImpl = stubFetch({ voices: [{ voice_id: "one" }] });

    await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl, now: 10_000 });
    expect(fetchImpl.state.calls).toBe(1);
    const again = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl, now: 10_000 + 299_000 });
    expect(fetchImpl.state.calls).toBe(1);
    expect(again.voices).toHaveLength(1);
    const later = await collectVoiceCatalogue({ fetchImpl: fetchImpl.impl, now: 10_000 + 300_000 });
    expect(fetchImpl.state.calls).toBe(2);
    expect(later.voices).toHaveLength(1);
  });

  it("asks a declared-only catalogue for nothing at all", async () => {
    // OpenAI has no voice endpoint. If the collector reached for one it would
    // either fail or invent an endpoint, and the test that catches that is
    // "nothing was called".
    await provider({ name: "OpenAI Audio", baseUrl: "https://api.openai.com", specs: [OPENAI_TTS_SPEC] });
    const impl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const { voices, unavailable } = await collectVoiceCatalogue({ fetchImpl: impl });
    expect(impl).not.toHaveBeenCalled();
    expect(unavailable).toEqual([]);
    expect(voices).toHaveLength(13);
    // Declared is a source in its own right, not a consolation prize: every entry
    // says so, and the narrowing says who narrowed it.
    expect(voices.every((v) => v.source === "declared" && v.narrowedBy === "declared")).toBe(true);
  });

  it("ignores a provider whose specs carry no catalogue", async () => {
    await provider({
      name: "No voices",
      baseUrl: "https://none.test",
      specs: [MINIMAX_TTS_SPEC].map((s) => ({ ...s, voices: undefined })) as MediaSpec[],
    });
    const impl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    const { voices } = await collectVoiceCatalogue({ fetchImpl: impl });
    expect(voices).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

function request(key?: string): Request {
  return new Request("https://relay.test/v1/audio/voices", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
}

async function account(over: { quotaLimit?: number; spend?: number } = {}): Promise<string> {
  const user = await createUser({
    username: "voice-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: over.quotaLimit ?? 500_000,
  });
  if (over.spend) await incrementUserQuotaUsed(user.id, over.spend);
  const { plainKey } = await createApiKey({ userId: user.id, label: "k" });
  return plainKey;
}

describe("GET /v1/audio/voices", () => {
  beforeEach(() => {
    __resetDbForTest();
    __resetVoiceCatalogueCacheForTest();
  });

  it("answers 200 with the list envelope", async () => {
    await provider({ name: "OpenAI Audio", baseUrl: "https://api.openai.com", specs: [OPENAI_TTS_SPEC] });
    const res = await GET(request(await account()));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
      unavailable: unknown[];
    };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(13);
    expect(body.unavailable).toEqual([]);
    expect(body.data[0]).toMatchObject({ id: "alloy", source: "declared", narrowedBy: "declared" });
    // The pool figures travel with it, like every other /v1 response.
    expect(res.headers.get("x-ratelimit-remaining")).toBe("500000");
  });

  it("answers even when the caller's pool is empty, because a read cannot spend", async () => {
    await provider({ name: "OpenAI Audio", baseUrl: "https://api.openai.com", specs: [OPENAI_TTS_SPEC] });
    const key = await account({ quotaLimit: 0 });
    // Without `skipQuotaCheck` this is a 403, which would make the endpoint
    // answer in exactly the situation it is most useful in.
    const res = await GET(request(key));
    expect(res.status).toBe(200);
  });

  it("refuses an unauthenticated caller, in the OpenAI error envelope", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type?: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  it("charges nothing for the read", async () => {
    await provider({ name: "OpenAI Audio", baseUrl: "https://api.openai.com", specs: [OPENAI_TTS_SPEC] });
    const key = await account({ quotaLimit: 1_000, spend: 400 });
    await GET(request(key));
    const before = await GET(request(key));
    // Two reads, one pool: `used` is unchanged because nothing settled. This is
    // the assertion that keeps the missing `settleMediaUsage` deliberate.
    expect(before.headers.get("x-ratelimit-remaining")).toBe("600");
  });
});
