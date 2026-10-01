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
 * `data.storage` reports which store is live — the local SQLite file (the
 * default), the Upstash REST API (only when explicitly configured), or the
 * in-process mock. `data.env.required` follows from it: SQLite and the mock
 * need only RELAY_AUTH, while the hosted Redis path needs the URL and token
 * pair on top of that.
 *
 * The decision logic lives in `lib/health.ts` so the tests exercise the real
 * implementation instead of a copy of it.
 */
import { NextResponse } from "next/server";
import { computeHealth } from "@/lib/health";
import { getDb } from "@/lib/db/sqlite";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = computeHealth(process.env);

  // Actually open the database.
  //
  // Checking that env vars are present only proves the file is *configured*,
  // not that it is reachable. A RELAY_DB_PATH pointing at a host path instead
  // of a mounted volume passes the env check and then fails every real request
  // — which is exactly how the first Dokku deploy came up "ok" and served
  // nothing but "Server is not ready". One cheap query closes that gap, and it
  // is also the probe Dokku's zero-downtime deploys want.
  let dbError: string | null = null;
  try {
    getDb().prepare("SELECT 1").get();
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const ok = report.ok && dbError === null;
  const body = {
    ok,
    data: {
      status: !ok ? (dbError ? "degraded" : report.status) : report.status,
      storage: report.storage,
      env: {
        required: report.required,
        configured: report.configured,
        missing: report.missing,
      },
      revision: report.revision,
      // Present only when the database could not be opened. The message names
      // the path and what to do about it; the raw driver error alone ("unable
      // to open database file") does not.
      ...(dbError ? { error: dbError } : {}),
    },
  };

  // 200 even when degraded, so uptime probes aren't confused by a
  // misconfiguration. Operators read status from the JSON body.
  return NextResponse.json(body);
}
