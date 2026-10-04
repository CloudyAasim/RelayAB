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
  saveAssistantSettings,
  deleteAssistantSettings,
  AssistantSettingsError,
} from "@/lib/db/assistant";
import { probeUpstream } from "@/lib/assistant/client";

export const dynamic = "force-dynamic";

const PutSchema = z.object({
  baseUrl: z.string().min(1, "base URL 不能为空").max(500),
  apiKey: z.string().max(500).optional(),
  model: z.string().min(1, "模型名不能为空").max(200),
  protocol: z.enum(["openai"]).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
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

  try {
    await saveAssistantSettings(me.id, parsed.data);
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
