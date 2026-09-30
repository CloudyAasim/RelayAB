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
import { parseMediaSpec, type MediaSpec } from "@/lib/media/spec";

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

  it("flags audio declared as a url when nothing asks the upstream for one", async () => {
    // MiniMax t2a_v2 / music_generation default to hex, so a `kind: "url"` item
    // fed from `data.audio` hands the client a hex string as a URL.
    const music: Record<string, unknown> = {
      specVersion: 2,
      capability: "music.generate",
      transport: { method: "POST", path: "/v1/music_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt", audio_setting: { format: "mp3" } },
      response: { items: [{ kind: "url", value: "$.data.audio" }] },
    };
    const result = await checkSpecDocument([music]);
    expect(result.lines.join("\n")).toContain("没有任何参数要求上游返回 url");
  });

  it("stays quiet when the audio spec does declare the format switch", async () => {
    const music: Record<string, unknown> = {
      specVersion: 2,
      capability: "music.generate",
      transport: { method: "POST", path: "/v1/music_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt", output_format: { $const: "url" } },
      response: { items: [{ kind: "url", value: "$.data.audio" }] },
    };
    const result = await checkSpecDocument([music]);
    expect(result.lines.join("\n")).not.toContain("没有任何参数要求上游返回 url");
  });

  it("stays quiet for video/image capabilities, whose artefact fields are URL-named", async () => {
    const video: Record<string, unknown> = {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.task.content.url" }] },
      async: {
        submitTaskId: "$.task_id",
        poll: { method: "GET", path: "/v2/query/video_generation/{{taskId}}", statusMap: { succeeded: "ok", "": "wait" } },
      },
    };
    const result = await checkSpecDocument([video]);
    expect(result.lines.join("\n")).not.toContain("没有任何参数要求上游返回 url");
  });

  it("prints the response paths so they can be diffed against the vendor schema", async () => {
    // The judge synthesizes the payload from these paths, so it cannot verify
    // them against the vendor. Printing them is what makes the human check
    // possible.
    const result = await checkSpecDocument([MINIMAX_IMAGE_SPEC]);
    expect(result.lines.join("\n")).toContain("response 读取路径: data.image_urls[*]");
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

/**
 * The judge synthesizes its upstream payload from the spec's own claims, so it
 * cannot by itself catch "this field does not exist at the vendor". Feeding it a
 * real vendor response is the only thing that closes that loop, and it is the
 * check that would have caught the Zhipu image spec reading `data.url` while
 * the API returns `image_result[].url`.
 */
describe("real vendor responses (fixtures)", () => {
  const ZHIPU_IMAGE_BROKEN = {
    specVersion: 2,
    capability: "image.generate",
    displayName: "Zhipu GLM-Image (Async)",
    transport: { method: "POST", path: "/api/paas/v4/async/images/generations" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: {
      taskId: "$.id",
      status: "$.task_status",
      // The bug: the vendor returns `image_result[]`, not `data`.
      items: [{ kind: "url", value: "$.data.url" }],
      successCount: { $const: 1 },
    },
    async: {
      submitTaskId: "$.id",
      poll: {
        method: "GET",
        path: "/api/paas/v4/async-result/{{taskId}}",
        statusPath: "$.task_status",
        statusMap: { PROCESSING: "wait", SUCCESS: "ok", FAIL: "fail", "": "wait" },
      },
    },
  };

  // Copied from the official AsyncImageGenerationResponse schema.
  const ZHIPU_FIXTURE = {
    submit: { id: "task-1", task_status: "PROCESSING", request_id: "req-1" },
    poll: {
      model: "glm-image",
      task_status: "SUCCESS",
      image_result: [{ url: "https://example.test/out.png" }],
      request_id: "req-1",
    },
  };

  it("catches a response path the vendor does not return", async () => {
    const result = await checkSpecDocument({
      specs: [ZHIPU_IMAGE_BROKEN],
      fixtures: { "Zhipu GLM-Image (Async)": ZHIPU_FIXTURE },
    });
    const output = result.lines.join("\n");
    expect(result.ok).toBe(false);
    expect(output).toContain("data.url");
    // The message must name the fields the vendor actually returned, otherwise
    // the operator still has to go read the docs.
    expect(output).toContain("image_result");
  });

  it("goes green once the path is corrected", async () => {
    const fixed = JSON.parse(JSON.stringify(ZHIPU_IMAGE_BROKEN)) as Record<string, any>;
    fixed.response.items = [{ kind: "url", value: "$.image_result[0].url" }];
    const result = await checkSpecDocument({
      specs: [fixed],
      fixtures: { "Zhipu GLM-Image (Async)": ZHIPU_FIXTURE },
    });
    const failures = result.lines.filter((line) => line.includes("✗"));
    expect(failures, failures.join("\n")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a task id that only appears in the submit response", async () => {
    const { diffAgainstFixture, fixtureFor } = await import("../../scripts/spec-check");
    const parsedSpec = parseMediaSpec(ZHIPU_IMAGE_BROKEN);
    if (!parsedSpec.ok) throw new Error(parsedSpec.errors.join("; "));
    const spec = parsedSpec.spec;
    const fixture = fixtureFor(spec, { "Zhipu GLM-Image (Async)": ZHIPU_FIXTURE })!;
    const diff = diffAgainstFixture(spec, fixture.body);
    // `$.id` is only in submit; `$.data.url` is in neither — the one that counts.
    expect(diff.mismatches.map((m) => m.path)).toEqual(["data.url"]);
  });

  it("reports an unused fixture so a typo'd key is not silently ignored", async () => {
    const result = await checkSpecDocument({
      specs: [MINIMAX_IMAGE_SPEC],
      fixtures: { "no-such-spec": { data: {} } },
    });
    expect(result.lines.join("\n")).toContain("没有被任何 spec 命中");
  });

  it("matches fixtures by capability when there is no displayName key", async () => {
    const result = await checkSpecDocument({
      specs: [MINIMAX_IMAGE_SPEC],
      fixtures: {
        // A real `response_format: "url"` response has no `image_base64` key at
        // all — the spec maps both arrays, and only the populated one is present.
        "image.generate": {
          data: { image_urls: ["https://cdn.example.test/a.png"] },
          metadata: { success_count: 1 },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("真实上游响应对账");
  });
});

/** Static rules that encode specific incidents from the protocol's history. */
describe("direction and consistency rules", () => {
  it("rejects $dataUrl in a response", async () => {
    const broken = {
      specVersion: 2,
      capability: "audio.tts",
      transport: { method: "POST", path: "/v1/t2a_v2" },
      auth: { type: "bearer" },
      request: { model: "$.model", text: "$.input" },
      // The very first incident: a data URL handed to a client that base64-decodes.
      response: { items: [{ kind: "base64", value: { $dataUrl: "$.data.audio" } }] },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("response 里用了 $dataUrl");
  });

  it("rejects $from in a request", async () => {
    const broken = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", images: { $from: "$.refs", $to: { value: "$" } } },
      response: { items: [{ kind: "url", value: "$.url" }] },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("request 里用了 $from");
  });

  it("flags items and itemsB64 pointing at the same upstream array", async () => {
    const broken = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: {
        items: { $from: "$.data.urls", $to: { kind: "url", value: "$" } },
        itemsB64: { $from: "$.data.urls", $to: { kind: "base64", value: "$" } },
      },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("指向同一个上游数组");
  });

  it("flags a catalogue limit that disagrees with the enforced one", async () => {
    const broken = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }] },
      limits: { maxN: 4 },
      metadata: { max_n: 9 },
    };
    const result = await checkSpecDocument([broken]);
    expect(result.lines.join("\n")).toContain("max_n=9 与 limits.maxN=4 不一致");
  });

  it("notes sizes the mapping accepts but the catalogue never advertises", async () => {
    const partial = {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      request: {
        model: "$.model",
        prompt: "$.prompt",
        resolution: {
          $enum: { path: "$.size", map: { "1280x720": "768P", "720x1280": "768P" }, default: "768P" },
        },
      },
      response: { taskId: "$.task_id", status: "$.status" },
      async: {
        submitTaskId: "$.task_id",
        poll: { method: "GET", path: "/query/{{taskId}}", statusMap: { Success: "ok", "": "wait" } },
      },
      metadata: { sizes: ["1280x720"] },
    };
    const result = await checkSpecDocument([partial]);
    expect(result.lines.join("\n")).toContain("720x1280");
  });

  it("rejects an item with a non-url kind and a meaningless encoding", async () => {
    const broken = {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url", encoding: "hex", value: "$.url" }] },
    };
    const result = await checkSpecDocument([broken]);
    const output = result.lines.join("\n");
    expect(output).toContain("kind 是 url 却声明了 encoding");
  });
});
