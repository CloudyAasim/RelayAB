/**
 * tests/unit/media-provider-exclusivity.test.ts
 *
 * **A media provider is spoken to one way, never two.**
 *
 * The four modes are a single column, and the point of this file is that the
 * exclusivity is real rather than nominal:
 *
 *   advanced / simple  → the spec routes answer, /v1/raw does not
 *   passthrough / restricted → /v1/raw answers, the spec routes do not
 *
 * Everything that *advertises* a provider has to agree, or a client is told about
 * a route that will refuse it. So the model catalogue and the voice catalogue are
 * checked here too: a passthrough provider must not appear in either, even when
 * the row still carries specs from before the mode changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { createMediaProvider, resolveMediaProviderForModel } from "@/lib/db/media-providers";
import { MINIMAX_IMAGE_SPEC, OPENAI_TTS_SPEC } from "@/lib/media/seeds";
import { listClientMediaModelEntries } from "@/lib/proxy/model-catalog";
import { collectVoiceCatalogue } from "@/lib/media/voices";
import { POST as imagesPOST } from "@/app/api/v1/images/generations/route";
import { GET as rawGET } from "@/app/api/v1/raw/[provider]/[...path]/route";

async function seedUser() {
  const user = await createUser({
    username: "excl-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 10_000,
    allowedModels: [],
  });
  const key = await createApiKey({ userId: user!.id, label: "excl" });
  return { user: user!, key };
}

describe("one provider, one way to call it", () => {
  beforeEach(() => {
    __resetDbForTest();
    // No upstream is reached in these tests; any call that would reach one is a bug.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a passthrough provider serves /v1/raw and not the spec routes", async () => {
    const { user, key } = await seedUser();
    const provider = await createMediaProvider({
      name: "Vendor",
      baseUrl: "https://v.test",
      apiKey: "k",
      mode: "passthrough",
      // Deliberately keeps a spec: the row may carry one from before the switch,
      // and that must not open the spec routes again.
      models: { "m-1": { upstreamId: "m-1", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });

    const raw = await rawGET(
      new Request(`http://localhost/v1/raw/${provider.id}/v1/anything?model=m-1`, {
        headers: { Authorization: `Bearer ${key.plainKey}` },
      }),
      { params: Promise.resolve({ provider: provider.id, path: ["v1", "anything"] }) },
    );
    expect(raw.status).toBe(200);

    const spec = await imagesPOST(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.plainKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m-1", prompt: "a cat" }),
      }),
    );
    expect(spec.status).toBe(400);
    expect(((await spec.json()) as { error: { code: string } }).error.code).toBe("provider_is_passthrough");
    expect(user.id).toBeTruthy();
  });

  it("an advanced provider serves the spec routes and not /v1/raw", async () => {
    const { key } = await seedUser();
    const provider = await createMediaProvider({
      name: "Vendor",
      baseUrl: "https://v.test",
      apiKey: "k",
      mode: "advanced",
      models: { "m-1": { upstreamId: "m-1", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });

    const raw = await rawGET(
      new Request(`http://localhost/v1/raw/${provider.id}/v1/anything?model=m-1`, {
        headers: { Authorization: `Bearer ${key.plainKey}` },
      }),
      { params: Promise.resolve({ provider: provider.id, path: ["v1", "anything"] }) },
    );
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("passthrough_disabled");
  });

  it("does not advertise a passthrough provider's models on the OpenAI surface", async () => {
    const { user, key } = await seedUser();
    await createMediaProvider({
      name: "Spec Vendor",
      baseUrl: "https://spec.test",
      apiKey: "k",
      mode: "advanced",
      models: { "spec-model": { upstreamId: "spec-model", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });
    await createMediaProvider({
      name: "Raw Vendor",
      baseUrl: "https://raw.test",
      apiKey: "k",
      mode: "passthrough",
      models: { "raw-model": { upstreamId: "raw-model", pricePerItem: 1, enabled: true } },
      specs: [],
    });

    const ids = (await listClientMediaModelEntries(key.key, 0, user)).map((entry) => entry.id);
    expect(ids).toContain("spec-model");
    expect(ids).not.toContain("raw-model");
  });

  it("does not list a passthrough provider's voices", async () => {
    const specProvider = await createMediaProvider({
      name: "Spec Voice",
      baseUrl: "https://spec.test",
      apiKey: "k",
      mode: "advanced",
      models: { "tts-1": { upstreamId: "tts-1", pricePerItem: 1, enabled: true } },
      specs: [OPENAI_TTS_SPEC as unknown as Record<string, unknown>],
    });
    const rawProvider = await createMediaProvider({
      name: "Raw Voice",
      baseUrl: "https://raw.test",
      apiKey: "k",
      mode: "passthrough",
      models: { "tts-1": { upstreamId: "tts-1", pricePerItem: 1, enabled: true } },
      specs: [OPENAI_TTS_SPEC as unknown as Record<string, unknown>],
    });

    const catalogue = await collectVoiceCatalogue();
    // The label is `<provider id>:<model>`; matching by id keeps the assertion
    // independent of how that label is spelled.
    const providers = [...new Set(catalogue.voices.map((voice) => voice.provider))];
    expect(providers.some((label) => label.includes(specProvider.id))).toBe(true);
    expect(providers.some((label) => label.includes(rawProvider.id))).toBe(false);
  });

  it("picks the spec provider when both kinds list the same model", async () => {
    await createMediaProvider({
      name: "Raw Vendor",
      baseUrl: "https://raw.test",
      apiKey: "k",
      mode: "passthrough",
      priority: 0,
      models: { shared: { upstreamId: "shared", pricePerItem: 1, enabled: true } },
      specs: [],
    });
    const spec = await createMediaProvider({
      name: "Spec Vendor",
      baseUrl: "https://spec.test",
      apiKey: "k",
      mode: "advanced",
      priority: 9,
      models: { shared: { upstreamId: "shared", pricePerItem: 1, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });

    const resolved = await resolveMediaProviderForModel("shared");
    expect(resolved?.provider.id).toBe(spec.id);
  });
});
