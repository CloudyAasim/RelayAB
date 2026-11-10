/**
 * src/lib/media/download.ts
 *
 * Saving a generated artifact.
 *
 * The media tester drew the picture and stopped there: there was no way to keep
 * it, short of right-click → "save image as". A test page whose output you cannot
 * take away is a preview, not a tool — especially for video, where the frame is
 * not the thing you wanted.
 *
 * **`download` is ignored for cross-origin URLs.** The vendors hand artefacts
 * back from their own CDNs, so a bare `<a download>` would open the image in a
 * tab instead of saving it. The honest sequence is therefore:
 *
 *   1. `data:` / `blob:` — an anchor with `download` works, no network involved;
 *   2. otherwise fetch the bytes and save the blob (works whenever the CDN sends
 *      CORS headers, which the common ones do);
 *   3. if that fetch fails — no CORS, offline — open the URL in a new tab. That
 *      is still one click from "Save as", and it is not a lie about having saved
 *      something.
 *
 * The filename derivation is pure and tested; only the two save helpers touch the
 * DOM, and only when called.
 */

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

/** Extensions we are willing to carry over from the vendor's own path. */
const KNOWN_EXTENSION = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|ogg)$/i;

/**
 * A filename for the `index`-th artifact of a run.
 *
 * Keeps the vendor's own basename when it looks like one (`cat-01.png`), because
 * a name the server chose is usually more meaningful than `relayab-3.png`; falls
 * back to a predictable name otherwise.
 */
export function downloadFileName(src: string, index: number, fallbackExtension = "png"): string {
  const dataUrl = /^data:([^;,]+)[;,]/.exec(src);
  if (dataUrl) {
    const extension = MIME_EXTENSION[dataUrl[1].toLowerCase()] ?? fallbackExtension;
    return `relayab-${index + 1}.${extension}`;
  }

  try {
    const basename = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "");
    // A 200-character signed-URL token is not a filename; a real basename is.
    if (basename && basename.length <= 80 && KNOWN_EXTENSION.test(basename)) return basename;
  } catch {
    // Not a URL (`about:blank`, a relative path) — fall through to the default.
  }

  return `relayab-${index + 1}.${fallbackExtension}`;
}

function triggerAnchor(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Save an artifact, or open it when the bytes cannot be read.
 *
 * Returns nothing on purpose: a download that fails is still a navigation the
 * browser handles, and a toast on top of a tab that just opened says the same
 * thing twice.
 */
export function saveArtifact(src: string, filename: string): void {
  if (src.startsWith("data:") || src.startsWith("blob:")) {
    triggerAnchor(src, filename);
    return;
  }

  void (async () => {
    try {
      const res = await fetch(src, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      triggerAnchor(objectUrl, filename);
      // Give the browser a moment to start the save before revoking.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch {
      window.open(src, "_blank", "noopener,noreferrer");
    }
  })();
}
