/**
 * tests/unit/media-multi-image.test.ts
 *
 * More than one reference image, end to end through the real route.
 *
 * Before 2026-11-13 `/v1/images/edits` read only the first `image` field, so a
 * client that sent four references silently got an edit based on one. The scope
 * now carries `images` (every upload, in order) next to `image` (the first), and
 * a spec builds the vendor's shape with `$from`/`$to`.
 *
 * The shape under test is H3's: `images: [{ image_url }]`, one object per
 * reference. It is the reason `$from` became legal in a request mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { createMediaProvider } from "@/lib/db/media-providers";
import { POST as editsPOST } from "@/app/api/v1/images/edits/route";
import { applyMapping } from "@/lib/media/engine";

const H3_EDIT_SPEC = {
  specVersion: 1,
  capability: "image.edit",
  displayName: "H3 multi-reference",
  transport: { method: "POST", path: "/v1/images/edits", contentType: "application/json" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    prompt: "$.prompt",
    n: "$.n",
    // The whole point: a flat client array becomes the vendor's object array.
    images: { $from: "$.images", $to: { image_url: { $dataUrl: "$" } } },
  },
  response: {
    items: { $from: "$.data.images", $to: { kind: "url", value: "$" } },
    successCount: "$.data.success_count",
  },
  metadata: { modes: ["image-to-image"], edit_mode: "reference", max_reference_images: 16 },
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let calls: Array<{ url: string; body: string }> = [];

async function seed(): Promise<string> {
  const user = await createUser({
    username: "m-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 100_000,
    allowedModels: [],
  });
  const key = await createApiKey({ userId: user.id, label: "l" });
  await createMediaProvider({
    name: "H3",
    baseUrl: "https://h3.test",
    apiKey: "vendor-key",
    models: { "h3-edit": { upstreamId: "h3-edit", pricePerItem: 1, enabled: true } },
    specs: [H3_EDIT_SPEC],
  });
  return key.plainKey;
}

function editRequest(plain: string, files: Array<[string, string]>): Request {
  const form = new FormData();
  form.set("model", "h3-edit");
  form.set("prompt", "combine these references");
  for (const [field, name] of files) {
    form.append(field, new File([PNG], name, { type: "image/png" }));
  }
  return new Request("http://localhost:3000/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${plain}` },
    body: form,
  });
}

describe("multiple reference images on /v1/images/edits", () => {
  beforeEach(() => {
    __resetDbForTest();
    calls = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({ data: { images: ["https://cdn.example/out.png"], success_count: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends every reference, in order, as the vendor's object array", async () => {
    const plain = await seed();
    const res = await editsPOST(
      editRequest(plain, [
        ["image", "a.png"],
        ["image", "b.png"],
        ["image", "c.png"],
      ]),
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(calls[0].body) as {
      images?: Array<{ image_url?: string }>;
    };
    expect(body.images).toHaveLength(3);
    for (const entry of body.images ?? []) {
      // Each entry is the vendor's object shape, not a bare string.
      expect(typeof entry.image_url).toBe("string");
      expect(entry.image_url!.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("accepts the `image[]` spelling some SDKs send", async () => {
    const plain = await seed();
    const res = await editsPOST(
      editRequest(plain, [
        ["image[]", "a.png"],
        ["image[]", "b.png"],
      ]),
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(calls[0].body) as { images?: unknown[] };
    expect(body.images).toHaveLength(2);
  });

  it("still serves the single-image case every older spec maps", async () => {
    const plain = await seed();
    await editsPOST(editRequest(plain, [["image", "only.png"]]));
    const body = JSON.parse(calls[0].body) as { images?: unknown[] };
    expect(body.images).toHaveLength(1);
  });

  it("refuses more references than the ceiling instead of dropping the extras", async () => {
    const plain = await seed();
    const many = Array.from({ length: 17 }, (_, i) => ["image", `f${i}.png`] as [string, string]);
    const res = await editsPOST(editRequest(plain, many));
    expect(res.status).toBe(400);
    // Nothing was sent upstream: silently keeping 16 would be the bug this replaced.
    expect(calls).toHaveLength(0);
  });
});

describe("the array mapping itself", () => {
  it("maps a flat array into a list of objects", () => {
    const mapped = applyMapping(
      { images: { $from: "$.images", $to: { image_url: { $dataUrl: "$" } } } },
      { images: ["data:image/png;base64,AA", "https://cdn.example/b.png"] },
    );
    expect(mapped).toEqual({
      images: [
        { image_url: "data:image/png;base64,AA" },
        { image_url: "https://cdn.example/b.png" },
      ],
    });
  });

  it("yields nothing when the array is absent", () => {
    const mapped = applyMapping(
      { images: { $from: "$.images", $to: { image_url: "$" } } },
      { image: "data:image/png;base64,AA" },
    );
    // `$from` on a non-array is `undefined`, so the key is dropped rather than
    // sent as an empty list the vendor would reject.
    expect(mapped).toEqual({});
  });

  it("projects a nested array by nesting $from", () => {
    // §15.1 used to list this as a protocol gap ("path only takes numeric
    // indexes, so you cannot project a field of every element"). Nesting works:
    // the outer `$from` makes each transcript item the scope, the inner one
    // makes each word the scope.
    const mapped = applyMapping(
      {
        utterances: {
          $from: "$.utterances",
          $to: {
            transcript: "$.transcript",
            words: { $from: "$.words", $to: { word: "$.word" } },
          },
        },
      },
      {
        utterances: [
          { transcript: "a", words: [{ word: "hello" }, { word: "there" }] },
          { transcript: "b", words: [{ word: "bye" }] },
        ],
      },
    );
    expect(mapped).toEqual({
      utterances: [
        { transcript: "a", words: [{ word: "hello" }, { word: "there" }] },
        { transcript: "b", words: [{ word: "bye" }] },
      ],
    });
  });
});
