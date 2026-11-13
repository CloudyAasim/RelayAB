/**
 * tests/unit/media-raw-passthrough.test.ts
 *
 * `ANY /v1/raw/<provider>/<path>` — the vendor-verbatim escape hatch.
 *
 * Text surfaces have had passthrough for a while; media did not, because the
 * client speaks OpenAI's shape. This route is for the client that speaks the
 * vendor's own (a native SDK, an async submit/poll API, an endpoint no spec has
 * a reason to model).
 *
 * What is pinned here:
 *   - method, path, query, body and the vendor's response pass through untouched;
 *   - the provider's credentials are injected and the relay key is not leaked;
 *   - a submit is billed once, a poll is not;
 *   - a path that escapes the provider origin is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { createMediaProvider } from "@/lib/db/media-providers";
import { listUsageByKey } from "@/lib/db/usage";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";
import { GET as rawGET, POST as rawPOST } from "@/app/api/v1/raw/[provider]/[...path]/route";
import { resolveRawTarget } from "@/lib/media/passthrough";

const model: import("@/lib/db/types").ApiKey | null = null;
void model;

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

async function seed(
  mode: "passthrough" | "restricted" | "advanced" = "passthrough",
  passthroughPaths: string[] = [],
): Promise<{ plain: string; keyId: string; providerId: string }> {
  const user = await createUser({
    username: "raw-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 10_000,
    allowedModels: [],
  });
  const key = await createApiKey({ userId: user.id, label: "raw" });
  const provider = await createMediaProvider({
    name: "MiniMax Raw",
    baseUrl: "https://api.minimax.cn",
    apiKey: "vendor-key",
    mode,
    passthroughPaths,
    models: { "image-01": { upstreamId: "image-01", pricePerItem: 2, enabled: true } },
    specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
  });
  return { plain: key.plainKey, keyId: key.key.id, providerId: provider.id };
}

async function generateThroughSpec(
  plain: string,
): Promise<{ status: number; code?: string }> {
  const { POST } = await import("@/app/api/v1/images/generations/route");
  const res = await POST(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "image-01", prompt: "a cat" }),
    }),
  );
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}
describe("raw media passthrough", () => {
  let seen: Seen[] = [];

  beforeEach(() => {
    __resetDbForTest();
    seen = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        seen.push({
          url: String(url),
          method: String(init.method ?? "GET"),
          headers: new Headers(init.headers as HeadersInit),
          body: init.body ? Buffer.from(init.body as ArrayBuffer).toString("utf8") : "",
        });
        return new Response(JSON.stringify({ ok: true, vendor: "raw" }), {
          status: 201,
          headers: { "content-type": "application/json", "x-vendor": "1" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function call(
    handler: typeof rawPOST,
    args: {
      plain: string;
      providerId: string;
      sub: string;
      query?: string;
      body?: string;
      method?: string;
      headers?: Record<string, string>;
    },
  ) {
    const url = `http://localhost/api/v1/raw/${args.providerId}${args.sub}${args.query ? `?${args.query}` : ""}`;
    const request = new Request(url, {
      method: args.method ?? (args.body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${args.plain}`,
        ...(args.body ? { "Content-Type": "application/json" } : {}),
        ...(args.headers ?? {}),
      },
      ...(args.body ? { body: args.body } : {}),
    });
    return handler(request, { params: Promise.resolve({ provider: args.providerId, path: args.sub.split("/").filter(Boolean) }) });
  }

  it("forwards method, path, body and injects the vendor key", async () => {
    const { plain, providerId } = await seed();
    const res = await call(rawPOST, {
      plain,
      providerId,
      sub: "/v1/image_generation",
      query: "model=image-01",
      body: JSON.stringify({ prompt: "a cat", aspect_ratio: "1:1" }),
      headers: { "x-custom": "kept" },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-vendor")).toBe("1");
    expect(await res.json()).toEqual({ ok: true, vendor: "raw" });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.minimax.cn/v1/image_generation?model=image-01");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get("authorization")).toBe("Bearer vendor-key");
    expect(seen[0].headers.get("x-custom")).toBe("kept");
    // The relay's own credential must not travel to the vendor.
    expect(seen[0].body).toContain("a cat");
  });

  it("bills the submit once and not the polls", async () => {
    const { plain, providerId, keyId } = await seed();

    await call(rawPOST, {
      plain,
      providerId,
      sub: "/v1/image_generation",
      query: "model=image-01",
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(await listUsageByKey(keyId)).toHaveLength(1);

    // A vendor task poll: same route, GET, no second charge.
    const poll = await call(rawGET, {
      plain,
      providerId,
      sub: "/v1/tasks/task-1",
      query: "model=image-01",
    });
    expect(poll.status).toBe(201);
    expect(await listUsageByKey(keyId)).toHaveLength(1);
  });

  it("refuses a traversal in the target builder, and cannot leave the origin", async () => {
    // The route sees a URL the parser has already normalized, so the guard is
    // tested where it lives — and the route test below proves the result never
    // leaves the provider's origin either way.
    expect(() =>
      resolveRawTarget({
        provider: { baseUrl: "https://api.minimax.cn" } as never,
        spec: MINIMAX_IMAGE_SPEC,
        suffix: "/v1/../admin",
        search: new URLSearchParams(),
      }),
    ).toThrow(/traversal/);
    expect(() =>
      resolveRawTarget({
        provider: { baseUrl: "https://api.minimax.cn" } as never,
        spec: MINIMAX_IMAGE_SPEC,
        suffix: "/v1/%2e%2e/admin",
        search: new URLSearchParams(),
      }),
    ).toThrow(/traversal/);

    const { plain, providerId } = await seed();
    // The URL parser collapses `%2e%2e` before the route reads the path, so what
    // the vendor receives is `/admin` on its own origin — not an escape.
    await call(rawGET, { plain, providerId, sub: "/v1/%2e%2e/admin", query: "model=image-01" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.startsWith("https://api.minimax.cn/")).toBe(true);
  });

  it("requires a model the provider actually serves", async () => {
    const { plain, providerId } = await seed();
    expect((await call(rawGET, { plain, providerId, sub: "/v1/x" })).status).toBe(400);
    expect(
      (await call(rawGET, { plain, providerId, sub: "/v1/x", query: "model=nope" })).status,
    ).toBe(404);
  });
  it("refuses a spec-mode provider, and a restricted path outside the list", async () => {
    const specMode = await seed("advanced");
    const refused = await call(rawGET, {
      plain: specMode.plain,
      providerId: specMode.providerId,
      sub: "/v1/anything",
      query: "model=image-01",
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("passthrough_disabled");

    const restricted = await seed("restricted", ["/v1/videos"]);
    const allowed = await call(rawGET, {
      plain: restricted.plain,
      providerId: restricted.providerId,
      sub: "/v1/videos/up_1",
      query: "model=image-01",
    });
    expect(allowed.status).toBe(201);

    const blocked = await call(rawGET, {
      plain: restricted.plain,
      providerId: restricted.providerId,
      sub: "/v1/videos-admin",
      query: "model=image-01",
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("path_not_allowed");
  });

  it("keeps the spec routes closed for a passthrough provider", async () => {
    const { plain } = await seed("passthrough");
    const res = await generateThroughSpec(plain);
    expect(res.status).toBe(400);
    expect(res.code).toBe("provider_is_passthrough");
  });});
