/**
 * app/api/assistant/credentials/route.ts
 *
 *   GET  /api/assistant/credentials → whether the caller has one, and its state
 *   POST /api/assistant/credentials → { action: "create" | "enable" | "disable"
 *                                       | "rotate" | "remove" }
 *
 * The credential the assistant spends, authorised by the caller's session. It is
 * created here on the user's explicit request, off by default, and at most one
 * per account — a rule the schema enforces rather than a check in this file.
 *
 * There is no endpoint that returns the plaintext, because there is no
 * plaintext: the assistant holds the key object and calls the proxy in-process.
 * "rotate" is the only way to change it, and it produces a different key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  createAssistantCredential,
  getAssistantCredential,
  removeAssistantCredential,
  rotateAssistantCredential,
  setAssistantCredentialEnabled,
} from "@/lib/db/assistant-keys";

export const dynamic = "force-dynamic";

/**
 * The public shape. Deliberately carries the key prefix and nothing more: the
 * prefix is already what the user sees in their own key list, and including the
 * real hash would be handing out the only value that identifies the row.
 */
function publicState(credential: Awaited<ReturnType<typeof getAssistantCredential>>) {
  return {
    created: credential !== null,
    enabled: credential?.enabled ?? false,
    keyPrefix: credential?.key.keyPrefix ?? null,
    createdAt: credential?.createdAt ?? null,
    /** Whether the underlying key would actually pass the proxy's own checks. */
    usable: credential !== null && credential.enabled && credential.key.enabled,
  };
}

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const credential = await getAssistantCredential(me.id);
  return NextResponse.json({ ok: true, data: publicState(credential) });
}

const PostSchema = z.object({
  action: z.enum(["create", "enable", "disable", "rotate", "remove"]),
});

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "action 不合法" } },
      { status: 400 },
    );
  }

  const { action } = parsed.data;

  if (action === "create") {
    const credential = await createAssistantCredential(me.id);
    return NextResponse.json({ ok: true, data: publicState(credential) });
  }

  if (action === "enable" || action === "disable") {
    // Enabling something that was never created would leave the user with a
    // switch that appears to work and does not.
    const existing = await getAssistantCredential(me.id);
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { code: "not_created", message: "还没有创建助手凭据。" } },
        { status: 409 },
      );
    }
    const credential = await setAssistantCredentialEnabled(me.id, action === "enable");
    return NextResponse.json({ ok: true, data: publicState(credential) });
  }

  if (action === "rotate") {
    const rotated = await rotateAssistantCredential(me.id);
    if (!rotated) {
      return NextResponse.json(
        { ok: false, error: { code: "not_created", message: "还没有创建助手凭据。" } },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, data: publicState(rotated) });
  }

  const removed = await removeAssistantCredential(me.id);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: { code: "not_created", message: "还没有创建助手凭据。" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: publicState(null) });
}
