/**
 * app/api/assistant/test-media/route.ts
 *
 *   POST /api/assistant/test-media → { capability, model, prompt?, size?,
 *                                      duration?, ratio?, voice? }
 *   POST /api/assistant/test-media → multipart, for audio.stt only
 *                                      (model, file, language?)
 *
 * The media test page's account path. Same shape as the key path, which the
 * browser takes by calling the public route with a pasted bearer token; there
 * is no such token here by design, so the call has to happen server-side
 * against the caller's own credential.
 *
 * **Two content types, one endpoint.** Speech recognition is the one capability
 * that carries a file, so it arrives as multipart — which is also what the
 * public route takes, so the same `fileToDataUrl` → spec mapping decides what
 * it means. The other three are pure JSON.
 *
 * Speech recognition used to be refused here outright, with the panel telling
 * the user so. That was honest but it left the only capability that most needs
 * testing unable to spend the credential the user had just switched on.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveToolCredential, type ResolvedCredential } from "@/lib/assistant/credentials";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import {
  executeMediaRequest,
  fileToDataUrl,
  resultItems,
  type MediaExecutionOutcome,
  type MediaExecutionSuccess,
  type MediaRequestInput,
} from "@/lib/media/handler";
import type { MediaCapability } from "@/lib/media/spec";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Matches the public transcriptions route, so one file works on both paths. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const BodySchema = z.object({
  // `audio.stt` is in the enum because the multipart branch has to describe
  // itself the same way, and a second shape for one capability is a second set
  // of rules to keep in step. It is refused below unless a file actually came
  // with it — a JSON transcription has nothing to transcribe.
  capability: z.enum(["image.generate", "video.generate", "audio.tts", "audio.stt"]),
  model: z.string().min(1).max(200),
  prompt: z.string().max(8000).optional(),
  size: z.string().max(32).optional(),
  duration: z.number().positive().max(60).optional(),
  ratio: z.string().max(32).optional(),
  voice: z.string().max(200).optional(),
});

/** The fields a multipart transcription carries, read the way the public route reads them. */
interface SttUpload {
  model: string;
  audio: string;
  filename: string;
  language?: string;
}

function badRequest(message: string, code = "bad_request"): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

/**
 * Read a transcription upload.
 *
 * Returns the refusal as a value rather than throwing, so the caller has one
 * place to turn it into a response and cannot forget the empty-file case.
 */
async function readSttUpload(req: Request): Promise<
  { ok: true; upload: SttUpload } | { ok: false; response: NextResponse }
> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { ok: false, response: badRequest("Invalid multipart body", "bad_json") };
  }

  const model = form.get("model");
  if (typeof model !== "string" || !model.trim() || model.length > 200) {
    return { ok: false, response: badRequest("model 不合法") };
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, response: badRequest("需要一个音频文件", "invalid_request") };
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return { ok: false, response: badRequest("音频文件超过 25MB 上限", "invalid_request") };
  }

  const language = form.get("language");
  return {
    ok: true,
    upload: {
      model: model.trim(),
      audio: await fileToDataUrl(file),
      filename: file.name,
      ...(typeof language === "string" && language ? { language } : {}),
    },
  };
}

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

  const isMultipart = (req.headers.get("content-type") ?? "").includes("multipart/form-data");

  let body: unknown;
  let stt: SttUpload | null = null;
  if (isMultipart) {
    const read = await readSttUpload(req);
    if (!read.ok) return read.response;
    stt = read.upload;
    body = { capability: "audio.stt", model: stt.model };
  } else {
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body", "bad_json");
    }
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("参数不合法");
  }

  const { capability, model } = parsed.data;
  // A transcription that arrived as JSON has no file with it, so there is
  // nothing to transcribe. Said plainly, rather than forwarded upstream as a
  // request that is certain to fail.
  if (capability === "audio.stt" && !stt) {
    return badRequest("语音转写需要上传音频文件，请用 multipart 提交。", "invalid_request");
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

  // Reaching here without a file means the capability is one of the three
  // JSON ones — the `audio.stt`-without-a-file case was refused above, so the
  // narrowing is a fact about this point rather than a hope.
  const jsonCapability = capability as "image.generate" | "video.generate" | "audio.tts";

  const started = Date.now();
  const outcome = stt
    ? await executeMediaRequest({
        capability: "audio.stt",
        input: {
          model,
          // The same slot and the same data URL the public route uses, so a
          // spec resolves this identically whether it was reached with a
          // bearer token or with the account credential.
          image: stt.audio,
          extra: { audio: stt.audio, filename: stt.filename, ...(stt.language ? { language: stt.language } : {}) },
        },
        apiKey: credential.account.apiKey,
        user: credential.account.user,
        signal: AbortSignal.timeout(240_000),
      })
    : await runJsonMedia(jsonCapability, parsed.data, credential);
  const ms = Date.now() - started;

  if (!outcome.ok) return mediaErrorResponse(outcome);
  if (stt) {
    return NextResponse.json({
      ok: true,
      data: { via: "account", ms, text: outcome.value.result.text ?? "", ...(outcome.value.result.taskId ? { id: outcome.value.result.taskId } : {}) },
    });
  }
  return respondToMedia(jsonCapability, outcome, ms);
}

/** The three JSON capabilities, which differ only in what they are asked for. */
async function runJsonMedia(
  capability: "image.generate" | "video.generate" | "audio.tts",
  data: z.infer<typeof BodySchema>,
  credential: Extract<ResolvedCredential, { kind: "account" }>,
): Promise<MediaExecutionOutcome> {  const prompt = data.prompt?.trim() ?? "";
  if (!prompt) {
    return {
      ok: false,
      error: { status: 400, code: "invalid_request", message: "prompt 不能为空" },
    };
  }

  const input: MediaRequestInput = {
    model: data.model,
    prompt,
    // **And** the capability's own text field, where it has one. Text-to-speech
    // is that capability: `MINIMAX_TTS_SPEC` reads `$.input`, the public
    // `/v1/audio/speech` route sends `input`, and this route sent only `prompt`
    // — so a TTS test through the assistant account went upstream with no `text`
    // at all and came back `invalid params, binding: expr_path=text, cause=
    // missing required parameter`. The two paths were calling the same engine
    // with the same spec and disagreeing about the name of the field holding
    // the sentence.
    ...(capability === "audio.tts" ? { input: prompt } : {}),
    ...(data.size ? { size: data.size } : {}),
    // The vendor-mandated extras are carried through as the routes do, so the
    // same spec decides what they mean rather than this route guessing.
    extra: data,
  };
  return executeMediaRequest({
    capability: capability as MediaCapability,
    input,
    apiKey: credential.account.apiKey,
    user: credential.account.user,
    signal: AbortSignal.timeout(240_000),
  });
}

/** The three JSON capabilities, which differ only in how the result is shaped. */
async function respondToMedia(
  capability: "image.generate" | "video.generate" | "audio.tts",
  outcome: { value: MediaExecutionSuccess },
  ms: number,
): Promise<Response> {
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
