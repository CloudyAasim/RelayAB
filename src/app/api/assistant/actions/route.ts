/**
 * app/api/assistant/actions/route.ts
 *
 *   GET /api/assistant/actions?status=pending
 *
 * The queue of changes the assistant has proposed. Reading is available to any
 * signed-in user because a regular user can also have changes proposed *to
 * them* by an admin assistant; applying is admin-only and lives in [id].
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listAssistantActions } from "@/lib/db/assistant";
import { AssistantActionStatusSchema } from "@/lib/assistant/schema";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get("status");
  const status = raw ? AssistantActionStatusSchema.safeParse(raw) : null;

  if (raw && (!status || !status.success)) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "status 不合法" } },
      { status: 400 },
    );
  }

  const actions = await listAssistantActions(me.id, status?.success ? status.data : undefined);
  return NextResponse.json({ ok: true, data: { actions } });
}
