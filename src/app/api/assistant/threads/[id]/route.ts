/**
 * app/api/assistant/threads/[id]/route.ts
 *
 *   GET    /api/assistant/threads/:id   → the conversation
 *   PATCH  /api/assistant/threads/:id   → rename
 *   DELETE /api/assistant/threads/:id   → delete (messages cascade)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteAssistantThread,
  getAssistantThread,
  listAssistantMessages,
  renameAssistantThread,
} from "@/lib/db/assistant";

export const dynamic = "force-dynamic";

async function load(userId: string, id: string) {
  return getAssistantThread(userId, id);
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const thread = await load(me.id, id);
  if (!thread) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "对话不存在" } },
      { status: 404 },
    );
  }
  const messages = await listAssistantMessages(thread.id);
  return NextResponse.json({ ok: true, data: { thread, messages } });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const parsed = z.object({ title: z.string().min(1).max(120) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "标题不合法" } },
      { status: 400 },
    );
  }
  const { id } = await context.params;
  const thread = await renameAssistantThread(me.id, id, parsed.data.title);
  if (!thread) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "对话不存在" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { thread } });
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const deleted = await deleteAssistantThread(me.id, id);
  if (!deleted) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "对话不存在" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deleted: true } });
}
