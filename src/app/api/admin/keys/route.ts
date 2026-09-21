/**
 * app/api/admin/keys/route.ts
 *
 * GET  /api/admin/keys?userId=&enabledOnly=
 * POST /api/admin/keys  body: { userId, label, quotaType, quotaLimit, expiresAt?, allowedModels? }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiKey, listAllApiKeys, listApiKeysByUser } from "@/lib/db/keys";
import { getCurrentUser } from "@/lib/auth/session";

const PostSchema = z.object({
  userId: z.string().min(1),
  label: z.string().min(1).max(64),
  quotaType: z.enum(["credits", "tokens"]),
  quotaLimit: z.number().int().nonnegative(),
  expiresAt: z.string().nullable().optional(),
  allowedModels: z.array(z.string()).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? undefined;
  const enabledOnly = url.searchParams.get("enabledOnly") === "true";

  const keys = userId
    ? (await listApiKeysByUser(userId)).keys
    : await listAllApiKeys({ enabledOnly });

  return NextResponse.json({ ok: true, data: { keys } });
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  const result = await createApiKey({
    userId: parsed.data.userId,
    label: parsed.data.label,
    quotaType: parsed.data.quotaType,
    quotaLimit: parsed.data.quotaLimit,
    expiresAt: parsed.data.expiresAt ?? null,
    allowedModels: parsed.data.allowedModels ?? [],
  });
  return NextResponse.json({
    ok: true,
    data: { key: result.key, plainKey: result.plainKey },
  });
}
