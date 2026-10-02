/**
 * app/api/assistant/test-media/route.ts
 *
 *   POST /api/assistant/test-media → { capability, model, prompt?, size?,
 *                                      duration?, ratio?, voice? }
 *
 * The media test page's account path. Same shape as the key path, which the
 * browser takes by calling the public route with a pasted bearer token; there
 * is no such token here by design, so the call has to happen server-side
 * against the caller's own credential.
 *
 * Speech recognition is not accepted. It takes an uploaded file, and this
 * endpoint speaks JSON - so the panel tells the truth on that capability rather
 * than letting a mode look available and quietly falling back.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import { executeMediaRequest, resultItems, type MediaRequestInput } from "@/lib/media/handler";
import type { MediaCapability } from "@/lib/media/spec";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  capability: z.enum(["image.generate", "video.generate", "audio.tts"]),
  model: z.string().min(1).max(200),
  prompt: z.string().max(8000).optional(),
  size: z.string().max(32).optional(),
  duration: z.number().positive().max(60).optional(),
  ratio: z.string().max(32).optional(),
  voice: z.string().max(200).optional(),
});

function mediaErrorResponse(outcome: { error: { status: number; code: string; message: string } }): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code: outcome.error.code, message: outcome.error.message } },
    { status: outcome.error.status },
  );
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  // A media test is a real, charged call, so it shares the chat budget rather
  // than being a way around it.
  const rate = consumeAssistantTurn(me.id);
  if (rate.limited) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: `助手请求太频繁了，${rate.retryAfterSeconds} 秒后再试。`,
        },
      },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
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
      { ok: false, error: { code: "bad_request", message: "参数不合法" } },
      { status: 400 },
    );
  }

  const credential = await resolveToolCredential({ userId: me.id, mode: "account" });
  if (credential.kind !== "account") {
    const reason = credential.kind === "none" ? credential.reason : "no_credential";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "no_credential",
          message:
            reason === "switch_off"
              ? "助手凭据已创建但没有开启。请在设置里打开开关，或改用「自己配置的密钥」。"
              : "还没有开启助手凭据。请先创建并开启，或改用「自己配置的密钥」。",
        },
      },
      { status: 409 },
    );
  }

  const { capability, model } = parsed.data;
  const prompt = parsed.data.prompt?.trim() ?? "";
  if (!prompt) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_request", message: "prompt 不能为空" } },
      { status: 400 },
    );
  }

  const input: MediaRequestInput = {
    model,
    prompt,
    ...(parsed.data.size ? { size: parsed.data.size } : {}),
    // The vendor-mandated extras are carried through as the routes do, so the
    // same spec decides what they mean rather than this route guessing.
    extra: parsed.data,
  };

  const started = Date.now();
  const outcome = await executeMediaRequest({
    capability: capability as MediaCapability,
    input,
    apiKey: credential.account.apiKey,
    user: credential.account.user,
    signal: AbortSignal.timeout(240_000),
  });
  const ms = Date.now() - started;

  if (!outcome.ok) return mediaErrorResponse(outcome);

  if (capability === "audio.tts") {
    const binary = outcome.value.result.binary;
    if (!binary) {
      return NextResponse.json(
        { ok: false, error: { code: "no_audio", message: "上游没有返回音频" } },
        { status: 502 },
      );
    }
    const bytes = new Uint8Array(binary.body);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": binary.contentType ?? "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        "X-Relay-Ms": String(ms),
        "X-Relay-Via": "account",
      },
    });
  }

  const items = await resultItems(outcome.value.result);
  return NextResponse.json({
    ok: true,
    data: {
      via: "account",
      ms,
      urls: items.filter((i) => i.kind === "url").map((i) => i.value),
      b64: items.filter((i) => i.kind === "base64").length,
    },
  });
}
