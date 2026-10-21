/**
 * The model catalogue must show exactly what the account may call.
 *
 * The proxy enforces the intersection of two whitelists: the account owner's
 * and the key's own. The catalogue used to narrow by only the second one, and
 * an unrestricted key is the normal case — so an account whose owner had been
 * restricted to one model was still shown the whole deployment's catalogue.
 * A client picked a model off that list, called it, and got
 * `403 model_not_allowed`: the deployment advertised something it then
 * refused.
 *
 * The assistant's account path had the same gap, and it is the more expensive
 * one: its pre-flight check passed, the turn went out, and the failure came
 * back from upstream as a generic error instead of being refused by name.
 *
 * These tests pin the catalogue to the same rule the proxy enforces, and check
 * the two against each other rather than each against a fixture.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider, listProviders } from "@/lib/db/providers";
import { GET as openaiModels } from "@/app/api/v1/models/route";
import { GET as anthropicModels } from "@/app/api/anthropic/v1/models/route";
import { intersectClientModels } from "@/lib/proxy/model-catalog";
import { checkKeyStatus } from "@/lib/auth/apikey";

const MODELS = { "model-a": "upstream-a", "model-b": "upstream-b" };

async function seedProvider(): Promise<void> {
  await createProvider({
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: MODELS,
  });
}

function request(path: string, key: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

/**
 * An account whose owner is restricted to `model-a`, holding an ordinary key
 * with no whitelist of its own — the case the catalogue used to get wrong.
 */
async function restrictedOwner(): Promise<{ plainKey: string; userId: string }> {
  const owner = await createUser({
    username: "cat-owner-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: ["model-a"],
  });
  const key = await createApiKey({ userId: owner.id, label: "plain" });
  return { plainKey: key.plainKey, userId: owner.id };
}

describe("the model catalogue and the owner's whitelist", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("lists only the owner's models, even when the key narrows nothing", async () => {
    await seedProvider();
    const { plainKey } = await restrictedOwner();

    const res = await openaiModels(request("/v1/models", plainKey));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["model-a"]);
  });

  it("says the same thing on the Anthropic surface", async () => {
    await seedProvider();
    const { plainKey } = await restrictedOwner();

    const res = await anthropicModels(request("/anthropic/v1/models", plainKey));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["model-a"]);
  });

  it("a key cannot widen the owner's whitelist by naming another model", async () => {
    await seedProvider();
    const owner = await createUser({
      username: "cat-widen-" + Math.random().toString(36).slice(2, 6),
      password: "x",
      quotaType: "credits",
      quotaLimit: 1000,
      allowedModels: ["model-a"],
    });
    const key = await createApiKey({
      userId: owner.id,
      label: "widening",
      allowedModels: ["model-b"],
    });

    const res = await openaiModels(request("/v1/models", key.plainKey));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    // The intersection is empty, and an empty catalogue is the honest answer:
    // the proxy would refuse both models.
    expect(body.data.map((m) => m.id)).toEqual([]);
  });

  it("agrees with the proxy, model for model", async () => {
    await seedProvider();
    const { plainKey, userId } = await restrictedOwner();

    const res = await openaiModels(request("/v1/models", plainKey));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const listed = body.data.map((m) => m.id);

    const owner = await getUserById(userId);
    const key = await createApiKey({ userId, label: "probe" });
    const providers = await listProviders({ enabledOnly: true });

    for (const model of Object.keys(MODELS)) {
      const enforced = checkKeyStatus({
        key: { ...key.key, allowedModels: [] },
        user: owner ?? undefined,
        requestedModel: model,
      }).ok;
      // The catalogue and the enforcement are the same question, so the
      // answers have to be the same answer.
      expect(listed.includes(model), `${model}: listed=${listed.includes(model)} enforced=${enforced}`).toBe(
        enforced,
      );
    }
  });

  it("narrows the intersection itself, and not only the catalogue", async () => {
    await seedProvider();
    const { userId } = await restrictedOwner();
    const owner = await getUserById(userId);
    const key = await createApiKey({ userId, label: "any" });
    const providers = await listProviders({ enabledOnly: true });

    expect(intersectClientModels(providers, key.key, owner ?? undefined)).toEqual(["model-a"]);
    // No owner, no owner restriction — the caller's own rule.
    expect(intersectClientModels(providers, key.key)).toEqual(["model-a", "model-b"]);
  });
});
