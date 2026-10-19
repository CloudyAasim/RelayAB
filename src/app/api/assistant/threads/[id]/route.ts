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
  setAssistantThreadWebSearch,
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
  // Trim before the length check: the repository stores `title.trim().slice(0, 120)`
  // and refuses an empty result, so a whitespace-only title used to fall through
  // validation and come back as 404 "对话不存在" for a thread that was right there.
  //
  // `webSearch` rides on the same PATCH: the composer's toggle has to survive a
  // reload, and giving it a second endpoint for one boolean would be two
  // places to keep authorized.
  const PatchSchema = z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      webSearch: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.title !== undefined || v.webSearch !== undefined, {
      message: "没有要修改的内容",
    });
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "请求内容不合法" } },
      { status: 400 },
    );
  }
  const { id } = await context.params;

  let thread = await getAssistantThread(me.id, id);
  if (!thread) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "对话不存在" } },
      { status: 404 },
    );
  }
  if (parsed.data.title !== undefined) {
    const renamed = await renameAssistantThread(me.id, id, parsed.data.title);
    if (!renamed) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "对话不存在" } },
        { status: 404 },
      );
    }
    thread = renamed;
  }
  if (parsed.data.webSearch !== undefined) {
    const updated = await setAssistantThreadWebSearch(me.id, id, parsed.data.webSearch);
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "对话不存在" } },
        { status: 404 },
      );
    }
    thread = updated;
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
