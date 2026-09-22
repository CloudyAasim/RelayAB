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
  const raw = await redis.hgetall<Record<string, string>>(k.user(id));

  return NextResponse.json(
    {
      ok: true,
      data: {
        id,
        rawDisabled: raw?.disabled ?? null,
        rawRole: raw?.role ?? null,
        allFields: raw ?? {},
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      },
    },
  );
}
