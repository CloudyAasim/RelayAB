/**
 * tests/unit/voice-picker.test.ts
 *
 * The test panel can pick a voice.
 *
 * The voice catalogue has existed for a while — `voices` as a first-class field
 * in the media protocol, `GET /v1/audio/voices`, the assistant's `list_voices`
 * tool — and the **test panel could not use it**. Its voice field was a free
 * text box with one hard-coded MiniMax voice in it, so the way to find out
 * which voice a deployment has was to leave the panel and call an endpoint.
 *
 * Three things this file holds up:
 *
 *  1. **The filter.** A voice narrowed to a set of models is offered for those
 *     models only; a voice nobody narrowed applies to all of them; and a voice
 *     narrowed to *nothing* applies to none of them. The last one is the claim
 *     that is easy to turn into the wrong answer.
 *  2. **The route.** The picker reads the catalogue over the session, because
 *     the public endpoint needs a bearer key and the tester's "account" mode
 *     does not have one. It is the same read, not a second one.
 *  3. **The panel.** The field is a picker, and the manual entry stays — a
 *     catalogue is not completeness, and a vendor voice cloned five minutes
 *     ago is not in a list that is cached for five.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { applicableVoices, type VoiceOption } from "@/app/(user)/dashboard/models/MediaTester";
import { GET } from "@/app/api/assistant/voices/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createMediaProvider } from "@/lib/db/media-providers";
import { OPENAI_TTS_SPEC } from "@/lib/media/seeds";
import { __resetVoiceCatalogueCacheForTest } from "@/lib/media/voices";
import { getSessionFromStore, InMemoryCookieStore } from "@/lib/auth/session";
import { DICTS } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const TESTER_SRC = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "models", "MediaTester.tsx"),
  "utf-8",
);
const ROUTE_SRC = readFileSync(
  join(ROOT, "src", "app", "api", "assistant", "voices", "route.ts"),
  "utf-8",
);

const VOICES: VoiceOption[] = [
  { id: "alloy", name: "Alloy", provider: "OpenAI", models: ["gpt-4o-mini-tts"] },
  { id: "verse", name: "Verse", provider: "OpenAI", models: null },
  { id: "nobody", name: "Nobody", provider: "OpenAI", models: [] },
];

describe("which voices belong to the selected model", () => {
  it("offers the ones narrowed to it", () => {
    expect(applicableVoices(VOICES, "gpt-4o-mini-tts").map((v) => v.id)).toContain("alloy");
    expect(applicableVoices(VOICES, "gpt-4o-mini-tts").map((v) => v.id)).not.toContain(
      "nobody",
    );
  });

  it("offers the ones nobody narrowed, for every model", () => {
    // `models: null` is "not narrowed" — the voice applies to every model its
    // provider serves. It is not "unknown", and it is not `[]`.
    expect(applicableVoices(VOICES, "gpt-4o-mini-tts").map((v) => v.id)).toContain("verse");
    expect(applicableVoices(VOICES, "some-other-model").map((v) => v.id)).toContain("verse");
  });

  it("offers a voice narrowed to nothing for no model at all", () => {
    // `[]` is the claim "works with no model" — a different answer, and showing
    // it as if it applied would be a voice the vendor does not have.
    expect(applicableVoices(VOICES, "gpt-4o-mini-tts").map((v) => v.id)).not.toContain(
      "nobody",
    );
    expect(applicableVoices(VOICES, "anything").map((v) => v.id)).not.toContain("nobody");
  });

  it("and nothing at all when the catalogue is empty", () => {
    expect(applicableVoices([], "gpt-4o-mini-tts")).toEqual([]);
  });
});

describe("GET /api/assistant/voices", () => {
  beforeEach(async () => {
    __resetDbForTest();
    __resetVoiceCatalogueCacheForTest();
    currentStore = null;
  });

  async function signedIn(): Promise<void> {
    const user = await createUser({
      username: "voice-picker",
      password: "correct horse battery",
      displayName: "voice-picker",
    });
    const store = new InMemoryCookieStore();
    const session = await getSessionFromStore(store);
    session.userId = user!.id;
    session.username = user!.username;
    session.role = "user";
    await session.save();
    currentStore = store;
  }

  it("refuses a caller with no session", async () => {
    // An empty store, not a null one: a request without a session cookie is
    // not a request without a cookie jar, and `null` would be a store the
    // session layer refuses to read rather than a caller who is not signed in.
    currentStore = new InMemoryCookieStore();
    const res = await GET(new Request("https://relay.test/api/assistant/voices"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unauthenticated");
  });

  it("answers with the deployment's catalogue", async () => {
    await createMediaProvider({
      name: "OpenAI Audio",
      baseUrl: "https://api.openai.com",
      apiKey: "vendor-key",
      specs: [OPENAI_TTS_SPEC] as unknown as Record<string, unknown>[],
    });
    await signedIn();

    const res = await GET(new Request("https://relay.test/api/assistant/voices"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { voices: Array<{ id: string; models: string[] | null }>; unavailable: unknown[] };
    };
    expect(body.ok).toBe(true);
    // The same entries `/v1/audio/voices` returns — a declared-only catalogue
    // never touches the network, so this is thirteen entries and no fetch.
    expect(body.data.voices.length).toBeGreaterThan(0);
    expect(body.data.voices.map((v) => v.id)).toContain("alloy");
    expect(body.data.unavailable).toEqual([]);
  });

  it("reads the same collector the public endpoint and the assistant read", async () => {
    // Three surfaces, one list: the API, the assistant's `list_voices` and the
    // picker. A second collection path would be a second answer.
    expect(ROUTE_SRC).toContain('from "@/lib/media/voices"');
    expect(ROUTE_SRC).toContain("collectVoiceCatalogue");
  });
});

describe("the test panel", () => {
  it("offers a picker, and keeps the manual entry", () => {
    // The manual entry is not decoration: a provider whose listing could not
    // be read contributes nothing to the catalogue, and a voice cloned after
    // the last listing is not in it either.
    expect(TESTER_SRC).toContain("<select");
    expect(TESTER_SRC).toContain('id="media-voice"');
    expect(TESTER_SRC).toContain('id="media-voice-custom"');
    expect(TESTER_SRC).toContain("CUSTOM_VOICE");
  });

  it("fetches the catalogue when a speech model is selected, not with the page", () => {
    // `discoverMedia` runs on the caller's signal and has no deadline of its
    // own, so a vendor that stops answering would otherwise hold the models
    // page open for everybody who visits it.
    expect(TESTER_SRC).toContain('fetch("/api/assistant/voices")');
    expect(TESTER_SRC).toContain('capability !== "audio.tts"');
  });

  it("keeps the pre-filled voice as the fallback, not as the answer", () => {
    // MiniMax rejects a request with no voice at all, so there has to be one
    // when the catalogue cannot be read. It is the fallback now, not the only
    // thing the field ever holds.
    expect(TESTER_SRC).toContain("const DEFAULT_TTS_VOICE");
    expect(TESTER_SRC).toMatch(/setVoice\(applicableVoiceList\[0\]\.id\)/);
  });

  it("and the words it shows are in the dictionary, in both languages", () => {
    for (const key of [
      "dashboard.models.media.voiceCustom",
      "dashboard.models.media.voiceLoading",
      "dashboard.models.media.voiceEmpty",
      "dashboard.models.media.voiceListHint",
      "dashboard.models.media.voiceUnavailable",
      "dashboard.models.media.voiceFailed",
      "docs.media.voicePicker",
    ]) {
      expect(DICTS["zh-CN"][key], `${key} is missing in zh-CN`).toBeTruthy();
      expect(DICTS.en[key], `${key} is missing in en`).toBeTruthy();
    }
  });
});
