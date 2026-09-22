/**
 * app/api/user/keys/route.ts
 *
 * Self-service API for an authenticated regular user.
 *
 *   GET  /api/user/keys
 *     List the current user's API keys.
 *
 *   POST /api/user/keys
 *     Body: { label: string, expiresAt?: string|null }
 *     Create a new key. Quota, model whitelist, etc. are inherited from
 *     the user's admin-controlled allocation; the user only picks a label
 *     and optional expiry.
 *
 * Constraints (enforced server-side; user cannot bypass):
 *   - The user must be `enabled` (not disabled).
 *   - User's allocation.maxActiveKeys (if > 0) limits how many keys they
 *     can own at any one time.
 *   - User's quota allocation defines the per-key quota.
 *
 * The returned plaintext key is shown to the user exactly ONCE.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, lookupCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import {
  createApiKey,
  listApiKeysByUser,
  ApiKeyNotFoundError,
} from "@/lib/db/keys";

const PostSchema = z.object({
  label: z.string().min(1).max(64),
  expiresAt: z.string().nullable().optional(),
  /**
   * Optional narrowing of the caller's own model whitelist. A key can never
   * grant access to a model the owner lacks — see checkKeyStatus().
   */
  allowedModels: z.array(z.string()).optional(),
});

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { keys } = await listApiKeysByUser(me.id, { limit: 200 });
  return NextResponse.json({ ok: true, data: { keys } });
}

export async function POST(req: Request): Promise<Response> {
  const { user: me, rejection } = await lookupCurrentUser();
  if (!me) {
    // "Account disabled" is actionable; plain 401 would just look like a
    // signed-out session.
    if (rejection === "user_disabled") {
      return NextResponse.json(
        { ok: false, error: { code: "user_disabled", message: "Your account is disabled" } },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  // Pull the full user record so we can apply allocation + disabled check.
  const fullUser = await getUserById(me.id);
  if (!fullUser) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "User no longer exists" } },
      { status: 404 },
    );
  }
  if (fullUser.disabled) {
    return NextResponse.json(
      { ok: false, error: { code: "user_disabled", message: "Your account is disabled" } },
      { status: 403 },
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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid input" } },
      { status: 400 },
    );
  }

  // Enforce maxActiveKeys (only if admin set a non-zero cap).
  if (fullUser.maxActiveKeys > 0) {
    const { keys } = await listApiKeysByUser(me.id, { limit: 200 });
    const active = keys.filter((k) => k.enabled).length;
    if (active >= fullUser.maxActiveKeys) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "max_keys_reached",
            message: `You have reached the limit of ${fullUser.maxActiveKeys} active keys. Disable or delete one before creating another.`,
          },
        },
        { status: 403 },
      );
    }
  }

  try {
    const result = await createApiKey({
      userId: me.id,
      label: parsed.data.label,
      expiresAt: parsed.data.expiresAt ?? null,
      // Keys start with no extra narrowing; the owner's whitelist still
      // applies at request time, so the effective permission is unchanged.
      allowedModels: parsed.data.allowedModels ?? [],
    });
    return NextResponse.json({
      ok: true,
      data: { key: result.key, plainKey: result.plainKey },
    });
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: err.message } },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : "Unknown error",
        },
      },
      { status: 500 },
    );
  }
}
