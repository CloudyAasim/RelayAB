/**
 * app/api/models/probe-search/route.ts
 *
 *   POST /api/models/probe-search
 *   Body: { kind, baseUrl, apiKey?, query, limit? }
 *
 * Ask one search backend of an arbitrary vendor the same way its own documented
 * API is asked. Four shapes cover the vendors this deployment already speaks
 * elsewhere (the search adapter protocol), so the test does not re-invent them:
 *
 *   searxng            GET  {base}/search?q=…&format=json
 *   tavily             POST {base}                      {api_key, query, max_results}
 *   brave              GET  {base}?q=…&count=…          X-Subscription-Token
 *   openai-compatible  POST {base}                      {query, limit}  Bearer
 *
 * `baseUrl` is the endpoint unless the shape says otherwise (searxng appends
 * `/search`), which is why the resolved endpoint is returned to the page: the
 * tester shows what it actually called.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const KINDS = ["searxng", "tavily", "brave", "openai-compatible"] as const;

const BodySchema = z.object({
  kind: z.enum(KINDS),
  baseUrl: z.string().min(1, "请填写搜索地址").max(500),
  apiKey: z.string().max(500).optional(),
  query: z.string().min(1, "请填写关键词").max(500),
  limit: z.number().int().min(1).max(20).optional(),
});

type Kind = (typeof KINDS)[number];

function endpointFor(kind: Kind, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return kind === "searxng" ? `${base}/search` : base;
}

function protocolProblem(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "只支持 http / https";
  } catch {
    return "搜索地址不是合法 URL";
  }
}

function build(kind: Kind, endpoint: string, query: string, apiKey?: string, limit?: number) {
  const headers: Record<string, string> = {};
  const key = apiKey?.trim() || "";
  const max = limit ?? 5;

  if (kind === "searxng") {
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    return { url: url.toString(), init: { method: "GET", headers } as RequestInit };
  }

  if (kind === "tavily") {
    if (key) headers.Authorization = `Bearer ${key}`;
    return {
      url: endpoint,
      init: {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: max }),
      } as RequestInit,
    };
  }

  if (kind === "brave") {
    if (key) headers["X-Subscription-Token"] = key;
    const url = new URL(endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(max));
    return { url: url.toString(), init: { method: "GET", headers } as RequestInit };
  }

  if (key) headers.Authorization = `Bearer ${key}`;
  return {
    url: endpoint,
    init: {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: max }),
    } as RequestInit,
  };
}

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

  const { kind, baseUrl, apiKey, query, limit } = parsed.data;
  const endpoint = endpointFor(kind, baseUrl);
  const problem = protocolProblem(endpoint);
  if (problem) {
    return NextResponse.json({ ok: false, error: { code: "bad_endpoint", message: problem } }, { status: 400 });
  }

  const { url, init } = build(kind, endpoint, query, apiKey, limit);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const latencyMs = Date.now() - started;
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text below */
    }
    return NextResponse.json({
      ok: true,
      data: {
        endpoint: url,
        ok: res.ok,
        status: res.status,
        latencyMs,
        json,
        text: json ? undefined : text.slice(0, 8000),
      },
    });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      data: {
        endpoint: url,
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
