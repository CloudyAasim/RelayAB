/**
 * app/api/models/probe-raw/route.ts
 *
 *   POST /api/models/probe-raw
 *   Body: { method, url, headers?, body? }
 *
 * The escape hatch for vendors whose endpoint or payload this page does not
 * model: send exactly what the vendor documents, see exactly what came back.
 *
 * It exists because "guided forms + a raw request" is the only combination that
 * is both usable and complete: the guided forms answer the common case in one
 * click, and this answers the vendor whose shape is different without waiting
 * for us to add a field.
 *
 * Nothing is stored. `http(s)` only, same rule as the other probes: a
 * self-hosted deployment legitimately tests services on its own network.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  url: z.string().min(1, "请填写 URL").max(1000),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(200_000).optional(),
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

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const { method, url, headers, body: payload } = parsed.data;
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return NextResponse.json(
        { ok: false, error: { code: "bad_endpoint", message: "只支持 http / https" } },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_endpoint", message: "URL 不合法" } },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: headers ?? {},
      ...(method === "GET" || method === "DELETE" ? {} : { body: payload ?? "" }),
      signal: AbortSignal.timeout(120_000),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text().catch(() => "");
    return NextResponse.json({
      ok: true,
      data: {
        url,
        method,
        status: res.status,
        ok: res.ok,
        latencyMs,
        contentType: res.headers.get("content-type") ?? "",
        text: text.slice(0, 20_000),
      },
    });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      data: {
        url,
        method,
        status: 0,
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
