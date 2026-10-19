/**
 * app/api/admin/search-providers/[id]/test/route.ts
 *
 *   POST → run one query through exactly this provider
 *
 * Not billed, and deliberately not gated on `enabled`: the operator presses
 * this to find out whether a provider works, and a diagnostic that refuses to
 * run on a disabled provider cannot answer the question it exists for.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getSearchProviderById } from "@/lib/db/search-providers";
import { backendForSearchProvider } from "@/lib/search/resolve";
import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  searchWeb,
  WebSearchError,
} from "@/lib/assistant/web-search";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

export async function POST(
  req: Request,
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
  const provider = await getSearchProviderById(id);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Search provider not found" } },
      { status: 404 },
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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" } },
      { status: 400 },
    );
  }

  const backend = backendForSearchProvider(provider);
  if (!backend) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "这个提供商的配置不完整（缺少地址、密钥，或密钥无法解密）",
        },
      },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const outcome = await searchWeb(parsed.data.query, {
      backend,
      limit: parsed.data.limit ?? 5,
    });
    return NextResponse.json({
      ok: true,
      data: {
        providerId: outcome.providerId,
        provider: outcome.provider,
        backend: outcome.backend,
        query: outcome.query,
        results: outcome.results,
        latencyMs: Date.now() - started,
        billed: false,
      },
    });
  } catch (err) {
    const message =
      err instanceof WebSearchError
        ? err.message
        : `搜索失败：${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json(
      { ok: false, error: { code: "search_failed", message } },
      { status: err instanceof WebSearchError && err.code === "not_configured" ? 503 : 502 },
    );
  }
}
