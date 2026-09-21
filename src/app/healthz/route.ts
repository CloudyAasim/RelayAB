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

/**
 * Accept BOTH common Upstash env-var naming conventions:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash SDK default)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN                (Vercel Upstash Marketplace injects these)
 *
 * Required at runtime:
 *   - RELAY_AUTH
 *   - One of the Upstash pairs (URL + TOKEN, both populated, non-empty)
 */
const REQUIRED_KEYS = ["RELAY_AUTH"] as const;

function readUpstashUrl(): string | undefined {
  return process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
}
function readUpstashToken(): string | undefined {
  return process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
}

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const upstashUrl = readUpstashUrl();
  const upstashToken = readUpstashToken();
  const upstashOk = Boolean(upstashUrl?.trim() && upstashToken?.trim());

  const missing: string[] = [];
  if (!process.env.RELAY_AUTH?.trim()) missing.push("RELAY_AUTH");
  if (!upstashUrl?.trim()) missing.push("UPSTASH_REDIS_REST_URL (or KV_REST_API_URL)");
  if (!upstashToken?.trim()) missing.push("UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)");

  // Total "required" slots = 3 (RELAY_AUTH + URL + TOKEN). When either Upstash
  // var is missing we count both as missing, so the math matches the legacy
  // "configured / required" reporting shape.
  const totalRequired = 3;
  const configured = totalRequired - missing.length;
  const status =
    missing.length === 0
      ? "ok"
      : missing.length === totalRequired
      ? "unconfigured"
      : "degraded";

  const body = {
    ok: missing.length === 0,
    data: {
      status,
      env: {
        required: totalRequired,
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
