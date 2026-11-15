/**
 * app/api/models/probe-search/route.ts
 *
 *   POST /api/models/probe-search
 *   Body: { kind, baseUrl, apiKey?, query, limit? } plus the kind's own options.
 *
 * Ask one search backend of an arbitrary vendor the way its own documented API
 * is asked. The four shapes are the vendors this deployment already speaks in
 * its search adapter protocol; anything else is one raw request away.
 *
 *   searxng            GET  {base}/search?q=…&format=json
 *                      + language, safesearch, time_range, categories, pageno
 *   tavily             POST {base}  {api_key, query, max_results, search_depth,
 *                                    topic, include_answer, include_raw_content,
 *                                    days, country}
 *   brave              GET  {base}?q=…&count=…  X-Subscription-Token
 *                      + country, search_lang, safesearch, freshness,
 *                        extra_snippets, offset
 *   openai-compatible  POST {base}  {query, limit}  Bearer
 *
 * `baseUrl` is the endpoint unless the shape says otherwise (searxng appends
 * `/search`), which is why the resolved endpoint is returned to the page.
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

  // SearXNG
  language: z.string().max(20).optional(),
  safesearch: z.string().max(20).optional(),
  timeRange: z.string().max(20).optional(),
  categories: z.string().max(200).optional(),
  pageno: z.number().int().min(1).max(20).optional(),

  // Tavily
  searchDepth: z.enum(["basic", "advanced"]).optional(),
  topic: z.enum(["general", "news", "finance"]).optional(),
  includeAnswer: z.boolean().optional(),
  includeRawContent: z.boolean().optional(),
  days: z.number().int().min(1).max(365).optional(),
  country: z.string().max(20).optional(),

  // Brave
  freshness: z.string().max(30).optional(),
  extraSnippets: z.boolean().optional(),
  offset: z.number().int().min(0).max(9).optional(),
});

type Kind = (typeof KINDS)[number];
type Input = z.infer<typeof BodySchema>;

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

function build(input: Input): { url: string; init: RequestInit } {
  const { kind, query } = input;
  const key = input.apiKey?.trim() || "";
  const max = input.limit ?? 5;
  const headers: Record<string, string> = {};

  if (kind === "searxng") {
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(endpointFor(kind, input.baseUrl));
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    if (input.language) url.searchParams.set("language", input.language);
    if (input.safesearch) url.searchParams.set("safesearch", input.safesearch);
    if (input.timeRange) url.searchParams.set("time_range", input.timeRange);
    if (input.categories) url.searchParams.set("categories", input.categories);
    if (input.pageno) url.searchParams.set("pageno", String(input.pageno));
    return { url: url.toString(), init: { method: "GET", headers } };
  }

  if (kind === "tavily") {
    if (key) headers.Authorization = `Bearer ${key}`;
    return {
      url: endpointFor(kind, input.baseUrl),
      init: {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: max,
          ...(input.searchDepth ? { search_depth: input.searchDepth } : {}),
          ...(input.topic ? { topic: input.topic } : {}),
          ...(input.includeAnswer ? { include_answer: true } : {}),
          ...(input.includeRawContent ? { include_raw_content: true } : {}),
          ...(input.days ? { days: input.days } : {}),
          ...(input.country ? { country: input.country } : {}),
        }),
      },
    };
  }

  if (kind === "brave") {
    if (key) headers["X-Subscription-Token"] = key;
    const url = new URL(endpointFor(kind, input.baseUrl));
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(max));
    if (input.country) url.searchParams.set("country", input.country);
    if (input.language) url.searchParams.set("search_lang", input.language);
    if (input.safesearch) url.searchParams.set("safesearch", input.safesearch);
    if (input.freshness) url.searchParams.set("freshness", input.freshness);
    if (input.extraSnippets) url.searchParams.set("extra_snippets", "true");
    if (input.offset) url.searchParams.set("offset", String(input.offset));
    return { url: url.toString(), init: { method: "GET", headers } };
  }

  if (key) headers.Authorization = `Bearer ${key}`;
  return {
    url: endpointFor(kind, input.baseUrl),
    init: {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: max }),
    },
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

  const input = parsed.data;
  const endpoint = endpointFor(input.kind, input.baseUrl);
  const problem = protocolProblem(endpoint);
  if (problem) {
    return NextResponse.json({ ok: false, error: { code: "bad_endpoint", message: problem } }, { status: 400 });
  }

  const { url, init } = build(input);
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
    // SearXNG has no count parameter; its page size is the engine's. The tester
    // asks for N results, so trim the page to N instead of silently ignoring
    // the field. (The count still cannot exceed what the page returned.)
    if (
      input.kind === "searxng" &&
      input.limit &&
      json &&
      typeof json === "object" &&
      Array.isArray((json as { results?: unknown }).results)
    ) {
      json = {
        ...(json as Record<string, unknown>),
        results: (json as { results: unknown[] }).results.slice(0, input.limit),
      };
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
