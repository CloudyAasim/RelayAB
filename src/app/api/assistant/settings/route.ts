/**
 * app/api/assistant/settings/route.ts
 *
 * The caller's own upstream configuration for the assistant.
 *
 *   GET    /api/assistant/settings      → public view (never the key)
 *   PUT    /api/assistant/settings      → create or update
 *   DELETE /api/assistant/settings      → forget
 *   POST   /api/assistant/settings      → probe without saving
 *
 * The assistant runs on the user's own key rather than on the admin's
 * providers, so this is per-account and the key is encrypted with the same
 * master key as everything else. A blank `apiKey` on PUT keeps the stored one,
 * which is what lets the settings form save a changed model without the browser
 * ever holding the key again.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  getPublicAssistantSettings,
  getAssistantSettings,
  saveAssistantSettings,
  deleteAssistantSettings,
  AssistantSettingsError,
} from "@/lib/db/assistant";
import { probeUpstream } from "@/lib/assistant/client";

export const dynamic = "force-dynamic";

/**
 * What the form may write.
 *
 * `baseUrl` and `model` are blankable because the account path has no upstream
 * of its own: a row still has to exist to remember which model the account path
 * uses, and the key-path fields are simply not in use there. Which of them
 * actually has to be filled is decided per mode below, not by the shape of the
 * request.
 */
const PutSchema = z.object({
  baseUrl: z.string().max(500).optional().default(""),
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional().default(""),
  credentialMode: z.enum(["account", "key"]).nullable().optional(),
  accountModel: z.string().max(200).nullable().optional(),
  protocol: z.enum(["openai"]).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  // Nullable, not optional-and-defaulted: an empty box sends `null` and has
  // to mean "stop sending this". Optional alone would make clearing the box
  // a no-op, and a stored temperature would outlive the form that set it.
  contextLength: z.number().int().positive().max(100_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(100_000_000).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
});

const ProbeSchema = z.object({
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().min(1, "需要 API 密钥").max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

function unauthorized(): Response {
  return NextResponse.json(
    { ok: false, error: { code: "unauthenticated", message: "Login required" } },
    { status: 401 },
  );
}

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  const settings = await getPublicAssistantSettings(me.id);
  return NextResponse.json({ ok: true, data: { settings } });
}

export async function PUT(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const existing = await getAssistantSettings(me.id);
  const mode = data.credentialMode === undefined ? (existing?.credentialMode ?? null) : data.credentialMode;

  /**
   * Only the mode being switched *to* is held to its own requirements.
   *
   * Validating both would make a person who keeps a key-path configuration also
   * maintain an account-path one they are not using, and the form would refuse
   * to save a working configuration over a field that is not on screen. What is
   * refused is the state that would be left behind: choosing a mode whose
   * required field is blank.
   */
  const modelForMode = mode === "account" ? data.accountModel : data.model;
  const modelStored = mode === "account" ? existing?.accountModel : existing?.model;
  if (mode === "account" && !(modelForMode ?? "").trim() && !(modelStored ?? "").trim()) {
    return NextResponse.json(
      { ok: false, error: { code: "no_model", message: "用账号身份需要一个模型：请从列表里选一个。" } },
      { status: 400 },
    );
  }
  if (mode === "key") {
    if (!data.baseUrl.trim()) {
      return NextResponse.json(
        { ok: false, error: { code: "no_upstream", message: "用自己的密钥需要填写接口地址。" } },
        { status: 400 },
      );
    }
    if (!data.model.trim()) {
      return NextResponse.json(
        { ok: false, error: { code: "no_model", message: "用自己的密钥需要填写模型名。" } },
        { status: 400 },
      );
    }
  }

  try {
    await saveAssistantSettings(me.id, data);
  } catch (err) {
    if (err instanceof AssistantSettingsError) {
      return NextResponse.json(
        { ok: false, error: { code: "missing_key", message: err.message } },
        { status: 400 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true, data: { settings: await getPublicAssistantSettings(me.id) } });
}

/**
 * Probe a candidate configuration *without* saving it.
 *
 * Saving first and discovering afterwards that the base URL is wrong leaves a
 * broken assistant behind; this lets the settings form check first.
 */
export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = ProbeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const result = await probeUpstream({
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey,
    ...(parsed.data.extraHeaders ? { extraHeaders: parsed.data.extraHeaders } : {}),
  });

  return NextResponse.json({ ok: true, data: { probe: result } });
}

export async function DELETE(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) return unauthorized();
  await deleteAssistantSettings(me.id);
  return NextResponse.json({ ok: true, data: { deleted: true } });
}
