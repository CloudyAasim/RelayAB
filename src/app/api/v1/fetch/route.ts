/**
 * app/api/v1/fetch/route.ts
 *
 * Fetch one page: `POST /v1/fetch`, `{"url": "https://…"}`.
 *
 * The other half of `/v1/search`: a search finds pages, a fetch reads one.
 * An agent that found a page needs somewhere to read it, and the fetching this
 * deployment already does for the assistant — the DNS checks, the redirect
 * ceiling, the refusal of private addresses, the check that the name still
 * resolves somewhere public afterwards — is the fetching worth reusing rather
 * than writing a second, looser one.
 *
 * The answer is the text of the page, not a document about it: a title when the
 * page has one, and the body with its paragraphs intact — as **Markdown**, so
 * that the headings, links and lists a page is made of survive into the
 * reader. That is what the other fetch APIs return, and it is what a model
 * building an answer or a pipeline cutting the page into chunks needs.
 *
 * **Free, like the assistant's own `fetch_page`.** A search costs the operator
 * a vendor call; a fetch costs them bandwidth. Charging for it would be
 * charging for something nobody spent — and the assistant's fetch has never
 * been charged either, so a public one that charges would make the same
 * capability cost two different prices depending on the door.
 */
import { NextResponse } from "next/server";

import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { fetchPage, WebFetchError } from "@/lib/assistant/web-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FetchBody {
  url?: unknown;
}

/**
 * A failed fetch, in the shape the gateway already uses.
 *
 * The codes say which of the two very different problems happened: the
 * address was refused (403), or the page answered but had nothing a reader
 * could use (404).
 */
function fetchErrorResponse(err: WebFetchError): Response {
  const map: Record<WebFetchError["code"], { status: number; code: string }> = {
    bad_url: { status: 400, code: "invalid_request" },
    blocked_address: { status: 403, code: "fetch_blocked" },
    too_large: { status: 413, code: "fetch_too_large" },
    bad_type: { status: 404, code: "fetch_no_content" },
    not_found: { status: 404, code: "fetch_no_content" },
    unreachable: { status: 502, code: "fetch_unreachable" },
  };
  const mapped = map[err.code];
  return proxyError(mapped.status, mapped.code, err.message);
}

export async function POST(req: Request): Promise<Response> {
  let body: FetchBody;
  try {
    body = ((await req.json()) ?? {}) as FetchBody;
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  // Authenticated, because this is an outbound request on the deployment's
  // behalf: an open one would be a proxy anybody could use.
  const auth = await authenticateBearer({ authHeader: resolveAuthHeader(req) });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return proxyError(400, "invalid_request", "url is required");
  }
  if (url.length > 8_192) {
    return proxyError(400, "invalid_request", "url is too long");
  }

  try {
    const page = await fetchPage(url);
    return NextResponse.json({
      url: page.url,
      // Where the page actually ended up: a redirect is part of the answer.
      finalUrl: page.finalUrl,
      ...(page.title ? { title: page.title } : {}),
      /**
       * The page as **Markdown**.
       *
       * The other fetch APIs return Markdown, and for a reader — a model
       * building an answer, a RAG pipeline cutting the page into chunks — the
       * structure is the content: a heading says what a section is, a link
       * says where something else is, a list says what belongs together. The
       * plain text has all of that flattened away.
       *
       * A page that was not HTML keeps its own text: a Markdown document
       * fetched from `.md` is already Markdown.
       */
      content: page.markdown ?? page.text,
      truncated: page.truncated,
      ...(page.source ? { source: page.source } : {}),
      ...(page.downgraded ? { downgraded: true } : {}),
    });
  } catch (err) {
    if (err instanceof WebFetchError) return fetchErrorResponse(err);
    return proxyError(
      502,
      "fetch_unreachable",
      `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
