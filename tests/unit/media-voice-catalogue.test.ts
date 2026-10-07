/**
 * tests/unit/media-voice-catalogue.test.ts
 *
 * A voice catalogue is the first thing in the media protocol that enumerates
 * rather than produces, and that is exactly why it does not go through
 * `executeMedia`: the artefact contract is `{kind, value}` with `value`
 * normalised as though it were a URL, so a display name like 「沉稳高管」 would
 * come back as a URL-shaped item and a per-model narrowing would have nowhere to
 * live.
 *
 * These tests pin the two halves that the rest of the feature stands on:
 *
 *  1. The spec field is validated, because a voice id is a value the gateway
 *     forwards to a vendor on a live call. It lives beside `request` and
 *     `response` rather than in `metadata` for that reason alone.
 *  2. `discoverMedia` returns the mapped response, so the fields a caller
 *     actually needs survive.
 */
import { describe, it, expect, vi } from "vitest";

import { parseMediaSpec } from "@/lib/media/spec";
import type { MediaProvider, MediaVoiceRemote, MediaSpec } from "@/lib/media/spec";
import { discoverMedia } from "@/lib/media/engine";
import { encryptSecret } from "@/lib/crypto/secrets";

const provider: MediaProvider = {
  id: "p1",
  name: "Vendor",
  baseUrl: "https://vendor.test",
  // A real one: `discoverMedia` attaches the vendor credential the same way
  // `executeMedia` does, so a placeholder here fails before the request is made.
  encryptedApiKey: encryptSecret("vendor-key"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
} as unknown as MediaProvider;

function spec(over: Record<string, unknown> = {}): MediaSpec {
  return {
    specVersion: 1,
    capability: "audio.tts",
    transport: { method: "POST", path: "/v1/t2a_v2" },
    auth: { type: "bearer" },
    response: { text: "$.text" },
    ...over,
  } as unknown as MediaSpec;
}

/** A vendor that answers with a flat array of voice objects. */
const FLAT_REMOTE = {
  transport: { method: "POST", path: "/v1/voices" },
  request: { kind: "all" },
  response: {
    voices: {
      $from: "$.voices",
      $to: { id: "$.voice_id", name: "$.voice_name", models: "$.models" },
    },
  },
};

describe("the voice catalogue is part of the spec, not free-form metadata", () => {
  it("accepts a remote source and a declared list together", () => {
    const parsed = parseMediaSpec(
      spec({
        voices: {
          remote: FLAT_REMOTE,
          declared: [{ id: "alloy", name: "Alloy" }],
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.voices?.remote?.transport.path).toBe("/v1/voices");
    expect(parsed.spec.voices?.declared).toEqual([{ id: "alloy", name: "Alloy" }]);
  });

  it("rejects a declared voice with no id", () => {
    const parsed = parseMediaSpec(spec({ voices: { declared: [{ name: "Alloy" }] } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join("\n")).toMatch(/needs a non-empty string `id`/);
  });

  it("rejects a non-string id, because it would be forwarded to a vendor", () => {
    const parsed = parseMediaSpec(spec({ voices: { declared: [{ id: 42 }] } }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects models that are not a list of names", () => {
    const parsed = parseMediaSpec(
      spec({ voices: { declared: [{ id: "alloy", models: "gpt-4o-mini-tts" }] } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a remote source with no transport or no response mapping", () => {
    const noTransport = parseMediaSpec(spec({ voices: { remote: { response: {} } } }));
    expect(noTransport.ok).toBe(false);
    const noResponse = parseMediaSpec(
      spec({ voices: { remote: { transport: { method: "GET", path: "/v" } } } }),
    );
    expect(noResponse.ok).toBe(false);
  });

  it("drops a duplicate declaration but says so", () => {
    const parsed = parseMediaSpec(
      spec({ voices: { declared: [{ id: "alloy" }, { id: "alloy", name: "Again" }] } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.voices?.declared).toHaveLength(1);
    expect(parsed.warnings.join("\n")).toMatch(/listed more than once/);
  });

  it("warns when a catalogue would contribute nothing", () => {
    const parsed = parseMediaSpec(spec({ voices: { declared: [] } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.join("\n")).toMatch(/contributes no voices/);
  });
});

describe("discoverMedia returns the mapped response, not collected items", () => {
  const remote = FLAT_REMOTE as unknown as MediaVoiceRemote;

  it("keeps the fields a voice needs, which MediaItem could not carry", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        voices: [
          { voice_id: "steady_exec", voice_name: "沉稳高管", models: ["speech-2.8-hd"] },
          { voice_id: "news_anchor", voice_name: "新闻女声" },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await discoverMedia({
      spec: spec(),
      remote,
      provider,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The whole point: these survive. A `MediaItem[]` would have flattened every
    // entry to a single `value` string and dropped the rest.
    const voices = (out.payload as { voices: Array<Record<string, unknown>> }).voices;
    expect(voices).toHaveLength(2);
    expect(voices[0]).toMatchObject({ id: "steady_exec", name: "沉稳高管" });
    // A model list passes through untouched when the vendor supplies one, and is
    // absent rather than invented when it does not.
    expect(voices[0].models).toEqual(["speech-2.8-hd"]);
    expect(voices[1].models).toBeUndefined();
  });

  it("sends the request mapping the spec declared", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ voices: [] });
    }) as unknown as typeof fetch;

    await discoverMedia({ spec: spec(), remote, provider, fetchImpl });
    expect(seen[0].url).toBe("https://vendor.test/v1/voices");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBe(JSON.stringify({ kind: "all" }));
  });

  it("reports a vendor's in-body error code rather than a generic 502", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ base_resp: { status_code: 1004, status_msg: "bad key" } }),
    ) as unknown as typeof fetch;

    const out = await discoverMedia({
      spec: spec({
        errors: [
          {
            when: { $eq: ["$.base_resp.status_code", 1004] },
            status: 502,
            code: "upstream_auth_failed",
            message: "voice listing was refused",
          },
        ],
      }),
      remote,
      provider,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("upstream_auth_failed");
  });

  it("a catalogue with no remote source must not touch the network at all", async () => {
    // OpenAI has no voice endpoint, so its catalogue is `declared` only. If the
    // collector reached for a remote that was not declared it would either fail
    // or, worse, invent one — and the test that would catch it is "nothing was
    // called", not "something was called successfully".
    let called = false;
    const fetchImpl = vi.fn(async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;

    const out = await discoverMedia({
      spec: spec(),
      remote: undefined as unknown as MediaVoiceRemote,
      provider,
      fetchImpl,
    });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
  });
});
