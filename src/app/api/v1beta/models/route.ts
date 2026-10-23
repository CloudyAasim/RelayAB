/**
 * app/api/v1beta/models/route.ts
 *
 * The Gemini model catalogue.
 *
 * A Gemini client asks for its model list before it talks — the Google SDK's
 * `models.list()`, LangChain's `ChatGoogleGenerativeAI` listing, the CLI's
 * picker. Without this route the request landed on the `generateContent`
 * catch-all, which answers 404 with "Unknown Gemini path" — so a client that
 * loads its models first failed to start, while the chat endpoint was fine.
 *
 * That is the same hole the Anthropic surface had until it got
 * `GET /anthropic/v1/models`: a missing endpoint in a document is a missing
 * feature, and the symptom lands in the client's UI as "cannot load models"
 * rather than as a visible HTTP error.
 *
 * The shape is Google's own: `models` (not `data`), each entry named
 * `models/<id>`, carrying the token limits the SDKs size a request by.
 *
 * Auth: the Google carriers (`x-goog-api-key`, `?key=`) as well as the
 * OpenAI-shaped ones — see `resolveAuthHeader`.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { geminiModelList, listClientModelDetails } from "@/lib/proxy/model-catalog";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const models = geminiModelList(await listClientModelDetails(auth.key, auth.user));

  // The quota headers ride along for the same reason they do on the other two
  // lists: a client polling the catalogue gets its remaining balance from the
  // same call.
  return NextResponse.json(
    { models },
    { headers: auth.user ? quotaHeaders(auth.user) : undefined },
  );
}
