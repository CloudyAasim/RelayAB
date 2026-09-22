/**
 * GET /healthz — unauthenticated health check.
 *
 * Three distinct statuses so deploy verification is unambiguous:
 *   - "ok"            — everything the current storage mode needs is present
 *   - "degraded"      — some of it is missing (app may start but routes that
 *                       touch the database will throw)
 *   - "unconfigured"  — none of it is present
 *
 * Returns the NAMES of missing variables (never their values) so an operator
 * can curl this right after a deploy and know exactly what to fix.
 *
 * `data.storage` reports whether the app is on a real Upstash database or the
 * in-process mock, and `env.required` follows from that. In development the
 * mock is the default, so `required` is 1 (just RELAY_AUTH) rather than 3.
 *
 * The decision logic lives in `lib/health.ts` so the tests exercise the real
 * implementation instead of a copy of it.
 */
import { NextResponse } from "next/server";
import { computeHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = computeHealth(process.env);

  const body = {
    ok: report.ok,
    data: {
      status: report.status,
      storage: report.storage,
      env: {
        required: report.required,
        configured: report.configured,
        missing: report.missing,
      },
    },
  };

  // 200 even when degraded/unconfigured, so uptime probes aren't confused by
  // env-var misconfiguration. Operators read status from the JSON body.
  return NextResponse.json(body);
}
