/**
 * app/api/assistant/search-settings/route.ts
 *
 *   POST /api/assistant/search-settings  → try the caller's own search service
 *
 * The chat upstream has a "test connectivity" button; the search service needs
 * the same one, for the same reason: saving a configuration and finding out
 * afterwards that the address is wrong leaves a broken assistant behind, and
 * the difference between "this works" and "this is what I typed" is one click.
 *
 * **Nothing is saved and nothing is charged.** The address is used exactly as
 * it was typed, the call goes to the caller's own service, and their key pays
 * their vendor — the gateway is a relay here, not a reseller.
 *
 * The shape tested is the OpenAI-compatible search shape: a POST carrying
 * `{"query", "limit"}` and answered with `{"results": [{title, url, snippet}]}`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { createSearchBackend } from "@/lib/assistant/web-search";
import { OPENAI_COMPATIBLE_TEMPLATE } from "@/lib/search/templates";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  baseUrl: z.string().trim().min(1, "请填写搜索接口地址").max(500),
  /** Blank means "no credential" — a service on the caller's own machine. */
  apiKey: z.string().max(500).optional(),
  query: z.string().trim().min(1).max(200).optional(),
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
      {
        ok: false,
        error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" },
      },
      { status: 400 },
    );
  }

  const backend = createSearchBackend({
    spec: OPENAI_COMPATIBLE_TEMPLATE.spec,
    baseUrl: parsed.data.baseUrl,
    ...(parsed.data.apiKey?.trim() ? { apiKey: parsed.data.apiKey.trim() } : {}),
    source: "user",
    usageProviderId: `user:${me.id}`,
    describe: "自己的搜索服务",
  });
  if (!backend) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "这个地址不是一个可用的 http(s) 接口地址。",
        },
      },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const results = await backend.search(parsed.data.query ?? "RelayAB 搜索连通性测试", 3, fetch);
    return NextResponse.json({
      ok: true,
      data: {
        results,
        latencyMs: Date.now() - started,
        // The endpoint that was actually called, so a mistyped address is
        // visible without reading the code.
        endpoint: parsed.data.baseUrl,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "search_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    );
  }
}
