/**
 * app/api/assistant/artifacts/[id]/route.ts
 *
 *   GET /api/assistant/artifacts/:id → the media, or a redirect to it
 *
 * The URL a conversation and the model both see. It is deliberately not the
 * upstream's own link:
 *
 *   - it is scoped to the signed-in user, so an id copied out of one
 *     conversation cannot be replayed by another account;
 *   - an upstream CDN link is typically valid for weeks, which means a
 *     transcript would keep pointing at something the user can no longer
 *     revoke. This one dies with the thread.
 *
 * Rows that kept an upstream link are redirected rather than proxied, so a
 * multi-megabyte image is never copied through the app.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAssistantArtifact } from "@/lib/db/assistant-artifacts";

export const dynamic = "force-dynamic";

/** Only ever redirect to a real web URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const artifact = await getAssistantArtifact(id, me.id);
  if (!artifact) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "产物不存在" } },
      { status: 404 },
    );
  }

  if (artifact.url) {
    if (!isHttpUrl(artifact.url)) {
      // Stored by us, so this should be unreachable; a non-web scheme here
      // would turn this route into an open redirect onto javascript:.
      return NextResponse.json(
        { ok: false, error: { code: "bad_artifact", message: "产物地址不合法" } },
        { status: 502 },
      );
    }
    return NextResponse.redirect(artifact.url, 302);
  }

  if (!artifact.bytes || artifact.bytes.byteLength === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "no_content", message: "产物没有内容" } },
      { status: 404 },
    );
  }

  return new Response(artifact.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": artifact.contentType,
      "Content-Length": String(artifact.bytes.byteLength),
      // Session-scoped: must never be cached by a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
