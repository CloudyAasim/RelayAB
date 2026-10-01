/**
 * app/api/assistant/threads/route.ts
 *
 *   GET  /api/assistant/threads        → the caller's conversations
 *   POST /api/assistant/threads         → start an empty one
 *
 * Every query is scoped to the session user, so a thread id from another
 * account is simply not found rather than readable.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { createAssistantThread, listAssistantThreads } from "@/lib/db/assistant";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const threads = await listAssistantThreads(me.id, 100);
  return NextResponse.json({ ok: true, data: { threads } });
}

export async function POST(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const thread = await createAssistantThread(me.id);
  return NextResponse.json({ ok: true, data: { thread } });
}
