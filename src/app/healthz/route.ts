/**
 * app/healthz/route.ts
 *
 * GET /healthz — unauthenticated health check (see docs/API_ROUTES.md §1.4).
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    ok: true,
    data: { status: "ok", version: "0.1.0" },
  });
}
