/**
 * src/app/healthz/route.ts
 *
 * GET /healthz — unauthenticated health check.
 *
 * Three distinct statuses so deploy verification is unambiguous:
 *   - "ok"            — every required env var is present
 *   - "degraded"      — some required env vars are missing (app may still start
 *                       but routes that touch config will throw)
 *   - "unconfigured"  — none of the required env vars are present
 *
 * Returns the list of missing variables (no values, only names) so an operator
 * can curl this immediately after deploy and immediately know what's missing.
 */
import { NextResponse } from "next/server";

const REQUIRED = [
  "RELAY_AUTH",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const missing = REQUIRED.filter(
    (k) => !process.env[k] || !process.env[k]!.trim(),
  );

  const configured = REQUIRED.length - missing.length;
  const status =
    missing.length === 0
      ? "ok"
      : missing.length === REQUIRED.length
      ? "unconfigured"
      : "degraded";

  const body = {
    ok: missing.length === 0,
    data: {
      status,
      env: {
        required: REQUIRED.length,
        configured,
        missing: missing.length > 0 ? missing : undefined,
      },
    },
  };

  // 200 even when degraded/unconfigured, so uptime probes don't get confused
  // by env-var misconfiguration. Operators should still see status="ok" vs
  // status="unconfigured" in the JSON body.
  return NextResponse.json(body);
}
