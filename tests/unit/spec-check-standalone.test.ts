/**
 * tests/unit/spec-check-standalone.test.ts
 *
 * `public/spec-check.html` is a **standalone** judge: one file, no imports, no
 * build step, no network — so an AI without the repository can still self-check
 * a spec before delivering it. That independence is the whole point, and it is
 * also the risk: a re-implementation of the engine can drift.
 *
 * Two directions are pinned here:
 *
 *  1. The simulator's own self-test must pass (it ships with a button for the
 *     same reason).
 *  2. **Parity**: the same specs must produce the same outcomes through the real
 *     engine (`src/lib/media/engine.ts`) and through the standalone simulator.
 *     Without this, "the judge says green" would be worthless.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeMedia, buildMediaScope } from "@/lib/media/engine";
import { parseMediaSpec, type MediaSpec, type MediaProvider } from "@/lib/media/spec";
import { encryptSecret } from "@/lib/crypto/secrets";

const HTML = join(process.cwd(), "public", "spec-check.html");

interface JudgeResult {
  ok: boolean;
  passed: number;
  failed: number;
  lines: { kind: string; text: string }[];
}

interface Judge {
  run(input: unknown): JudgeResult;
  selfTest(): { ok: boolean; total: number; failed: number; cases: { name: string; ok: boolean }[] };
  executeSpec(spec: unknown, input: unknown, serve: (url: string) => { status: number; body: unknown }): {
    ok: boolean;
    error?: { status: number; code: string };
    items?: { kind: string; value: string }[];
  };
  buildScope(input: unknown): Record<string, unknown>;
}

/** Pull the engine port out of the HTML and evaluate it in isolation. */
function loadJudge(): Judge {
  const html = readFileSync(HTML, "utf8");
  const match = /<script id="relayab-spec-check">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("public/spec-check.html has no <script id=\"relayab-spec-check\"> block");
  const sandbox: { SpecCheck?: Judge } = {};
  // eslint-disable-next-line no-new-func
  const factory = new Function("globalThis", `${match[1]}\nreturn globalThis;`);
  const result = factory(sandbox) as { SpecCheck?: Judge };
  if (!result.SpecCheck) throw new Error("the standalone script did not export globalThis.SpecCheck");
  return result.SpecCheck;
}

const provider: MediaProvider = {
  id: "judge",
  name: "judge",
  baseUrl: "https://api.example.test",
  encryptedApiKey: encryptSecret("probe-key"),
  enabled: true,
  priority: 1,
  models: {},
  specs: [],
  createdAt: "",
  updatedAt: "",
};

/**
 * One upstream script, two consumers: the real engine (wrapped in a `Response`)
 * and the standalone simulator (plain object). Keeping the contract identical is
 * what makes the parity assertion meaningful.
 */
interface Stub {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Stub => ({ status: 200, body });
const err = (status: number, body: unknown): Stub => ({ status, body });
type Script = (url: string) => Stub;

/** Run a spec through the REAL engine. */
async function runReal(
  raw: unknown,
  input: Record<string, unknown>,
  script: Script,
): Promise<{ ok: boolean; code?: string; items?: { kind: string; value: string }[] }> {
  const parsed = parseMediaSpec(raw);
  if (!parsed.ok) return { ok: false, code: "invalid_spec" };
  const out = await executeMedia({
    spec: parsed.spec,
    provider,
    input: buildMediaScope({ model: "probe-model", ...input }),
    fetchImpl: (async (url: string | URL | Request) => {
      const stub = script(String(url));
      return new Response(JSON.stringify(stub.body ?? null), {
        status: stub.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return out.ok ? { ok: true, items: out.result.items } : { ok: false, code: out.error.code };
}

let judge: Judge;

beforeAll(() => {
  judge = loadJudge();
});

describe("standalone judge: it is genuinely standalone", () => {
  it("lives in one HTML file with no imports, no build, no network", () => {
    const html = readFileSync(HTML, "utf8");
    expect(html).toContain('id="relayab-spec-check"');
    // No bundler, no framework, no import of the project's own source: the whole
    // point is that it runs where the repository does not exist.
    expect(html).not.toMatch(/from\s+["']@\/lib\//);
    expect(html).not.toMatch(/require\(/);
    // Match real import statements, not the word inside prose ("re-import").
    expect(html).not.toMatch(/(^|[\s;])import\s+[^;]*\bfrom\s+["']/);
    expect(html).not.toMatch(/\bimport\s*\(/);
    expect(html).not.toMatch(/from\s+["']react/);
    // A single <script> block holds the engine port.
    expect((html.match(/<script id="relayab-spec-check">/g) ?? []).length).toBe(1);
  });

  it("exports its engine port for reuse", () => {
    for (const fn of ["run", "selfTest", "executeSpec", "buildScope", "readPaths", "validateSpec"]) {
      expect(typeof (judge as unknown as Record<string, unknown>)[fn], fn).toBe("function");
    }
  });

  it("passes its own built-in self test", () => {
    const r = judge.selfTest();
    const failed = r.cases.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.name}`), "standalone self-test must pass").toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(12);
  });
});

/**
 * Parity corpus. Every entry is a spec plus an upstream script, chosen because
 * each one exercises a different branch of the engine (mapping, encoding, errors,
 * async, $fetch, emptiness). If the standalone port and the real engine ever
 * disagree, one of them is lying.
 */
const CORPUS: {
  name: string;
  spec: Record<string, unknown>;
  input: Record<string, unknown>;
  script: Script;
}[] = [
  {
    name: "同步图片：$from 数组 → url items",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: {
        items: { $from: "$.data.image_urls", $to: { kind: "url", value: "$" } },
        successCount: "$.metadata.success_count",
      },
    },
    input: { prompt: "cat" },
    script: () =>
      ok({ data: { image_urls: ["https://cdn/1.png", "https://cdn/2.png"] }, metadata: { success_count: 2 } }),
  },
  {
    name: "itemsB64 也要被读到（v2 曾静默丢失它）",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: {
        items: { $from: "$.data.image_urls", $to: { kind: "url", value: "$" } },
        itemsB64: { $from: "$.data.image_base64", $to: { kind: "base64", value: "$" } },
      },
    },
    input: { prompt: "cat" },
    script: () => ok({ data: { image_base64: ["QUJDRA=="] } }),
  },
  {
    name: "hex 编码归一：kind=base64 + encoding=hex",
    spec: {
      specVersion: 2,
      capability: "audio.tts",
      transport: { method: "POST", path: "/v1/t2a_v2" },
      auth: { type: "bearer" },
      request: { model: "$.model", text: "$.input" },
      response: { items: [{ kind: "base64", encoding: "hex", value: "$.data.audio" }] },
    },
    input: { input: "hi" },
    script: () => ok({ data: { audio: "49443304000000fffb90c4" } }),
  },
  {
    name: "厂商码错误（HTTP 200 + base_resp）",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { items: [{ kind: "url", value: "$.url" }], errorMessage: "$.base_resp.status_msg" },
      errors: [{ when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter" }],
    },
    input: { prompt: "cat" },
    script: () => ok({ data: {}, base_resp: { status_code: 1026, status_msg: "sensitive" } }),
  },
  {
    name: "HTTP 状态码错误（V2 风格）",
    spec: {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v2/video_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model" },
      response: { items: [{ kind: "url", value: "$.url" }] },
      errors: [{ httpStatus: 422, status: 400, code: "content_filter" }],
    },
    input: { prompt: "p" },
    script: () => err(422, { error: { type: "unprocessable_entity_error" } }),
  },
  {
    name: "异步：pending → success 收敛",
    spec: {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { taskId: "$.task_id", status: "$.status", items: [{ kind: "url", value: "$.file_url" }] },
      async: {
        submitTaskId: "$.task_id",
        poll: { method: "GET", path: "/v1/query?task_id={{taskId}}", statusMap: { Processing: "wait", Success: "ok", "": "wait" } },
      },
    },
    input: { prompt: "wave" },
    script: (() => {
      let polls = 0;
      return (url: string) =>
        url.includes("/v1/video_generation")
          ? ok({ task_id: "t1" })
          : (polls++ < 1 ? ok({ status: "Processing" }) : ok({ status: "Success", file_url: "https://cdn/v.mp4" }));
    })(),
  },
  {
    name: "异步：失败态立刻失败",
    spec: {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: { taskId: "$.task_id", status: "$.status", items: [{ kind: "url", value: "$.file_url" }] },
      async: {
        submitTaskId: "$.task_id",
        poll: { method: "GET", path: "/v1/query?task_id={{taskId}}", statusMap: { Success: "ok", Fail: "fail", "": "wait" } },
      },
    },
    input: { prompt: "wave" },
    script: (url: string) =>
      url.includes("/v1/video_generation")
        ? ok({ task_id: "t1" })
        : ok({ status: "Fail", errorMessage: "nsfw" }),
  },
  {
    name: "$fetch：file_id → download_url",
    spec: {
      specVersion: 2,
      capability: "video.generate",
      transport: { method: "POST", path: "/v1/video_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      response: {
        taskId: "$.task_id",
        status: "$.status",
        items: [
          {
            kind: "url",
            value: { $fetch: { path: "$.file_id", url: "/v1/files/retrieve?file_id={{ $.file_id }}", pick: "$.file.download_url" } },
          },
        ],
      },
      async: {
        submitTaskId: "$.task_id",
        poll: { method: "GET", path: "/v1/query?task_id={{taskId}}", statusMap: { Success: "ok", "": "wait" } },
      },
    },
    input: { prompt: "wave" },
    script: (url: string) => {
      if (url.includes("/v1/video_generation")) return ok({ task_id: "t1" });
      if (url.includes("/v1/query")) return ok({ status: "Success", file_id: "205258526306433" });
      return ok({ file: { download_url: "https://cdn/real.mp4" } });
    },
  },
  {
    name: "空结果被拦下（而不是静默 0 产物）",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
      // A typo'd path: upstream is fine, the mapping finds nothing.
      response: { items: { $from: "$.data.images", $to: { kind: "url", value: "$" } } },
    },
    input: { prompt: "cat" },
    script: () => ok({ data: { image_urls: ["https://cdn/a.png"] } }),
  },
  {
    name: "n 超过 maxN 被拒",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/image_generation" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt", n: "$.n" },
      response: { items: [{ kind: "url", value: "$.url" }] },
      limits: { maxN: 1 },
    },
    input: { prompt: "cat", n: 5 },
    script: () => ok({ url: "https://cdn/a.png" }),
  },
  {
    name: "$ifPresent 多分支：二选一的产物",
    spec: {
      specVersion: 2,
      capability: "image.generate",
      transport: { method: "POST", path: "/v1/images/generations" },
      auth: { type: "bearer" },
      request: { model: "$.model", prompt: "$.prompt" },
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
    },
    input: { prompt: "cat" },
    script: () => ok({ data: [{ url: "https://cdn/1.png" }, { b64_json: "QUJDRA==" }] }),
  },
  {
    name: "语音转写：只有 text，没有 items",
    spec: {
      specVersion: 2,
      capability: "audio.stt",
      transport: { method: "POST", path: "/v1/speech_to_text" },
      auth: { type: "bearer" },
      request: { model: "$.model", file: { $file: { path: "$.image", filename: "$.filename" } } },
      response: { text: "$.text" },
    },
    input: { image: "data:audio/mpeg;base64,QUJD", filename: "a.mp3" },
    script: () => ok({ text: "其实还是商家赚了" }),
  },
];

describe("standalone judge agrees with the real engine", () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))("%s", async (_name, entry) => {
    const real = await runReal(entry.spec, entry.input, entry.script);

    // The simulator sees the very same script.
    const simulated = judge.executeSpec(entry.spec, entry.input, (url) => entry.script(url));

    expect(simulated.ok, `parity on success: real=${real.ok}/${real.code} simulated=${simulated.ok}/${simulated.error?.code}`).toBe(real.ok);
    if (real.ok) {
      expect(simulated.items, "item kinds+values must match the real engine").toEqual(real.items);
    } else {
      expect(simulated.error?.code, "error code must match the real engine").toBe(real.code);
    }
  });
});

describe("standalone judge: scope building matches the engine", () => {
  it.each([
    ["camelCase normalized field", { responseFormat: "b64_json" }],
    ["snake_case passthrough", { extra: { response_format: "b64_json" } }],
    ["both present", { responseFormat: "b64_json", extra: { response_format: "b64_json" } }],
    ["nested vendor key", { extra: { negative_prompt: "blurry" } }],
  ])("%s", (_name, input) => {
    const real = buildMediaScope({ model: "m", ...(input as Record<string, unknown>) });
    const simulated = judge.buildScope({ model: "m", ...(input as Record<string, unknown>) });
    // Compare the keys each side exposes; values are identical by construction.
    expect(Object.keys(simulated).sort()).toEqual(Object.keys(real).sort());
  });
});

describe("standalone judge: static checks", () => {
  const base = {
    specVersion: 2,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/image_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { items: [{ kind: "url", value: "$.url" }] },
  };

  it("reports a clean spec as clean", () => {
    const result = judge.run({ specs: [base] });
    expect(result.failed).toBe(0);
  });

  it("rejects two unscoped specs of the same capability", () => {
    const result = judge.run({
      specs: [
        base,
        { ...base, transport: { method: "POST", path: "/v2/image_generation" }, capability: "image.edit" },
      ].map((s, i) => (i === 0 ? s : { ...s, capability: "image.generate" })),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.map((l) => l.text).join("\n")).toContain("do not list `models`");
  });

  it("catches $dataUrl in a response", () => {
    const result = judge.run({
      specs: [
        {
          ...base,
          capability: "audio.tts",
          response: { items: [{ kind: "base64", value: { $dataUrl: "$.data.audio" } }] },
        },
      ],
    });
    expect(result.lines.map((l) => l.text).join("\n")).toContain("response 里用了 $dataUrl");
  });

  it("catches a string constant for a boolean-looking key", () => {
    const result = judge.run({
      specs: [
        {
          ...base,
          capability: "audio.stt",
          transport: { method: "POST", path: "/v1/speech_to_text", contentType: "multipart/form-data" },
          request: { model: "$.model", file: { $file: { path: "$.image" } }, stream: { $const: "false" } },
          response: { text: "$.text" },
        },
      ],
    });
    expect(result.lines.map((l) => l.text).join("\n")).toContain("字符串常量");
  });

  it("catches an empty-string default for a required field", () => {
    const result = judge.run({
      specs: [
        {
          ...base,
          capability: "music.generate",
          request: { model: "$.model", prompt: "$.prompt", lyrics: { $firstPresent: ["$.lyrics", { $const: "" }] } },
        },
      ],
    });
    expect(result.lines.map((l) => l.text).join("\n")).toContain("用空值兜底");
  });

  it("catches a poll path that hangs off the submit path", () => {
    const result = judge.run({
      specs: [
        {
          ...base,
          capability: "video.generate",
          transport: { method: "POST", path: "/v2/video_generation" },
          response: { taskId: "$.task_id", status: "$.status", items: [{ kind: "url", value: "$.url" }] },
          async: {
            submitTaskId: "$.task_id",
            poll: { method: "GET", path: "/v2/video_generation/query?task_id={{taskId}}", statusMap: { succeeded: "ok", "": "wait" } },
          },
        },
      ],
    });
    expect(result.lines.map((l) => l.text).join("\n")).toContain("又接了字面量段");
  });
});

describe("standalone judge: real vendor response reconciliation", () => {
  const ZHIPU_IMAGE = {
    specVersion: 2,
    capability: "image.generate",
    displayName: "Zhipu GLM-Image (Async)",
    transport: { method: "POST", path: "/api/paas/v4/async/images/generations" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: {
      taskId: "$.id",
      status: "$.task_status",
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
  const FIXTURE = {
    submit: { id: "task-1", task_status: "PROCESSING" },
    poll: {
      model: "glm-image",
      task_status: "SUCCESS",
      image_result: [{ url: "https://example.test/out.png" }],
    },
  };

  it("catches a response path the vendor never returns", () => {
    const result = judge.run({ specs: [ZHIPU_IMAGE], fixtures: { "Zhipu GLM-Image (Async)": FIXTURE } });
    const output = result.lines.map((l) => l.text).join("\n");
    expect(result.ok).toBe(false);
    expect(output).toContain("data.url");
    // The message must name the field the vendor actually uses, or the operator
    // still has to go read the docs.
    expect(output).toContain("image_result");
  });

  it("goes green once the path is corrected", () => {
    const fixed = JSON.parse(JSON.stringify(ZHIPU_IMAGE));
    fixed.response.items = [{ kind: "url", value: "$.image_result[0].url" }];
    const result = judge.run({ specs: [fixed], fixtures: { "Zhipu GLM-Image (Async)": FIXTURE } });
    const failures = result.lines.filter((l) => l.kind === "bad");
    expect(failures.map((l) => l.text)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports an unused fixture so a typo'd key is not ignored", () => {
    const result = judge.run({ specs: [baseSpec()], fixtures: { "no-such-spec": { data: {} } } });
    expect(result.lines.map((l) => l.text).join("\n")).toContain("没有被任何 spec 命中");
  });
});

function baseSpec() {
  return {
    specVersion: 2,
    capability: "image.generate",
    transport: { method: "POST", path: "/v1/image_generation" },
    auth: { type: "bearer" },
    request: { model: "$.model", prompt: "$.prompt" },
    response: { items: [{ kind: "url", value: "$.url" }] },
  };
}
