/**
 * src/lib/media/test-result.ts
 *
 * One shape for "what a media test produced", shared by the account route, the
 * public endpoints' client, and the page that draws the result.
 *
 * Why this exists: the media tester has two credential paths, and until now they
 * answered in two different shapes.
 *
 *   - **key path** — the browser calls `/v1/images/generations` itself and gets
 *     the public, OpenAI-shaped body: `{ data: [{ url | b64_json }] }`.
 *   - **account path** — the browser calls `/api/assistant/test-media`, which
 *     answers `{ ok, data: { urls, b64 } }` (it has to, because it also carries
 *     `via`/`ms`).
 *
 * The page parsed *both* with the public-shape reader. A successful account call
 * therefore arrived in 26 seconds and rendered as "（没有产物）" — the request
 * worked and the result was thrown away one line later. The same mismatch made a
 * transcription through the account path print the whole JSON envelope instead
 * of the transcript.
 *
 * So the reader understands both shapes, and the writer emits the richer one.
 * Nothing here imports node builtins or `next/headers`: the same module is used
 * by a route handler and by a client component.
 */
import type { MediaItem } from "./engine";

/** A data URL for a base64 image, with the type sniffed from its first bytes. */
export function imageDataUrl(base64: string): string {
  const mime = base64.startsWith("iVBORw0KGgo")
    ? "image/png"
    : base64.startsWith("/9j/")
      ? "image/jpeg"
      : base64.startsWith("UklGR")
        ? "image/webp"
        : base64.startsWith("R0lGOD")
          ? "image/gif"
          : // Vendors that encode PNG without the canonical prefix exist; the
            // browser sniffs image/png fine, and guessing jpeg would be wrong.
            "image/png";
  return `data:${mime};base64,${base64}`;
}

/** What `/api/assistant/test-media` answers for a JSON capability. */
export interface MediaTestPayload {
  via: "account";
  ms: number;
  /** Artifacts the vendor handed over as links. */
  urls: string[];
  /** Artifacts that arrived as base64, already turned into displayable data URLs. */
  images: string[];
  /** Transcript, for `audio.stt`. */
  text?: string;
  /** Vendor task id, when the spec exposed one. */
  id?: string;
}

/**
 * Turn the engine's items into that payload.
 *
 * Base64 artifacts used to be reduced to a **count**, which is a number the page
 * can neither show nor download — for a vendor whose spec returns
 * `image_base64` (MiniMax's `response_format: "base64"`, OpenAI's `b64_json`)
 * the tester announced "1 张 base64 图片" and stopped. Carrying the data URL
 * through costs one copy and makes the same artifact visible on both paths.
 */
export function buildMediaTestPayload(
  items: readonly MediaItem[],
  meta: { ms: number; text?: string; id?: string },
): MediaTestPayload {
  const urls: string[] = [];
  const images: string[] = [];
  for (const item of items) {
    if (item.kind === "url") urls.push(item.value);
    else if (item.kind === "base64") images.push(imageDataUrl(item.value));
  }
  return {
    via: "account",
    ms: meta.ms,
    urls,
    images,
    ...(meta.text ? { text: meta.text } : {}),
    ...(meta.id ? { id: meta.id } : {}),
  };
}

/** What the page needs out of either shape. */
export interface MediaTestResult {
  urls: string[];
  images: string[];
  text: string;
}

const EMPTY: MediaTestResult = { urls: [], images: [], text: "" };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Read a media answer in either shape.
 *
 * - `{ data: { urls, images, text } }` — the account route (this module's payload).
 * - `{ data: [{ url } | { b64_json }] }` — the public OpenAI-shaped endpoints.
 * - `{ text }` — a transcription answered by a route that speaks plainly.
 *
 * Unknown shapes read as empty rather than throwing: a page that reports "nothing
 * came back" is honest, a page that crashes on a shape it did not expect is not.
 */
export function readMediaTestResult(payload: unknown): MediaTestResult {
  if (!payload || typeof payload !== "object") return EMPTY;
  const root = payload as Record<string, unknown>;
  const data = root.data;

  // Account shape: `data` is an object.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const envelope = data as Record<string, unknown>;
    const text =
      typeof envelope.text === "string"
        ? envelope.text
        : typeof root.text === "string"
          ? root.text
          : "";
    return { urls: stringList(envelope.urls), images: stringList(envelope.images), text };
  }

  // Public shape: `data` is an array of image rows.
  if (Array.isArray(data)) {
    const urls: string[] = [];
    const images: string[] = [];
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (typeof record.url === "string") urls.push(record.url);
      else if (typeof record.b64_json === "string") images.push(imageDataUrl(record.b64_json));
    }
    const text = typeof root.text === "string" ? root.text : "";
    return { urls, images, text };
  }

  // A plain `{ text }` answer (some transcriptions) still reads.
  if (typeof root.text === "string") return { urls: [], images: [], text: root.text };

  return EMPTY;
}
