/**
 * src/app/api/assistant/transcribe/route.ts
 *
 * POST /api/assistant/transcribe → multipart { file, model?, language? }
 *                             → { ok, data: { text, model, ms } }
 *
 * Speech-to-text for the assistant's microphone button.
 *
 * **The same engine the public `/v1/audio/transcriptions` uses**, reached with
 * the assistant's own credential instead of a bearer token. The operator config
 * an `audio.stt` spec once on a media provider — typically MiniMax's
 * `/v1/speech_to_text` — and this route is what turns "press the mic" into that
 * spec being applied. Nothing new to configure, and the OpenAI-compatible shape
 * is preserved on both sides: the same multipart in, the same `text` out.
 *
 * The model is optional and defaults to the first speech-to-text model the
 * catalog offers. Making someone pick a model to say a sentence is a step with
 * no upside, and there is normally exactly one.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { executeMediaRequest } from "@/lib/media/handler";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";

const MAX_BYTES = 25 * 1024 * 1024;

function fail(message: string, status: number, code = "invalid_request") {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return fail("请先登录。", 401, "unauthenticated");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("请求格式不对，需要 multipart。", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail("没有收到音频文件。", 400);
  }
  if (file.size > MAX_BYTES) {
    return fail(`音频超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB。`, 400, "file_too_large");
  }

  const language = typeof form.get("language") === "string" ? (form.get("language") as string) : undefined;

  // An explicit model wins; otherwise the first speech-to-text model there is.
  // The catalog is already loaded on the models page, so this is a read of
  // settings rather than a second source of truth.
  let model = typeof form.get("model") === "string" ? (form.get("model") as string).trim() : "";
  if (!model) {
    const catalog = await cachedBuildModelCatalog();
    const stt = catalog.models.find((m) => m.capability === "audio.stt");
    if (!stt) {
      return fail(
        "还没有配置语音转写模型。请在「媒体服务商」里给某个服务商加一个 audio.stt 的协议。",
        409,
        "no_stt_model",
      );
    }
    model = stt.id;
  }

  const credential = await resolveToolCredential({ userId: me.id, mode: "account" });
  if (credential.kind !== "account") {
    const reason = credential.kind === "none" ? credential.reason : "no_credential";
    return fail(
      reason === "switch_off"
        ? "助手凭据已创建但没有开启。请在助手设置里打开开关。"
        : "还没有开启助手凭据。请先在助手设置里创建并开启。",
      409,
      "no_credential",
    );
  }

  const audio = `data:${file.type || "audio/webm"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;

  const started = Date.now();
  const outcome = await executeMediaRequest({
    capability: "audio.stt",
    input: {
      model,
      // The same slot the public route uses, so a spec resolves it identically
      // whichever door the request came through.
      image: audio,
      extra: { audio, filename: file.name || "recording.webm", ...(language ? { language } : {}) },
    },
    apiKey: credential.account.apiKey,
    user: credential.account.user,
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - started;

  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: outcome.error.code ?? "upstream_error", message: outcome.error.message ?? "转写失败" },
        data: { ms, model },
      },
      { status: outcome.error.status >= 400 ? outcome.error.status : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { text: outcome.value.result.text ?? "", model, ms },
  });
}
