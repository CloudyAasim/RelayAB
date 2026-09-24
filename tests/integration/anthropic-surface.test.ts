/**
 *
 * Route-level tests for the Anthropic surface.
 *
 * Regression context (ONLYOFFICE "Anthropic mode" reported as unreachable):
 *
 *   1. `GET /anthropic/v1/models` did not exist, so a client configured with
 *      `https://api.aasim.l.cd/anthropic` could not load any model — the
 *      editor shows that as an empty list, not as a 404.
 *   2. `POST /v1/messages` did not exist, so a client configured with the bare
 *      origin `https://api.aasim.l.cd` (the shape ONLYOFFICE's built-in
 *      Anthropic template uses) listed models fine but failed on chat.
 *
 * These tests pin both routes and their auth carriers (`x-api-key` and
 * `Authorization: Bearer`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { GET as anthropicModelsGET } from "@/app/api/anthropic/v1/models/route";
import { POST as anthropicPOST } from "@/app/api/anthropic/v1/messages/route";
import { POST as rootMessagesPOST } from "@/app/api/v1/messages/route";

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "up-model",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
});

let openKey = "";
let narrowKey = "";

async function seed(): Promise<void> {
  await createProvider({
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "client-m": "up-model", "client-n": "up-model-2" },
  });

  const open = await createUser({
    username: "anth-open-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  openKey = (await createApiKey({ userId: open.id, label: "open" })).plainKey;

  const narrow = await createUser({
    username: "anth-narrow-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  narrowKey = (
    await createApiKey({ userId: narrow.id, label: "narrow", allowedModels: ["client-m"] })
  ).plainKey;
}

function modelsRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/anthropic/v1/models", { headers });
}

function messagesRequest(url: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(ANTHROPIC_JSON, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("Anthropic surface", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("GET /anthropic/v1/models", () => {
    it("rejects a request without a key", async () => {
      await seed();
      const res = await anthropicModelsGET(modelsRequest({}));
      expect(res.status).toBe(401);
    });

    it("rejects an unknown key", async () => {
      await seed();
      const res = await anthropicModelsGET(
        modelsRequest({ "x-api-key": "sk-relay-0000000000000000000000000000000000000000000" }),
      );
      expect(res.status).toBe(401);
    });

    it("returns the key's models in Anthropic shape", async () => {
      await seed();
      const res = await anthropicModelsGET(modelsRequest({ "x-api-key": openKey }));
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        data: Array<{ type: string; id: string; display_name: string; created_at: string }>;
        has_more: boolean;
        first_id: string | null;
        last_id: string | null;
      };

      const ids = body.data.map((m) => m.id).sort();
      expect(ids).toEqual(["client-m", "client-n"]);
      expect(body.data.every((m) => m.type === "model")).toBe(true);
      expect(body.data.every((m) => m.display_name === m.id)).toBe(true);
      expect(Number.isNaN(Date.parse(body.data[0].created_at))).toBe(false);
      expect(body.has_more).toBe(false);
      expect(body.first_id).toBe(body.data[0].id);
      expect(body.last_id).toBe(body.data[body.data.length - 1].id);
    });

    it("honours the key's model whitelist", async () => {
      await seed();
      const res = await anthropicModelsGET(modelsRequest({ "x-api-key": narrowKey }));
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((m) => m.id)).toEqual(["client-m"]);
    });

    it("accepts Authorization: Bearer as well as x-api-key", async () => {
      await seed();
      const res = await anthropicModelsGET(modelsRequest({ Authorization: `Bearer ${openKey}` }));
      expect(res.status).toBe(200);
    });
  });

  describe("POST /v1/messages (root alias)", () => {
    it("is handled exactly like /anthropic/v1/messages", async () => {
      await seed();
      stubUpstream();

      const viaRoot = await rootMessagesPOST(
        messagesRequest(
          "http://localhost:3000/v1/messages",
          { "x-api-key": openKey },
          { model: "client-m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        ),
      );
      expect(viaRoot.status).toBe(200);
      const rootBody = (await viaRoot.json()) as { type: string; content: Array<{ text: string }> };
      expect(rootBody.type).toBe("message");
      expect(rootBody.content[0].text).toBe("hi");

      const viaPrefix = await anthropicPOST(
        messagesRequest(
          "http://localhost:3000/anthropic/v1/messages",
          { "x-api-key": openKey },
          { model: "client-m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        ),
      );
      expect(viaPrefix.status).toBe(200);
      expect(await viaPrefix.json()).toEqual(rootBody);
    });

    it("rejects a request without a key", async () => {
      await seed();
      stubUpstream();
      const res = await rootMessagesPOST(
        messagesRequest(
          "http://localhost:3000/v1/messages",
          {},
          { model: "client-m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
        ),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a body without max_tokens", async () => {
      await seed();
      stubUpstream();
      const res = await rootMessagesPOST(
        messagesRequest(
          "http://localhost:3000/v1/messages",
          { "x-api-key": openKey },
          { model: "client-m", messages: [{ role: "user", content: "hi" }] },
        ),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("missing_max_tokens");
    });
  });
});
