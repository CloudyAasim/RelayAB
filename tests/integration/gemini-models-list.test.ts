/**
 * tests/integration/gemini-models-list.test.ts
 *
 * `GET /v1beta/models` — the Gemini client face's model catalogue.
 *
 * A Gemini client asks for its model list before it talks. Without this route
 * the request landed on the `generateContent` catch-all, which answers 404
 * with "Unknown Gemini path" — so the client failed to start while the chat
 * endpoint was fine. The same hole the Anthropic surface had until it got
 * `GET /anthropic/v1/models`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { GET as modelsGET } from "@/app/api/v1beta/models/route";

async function seed(
  allowedModels: string[] = [],
): Promise<{ plain: string; keyPlain: string }> {
  const user = await createUser({
    username: "gm-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels,
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Upstream",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat: "responses",
    modelMapping: { "client-m": "upstream-m", "other-m": "upstream-other" },
    modelConfigs: {
      "client-m": {
        upstreamId: "upstream-m",
        clientId: "client-m",
        contextLength: 200000,
        maxOutputTokens: 64000,
      },
    },
  });
  return { plain: created.plainKey, keyPlain: user.id };
}

describe("the Gemini model list", () => {
  beforeEach(() => {
    __resetDbForTest();
    vi.unstubAllGlobals();
  });

  it("answers in Google's shape, with the limits the operator declared", async () => {
    const { plain } = await seed();

    const res = await modelsGET(
      new Request("https://api.aasim.l.cd/v1beta/models", {
        headers: { "x-goog-api-key": plain },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{
        name: string;
        displayName: string;
        inputTokenLimit: number;
        outputTokenLimit: number;
        supportedGenerationMethods: string[];
      }>;
    };
    expect(body.models.length).toBe(2);

    const named = body.models.find((m) => m.name === "models/client-m");
    expect(named).toBeTruthy();
    // Google's spelling: the name goes straight into the next request's path.
    expect(named!.displayName).toBe("client-m");
    expect(named!.inputTokenLimit).toBe(200000);
    expect(named!.outputTokenLimit).toBe(64000);
    expect(named!.supportedGenerationMethods).toEqual(["generateContent", "streamGenerateContent"]);

    // A model that declares nothing is not a model without limits.
    const other = body.models.find((m) => m.name === "models/other-m");
    expect(other!.inputTokenLimit).toBeGreaterThan(0);
    expect(other!.outputTokenLimit).toBeGreaterThan(0);
  });

  it("refuses a caller with no key", async () => {
    const res = await modelsGET(new Request("https://api.aasim.l.cd/v1beta/models"));
    expect(res.status).toBe(401);
  });

  it("lists only what the key may call", async () => {
    // The list and the enforcement have to agree: a model shown here and
    // refused there is the gap this whole module exists to close.
    const { plain } = await seed(["client-m"]);

    const res = await modelsGET(
      new Request("https://api.aasim.l.cd/v1beta/models", {
        headers: { "x-goog-api-key": plain },
      }),
    );

    const body = (await res.json()) as { models: Array<{ name: string }> };
    expect(body.models.map((m) => m.name)).toEqual(["models/client-m"]);
  });
});
