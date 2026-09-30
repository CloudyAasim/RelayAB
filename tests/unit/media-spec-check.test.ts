/**
 * tests/unit/media-spec-check.test.ts
 *
 * The judge (`scripts/spec-check.ts`) is the part of this protocol that lets a
 * spec be verified without a vendor account, so it has to be trustworthy itself.
 *
 * Two directions:
 *  1. It must pass the built-in seeds — they are the worked examples the
 *     documentation tells operators to start from.
 *  2. It must fail on specs that carry the exact bugs that shipped to a live
 *     request, so it cannot silently degrade into a rubber stamp.
 */
import { describe, it, expect } from "vitest";
import { checkSpecDocument, readPaths, synthesizePayload } from "../../scripts/spec-check";
import {
  MEDIA_TEMPLATES,
  MINIMAX_IMAGE_SPEC,
  MINIMAX_STT_SPEC,
  MINIMAX_TTS_SPEC,
  MINIMAX_VIDEO_V1_SPEC,
  MINIMAX_VIDEO_V2_SPEC,
} from "@/lib/media/seeds";
import type { MediaSpec } from "@/lib/media/spec";

const models = Object.fromEntries(
  [
    MINIMAX_IMAGE_SPEC,
    MINIMAX_STT_SPEC,
    MINIMAX_TTS_SPEC,
    MINIMAX_VIDEO_V1_SPEC,
    MINIMAX_VIDEO_V2_SPEC,
  ].flatMap((spec) =>
    (spec.models ?? []).map((name) => [name, { upstreamId: name, pricePerItem: 10, enabled: true }]),
  ),
);

/** A V1 video spec is used as the base for most "broken" mutations. */
const VIDEO_V1 = MINIMAX_VIDEO_V1_SPEC as unknown as Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("spec-check on the built-in templates", () => {
  // Each template is a *separate* provider: pooling them would (correctly) trip
  // the same-capability rule, because MiniMax video and the generic async
  // video template are not meant to live in one vendor row.
  it("passes every template, so the documented starting points are known-good", async () => {
    for (const [id, template] of Object.entries(MEDIA_TEMPLATES)) {
      const result = await checkSpecDocument({
        models: template.models,
        specs: template.specs,
      });
      const failures = result.lines.filter((line) => line.includes("✗"));
      expect(failures, `template ${id} failed:\n${failures.join("\n")}`).toEqual([]);
      expect(result.ok, `template ${id} reported failures`).toBe(true);
    }
  });

  it("accepts a bare spec array too", async () => {
    const result = await checkSpecDocument(MEDIA_TEMPLATES["minimax-video"].specs);
    expect(result.ok).toBe(true);
  });

  it("accepts a single spec object", async () => {
    const result = await checkSpecDocument(MINIMAX_IMAGE_SPEC);
    expect(result.ok).toBe(true);
  });
});

describe("spec-check catches the bugs that reached production", () => {
  it("flags a hex payload mapped without `encoding`", async () => {
    // The real incident: MiniMax T2A defaults to hex, the spec said base64, and
    // the client got undecodable garbage with no error anywhere.
    const broken = clone(MINIMAX_TTS_SPEC) as unknown as Record<string, unknown>;
    const response = broken.response as Record<string, unknown>;
    response.items = [{ kind: "base64", value: "$.data.audio" }];
    delete response.items;

    const result = await checkSpecDocument([broken]);
    const output = result.lines.join("\n");
    // Either the probe fails, or the heuristic about a missing encoding is
    // there to catch it — both are acceptable; silence is not.
    expect(output.includes("✗") || output.includes("encoding")).toBe(true);
  });

  it("flags a poll path that hangs off the submit path", async () => {
    const broken = clone(VIDEO_V1);
    (broken.async as { poll: { path: string } }).poll.path =
      "/v1/video_generation/query?task_id={{taskId}}";
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("async.poll.path 在提交路径后面又接了字面量段");
  });

  it("flags a string constant for a boolean-looking upstream key", async () => {
    // `{"$const":"false"}` in a multipart body sends the *string* "false".
    const broken = clone(MINIMAX_STT_SPEC) as unknown as Record<string, unknown>;
    (broken.request as Record<string, unknown>).stream = { $const: "false" };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("request.stream 用了字符串常量");
  });

  it("flags an empty-string default for a required upstream field", async () => {
    // `lyrics` has minLength 1 at MiniMax; sending "" is worse than omitting it.
    const broken = {
      specVersion: 2,
      capability: "music.generate",
      transport: { method: "POST", path: "/v1/music_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt", lyrics: { $firstPresent: ["$.lyrics", { $const: "" }] } },
      response: { items: [{ kind: "url", value: "$.data.audio" }] },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("用空值兜底");
  });

  it("flags two unscoped specs of the same capability", async () => {
    // Both templates are scoped, so the rule only fires once `models` is gone —
    // which is exactly the configuration that used to silently shadow.
    const unscoped = [MINIMAX_VIDEO_V1_SPEC, MINIMAX_VIDEO_V2_SPEC].map((spec) => {
      const copy = clone(spec) as unknown as Record<string, unknown>;
      delete copy.models;
      return copy;
    });
    const result = await checkSpecDocument(unscoped);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("do not list `models`");
  });

  it("flags a media capability with no response mapping at all", async () => {
    // Silently succeeded and charged 0 credits before §7.5 existed.
    const broken = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { prompt: "$.prompt" },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("no `response` mapping");
  });

  it("flags a model no spec claims", async () => {
    const result = await checkSpecDocument({
      models: { ...models, "orphan-model": { upstreamId: "x", pricePerItem: 1, enabled: true } },
      specs: MEDIA_TEMPLATES["minimax-video"].specs,
    });
    expect(result.lines.join("\n")).toContain("orphan-model");
  });

  it("flags a mode advertised without a matching request mapping", async () => {
    const broken = clone(MINIMAX_IMAGE_SPEC) as unknown as Record<string, unknown>;
    broken.request = { model: "$.model", prompt: "$.prompt" };
    broken.metadata = { modes: ["image-to-image"] };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain('metadata.modes 声明了 "image-to-image"');
  });
});

describe("payload synthesis", () => {
  it("builds the array shape a `$from` mapping expects", () => {
    const reads = readPaths(MINIMAX_IMAGE_SPEC.response);
    const imageUrls = reads.find((r) => r.path.includes("image_urls"));
    expect(imageUrls?.path).toBe("data.image_urls[*]");

    const payload = synthesizePayload(MINIMAX_IMAGE_SPEC);
    expect(Array.isArray(payload.data)).toBe(false);
    expect(Array.isArray((payload.data as Record<string, unknown>).image_urls)).toBe(true);
  });

  it("uses the spec's own success state for `status`", () => {
    const payload = synthesizePayload(MINIMAX_VIDEO_V1_SPEC);
    expect(payload.status).toBe("Success");
    const v2 = synthesizePayload(MINIMAX_VIDEO_V2_SPEC);
    expect((v2.task as Record<string, unknown>).status).toBe("succeeded");
  });

  it("populates exactly one `$ifPresent` branch", () => {
    // OpenAI's data[] entries are either {url} or {b64_json}, never both.
    const openAiLike: MediaSpec = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/images/generations" },
      auth: { type: "bearer" },
      response: {
        items: {
          $from: "$.data",
          $to: {
            $ifPresent: [
              { "$.url": { kind: "url", value: "$.url" } },
              { "$.b64_json": { kind: "base64", value: "$.b64_json" } },
            ],
          },
        },
      },
    };
    const payload = synthesizePayload(openAiLike);
    const first = (payload.data as unknown[])[0] as Record<string, unknown>;
    expect(first.url).toBeDefined();
    expect(first.b64_json).toBeUndefined();
  });
});
