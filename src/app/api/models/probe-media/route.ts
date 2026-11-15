/**
 * app/api/models/probe-media/route.ts
 *
 *   POST /api/models/probe-media
 *   Body: { capability, baseUrl, apiKey, model, prompt?, size?, voice?, duration?, n?, dataUrl?, path? }
 *
 * Test one media endpoint of an arbitrary OpenAI-compatible vendor, from the
 * same page as the gateway's own media tester.
 *
 * The shape sent per capability is the vendor-facing OpenAI one, because that is
 * what "其他服务商" means on this page: the call the client would make if this
 * deployment were not in the middle. `path` is the escape hatch for a vendor
 * that spells it differently.
 *
 * The key is not stored; large binary answers are returned as a data URL so the
 * page can show or download them without a second request.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const CAPABILITIES = ["image.generate", "video.generate", "audio.tts", "audio.stt", "music.generate"] as const;

const BodySchema = z.object({
  capability: z.enum(CAPABILITIES),
  baseUrl: z.string().min(1, "请填写 API 地址").max(500),
  apiKey: z.string().min(1, "请填写 API 密钥").max(500),
  model: z.string().min(1, "请填写模型名").max(200),
  prompt: z.string().max(20000).optional(),
  size: z.string().max(50).optional(),
  voice: z.string().max(100).optional(),
  duration: z.number().int().min(1).max(600).optional(),
  n: z.number().int().min(1).max(8).optional(),
  /** Vendor options the guided form exposes. */
  negativePrompt: z.string().max(4000).optional(),
  seed: z.number().int().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  responseFormat: z.string().max(20).optional(),
  language: z.string().max(20).optional(),
  /** `data:<mime>;base64,…` for speech-to-text. */
  dataUrl: z.string().max(40_000_000).optional(),
  path: z.string().max(300).optional(),
});

const DEFAULT_PATHS: Record<(typeof CAPABILITIES)[number], string> = {
  "image.generate": "/images/generations",
  "video.generate": "/videos/generations",
  "audio.tts": "/audio/speech",
  "audio.stt": "/audio/transcriptions",
  "music.generate": "/music/generations",
};

const MAX_BINARY = 12 * 1024 * 1024;

type Capability = (typeof CAPABILITIES)[number];

function endpointFor(baseUrl: string, capability: Capability, path?: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path?.trim() || DEFAULT_PATHS[capability];
  return `${base}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
}

function protocolProblem(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "只支持 http / https";
  } catch {
    return "API 地址不是合法 URL";
  }
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const payload = match[3];
  try {
    if (match[2]) {
      const buffer = Buffer.from(payload, "base64");
      if (buffer.byteLength > MAX_BINARY) return null;
      return { mime, bytes: new Uint8Array(buffer) };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

async function buildRequest(
  capability: Capability,
  input: z.infer<typeof BodySchema>,
  endpoint: string,
): Promise<{ init: RequestInit } | { error: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${input.apiKey}` };

  if (capability === "audio.stt") {
    const file = input.dataUrl ? parseDataUrl(input.dataUrl) : null;
    if (!file) return { error: "语音转写需要一个音频文件" };
    const form = new FormData();
    form.append("model", input.model);
    form.append("file", new Blob([file.bytes as unknown as BlobPart], { type: file.mime }), "audio");
    if (input.prompt?.trim()) form.append("prompt", input.prompt.trim());
    if (input.language) form.append("language", input.language);
    return { init: { method: "POST", headers, body: form } };
  }

  headers["Content-Type"] = "application/json";
  const body: Record<string, unknown> = { model: input.model };
  if (input.prompt !== undefined) body.prompt = input.prompt;
  if (input.n !== undefined) body.n = input.n;
  if (input.size) body.size = input.size;
  if (input.duration !== undefined) body.duration = input.duration;
  if (input.voice) body.voice = input.voice;
  if (input.negativePrompt) body.negative_prompt = input.negativePrompt;
  if (input.seed !== undefined) body.seed = input.seed;

  if (capability === "audio.tts") {
    // The speech endpoint calls the text `input`, not `prompt`.
    body.input = input.prompt ?? "";
    body.voice = input.voice || "alloy";
    if (input.speed !== undefined) body.speed = input.speed;
    if (input.responseFormat) body.response_format = input.responseFormat;
    delete body.prompt;
  }

  return {
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const endpoint = endpointFor(input.baseUrl, input.capability, input.path);
  const problem = protocolProblem(endpoint);
  if (problem) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_endpoint", message: problem } },
      { status: 400 },
    );
  }

  const built = await buildRequest(input.capability, input, endpoint);
  if ("error" in built) {
    return NextResponse.json({ ok: false, error: { code: "bad_request", message: built.error } }, { status: 400 });
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, { ...built.init, signal: AbortSignal.timeout(240_000) });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      data: {
        endpoint,
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  const latencyMs = Date.now() - started;
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({
      ok: true,
      data: { endpoint, ok: false, status: res.status, latencyMs, contentType, error: text.slice(0, 4000) },
    });
  }

  if (contentType.includes("application/json") || contentType.includes("text/")) {
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text below */
    }
    return NextResponse.json({
      ok: true,
      data: { endpoint, ok: true, status: res.status, latencyMs, contentType, json, text: json ? undefined : text.slice(0, 8000) },
    });
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_BINARY) {
    return NextResponse.json({
      ok: true,
      data: { endpoint, ok: false, status: res.status, latencyMs, contentType, error: "响应超过 12MB，无法在页面上展示" },
    });
  }
  const base64 = Buffer.from(buffer).toString("base64");
  return NextResponse.json({
    ok: true,
    data: {
      endpoint,
      ok: true,
      status: res.status,
      latencyMs,
      contentType,
      dataUrl: `data:${contentType.split(";")[0] || "application/octet-stream"};base64,${base64}`,
      bytes: buffer.byteLength,
    },
  });
}
