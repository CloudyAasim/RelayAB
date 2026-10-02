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

/**
 * How big a linked file is, without downloading it.
 *
 * HEAD is the cheap probe, and for most hosts it is the whole answer. It is not
 * always: a presigned URL is signed for the method that was signed, and the
 * images this deployment generates live on an Aliyun OSS link that answers HEAD
 * with 403 and a 1225-byte `application/xml` error body. Reading that turned a
 * 280 KB JPEG into "1.2 KB, application/xml" on the panel - a wrong number, and
 * a more confident-looking one than the blank row it replaced.
 *
 * So a refused HEAD falls through to a ranged GET. A 206 carries the whole
 * length in `Content-Range` for one byte of transfer, and its content type is
 * the file's rather than an error document's.
 *
 * Returns nulls rather than a guess when neither works. A blank row is a small
 * loss; a wrong one is a lie the reader has no way to catch.
 */
async function probeRemote(
  url: string,
): Promise<{ bytes: number | null; contentType: string | null }> {
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (head?.ok) {
    const length = Number(head.headers.get("content-length") ?? NaN);
    return {
      bytes: Number.isFinite(length) && length > 0 ? length : null,
      contentType: head.headers.get("content-type"),
    };
  }

  // One byte is enough to learn the whole length.
  const slice = await fetch(url, { headers: { range: "bytes=0-0" } }).catch(() => null);
  if (!slice?.ok) return { bytes: null, contentType: null };
  // A server that ignores Range answers 200 with the length in Content-Length;
  // one that honours it answers 206 with `bytes 0-0/286812`.
  const contentType = slice.headers.get("content-type");
  const total = Number(
    slice.headers.get("content-range")?.split("/")[1] ?? slice.headers.get("content-length") ?? NaN,
  );
  // We only wanted the headers; do not hold the body open.
  void slice.body?.cancel();
  return { bytes: Number.isFinite(total) && total > 0 ? total : null, contentType };
}

export async function GET(
  req: Request,
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

  // `?meta=1` reports what the file is without sending it. A generated image
  // usually lives at an upstream link, so the size and the real content type
  // were never known here — and the reader is shown both. One HEAD per artefact,
  // on demand, rather than fetching every file just to label it.
  if (new URL(req.url).searchParams.get("meta") === "1") {
    if (artifact.bytes) {
      return NextResponse.json({
        ok: true,
        data: { bytes: artifact.bytes.byteLength, contentType: artifact.contentType },
      });
    }
    if (!artifact.url || !isHttpUrl(artifact.url)) {
      return NextResponse.json({ ok: true, data: { bytes: null, contentType: artifact.contentType } });
    }
    const { bytes, contentType } = await probeRemote(artifact.url);
    return NextResponse.json({
      ok: true,
      data: {
        bytes,
        // The stored type for a linked artefact is a placeholder; the upstream
        // knows better, and the whole point of asking is to replace it.
        contentType: contentType ?? artifact.contentType,
      },
    });
  }

  // `?dl=1` means "hand it over as a file". A `download` attribute on a link to
  // a redirect is not something a browser will honour once it has followed the
  // hop to another origin, so a download asks us to stream it instead - and
  // only then, which keeps the redirect cheap for the ordinary case of someone
  // just looking at a picture.
  const wantsDownload = new URL(req.url).searchParams.get("dl") === "1";
  const filename = `${artifact.kind}-${artifact.id}`;

  if (artifact.url) {
    if (!isHttpUrl(artifact.url)) {
      // Stored by us, so this should be unreachable; a non-web scheme here
      // would turn this route into an open redirect onto javascript:.
      return NextResponse.json(
        { ok: false, error: { code: "bad_artifact", message: "产物地址不合法" } },
        { status: 502 },
      );
    }
    if (!wantsDownload) return NextResponse.redirect(artifact.url, 302);

    const upstream = await fetch(artifact.url).catch(() => null);
    if (!upstream || !upstream.ok || !upstream.body) {
      return NextResponse.json(
        { ok: false, error: { code: "upstream_unavailable", message: "源文件暂时取不到" } },
        { status: 502 },
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? artifact.contentType,
        "Content-Disposition": `attachment; filename="${filename}${extOf(upstream.headers.get("content-type"))}"`,
        "Cache-Control": "private, no-store",
      },
    });
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
      ...(wantsDownload
        ? { "Content-Disposition": `attachment; filename="${filename}${extOf(artifact.contentType)}"` }
        : {}),
      // Session-scoped: must never be cached by a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** A filename needs an extension or some platforms will not treat it as a file. */
function extOf(contentType: string | null): string {
  if (!contentType) return "";
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return map[contentType.split(";")[0].trim().toLowerCase()] ?? "";
}
