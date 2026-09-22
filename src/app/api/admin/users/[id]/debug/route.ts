/**
 * DEBUG endpoint — returns raw Redis state for a user.
 * GET /api/admin/users/[id]/debug
 *
 * This bypasses ALL caching and returns the raw disabled value from Redis.
 */
import { NextResponse } from "next/server";
import { getRedis, k } from "@/lib/db/redis";
import { getCurrentUser } from "@/lib/auth/session";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  const { id } = await context.params;

  const redis = getRedis();
  // Read ONLY the fields this endpoint exists to check. Dumping the whole
  // hash would ship every user's bcrypt password hash to the browser.
  const [rawDisabled, rawRole, updatedAt, username] = await Promise.all([
    redis.hget<string>(k.user(id), "disabled"),
    redis.hget<string>(k.user(id), "role"),
    redis.hget<string>(k.user(id), "updatedAt"),
    redis.hget<string>(k.user(id), "username"),
  ]);
  const exists = await redis.exists(k.user(id));

  return NextResponse.json(
    {
      ok: true,
      data: {
        id,
        exists: exists === 1,
        username: username ?? null,
        rawDisabled: rawDisabled ?? null,
        rawRole: rawRole ?? null,
        updatedAt: updatedAt ?? null,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      },
    },
  );
}
