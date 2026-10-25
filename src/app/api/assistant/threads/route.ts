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
import { getServerLocale } from "@/lib/i18n/server";
import { translate } from "@/lib/i18n/dict";

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
  // The title is the reader's language: it is the name of the conversation in
  // their own list, and it is stored — so it has to be right the first time.
  const locale = await getServerLocale();
  const thread = await createAssistantThread(me.id, translate(locale, "assistant.newThread"));
  return NextResponse.json({ ok: true, data: { thread } });
}
