/**
 * tests/unit/media-download.test.ts
 *
 * Generated images and videos had no way to be kept: the tester drew them and
 * stopped. That is a preview, not a tool — and for a video the frame on screen is
 * not what was generated.
 *
 * Two things are worth guarding here:
 *
 *   1. the filename — it must come out usable for every shape of source (data
 *      URL, vendor CDN URL, a signed URL whose "name" is 300 characters of token);
 *   2. the button actually exists on the page, and the page asks `saveArtifact`
 *      rather than putting `download` on a cross-origin anchor, where browsers
 *      ignore it and quietly open a tab instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { downloadFileName } from "@/lib/media/download";
import { DICTS } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const TESTER = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "models", "MediaTester.tsx"),
  "utf8",
);
const DOWNLOAD = readFileSync(join(ROOT, "src", "lib", "media", "download.ts"), "utf8");

describe("downloadFileName", () => {
  it("takes the extension from a data URL's own type", () => {
    expect(downloadFileName("data:image/jpeg;base64,/9j/4AAQ", 0)).toBe("relayab-1.jpg");
    expect(downloadFileName("data:image/png;base64,iVBORw0KGgo=", 4)).toBe("relayab-5.png");
    expect(downloadFileName("data:image/webp;base64,UklGR", 0)).toBe("relayab-1.webp");
  });

  it("keeps the vendor's own basename when it looks like a name", () => {
    expect(downloadFileName("https://cdn.example/img/cat-01.png?x=1", 0)).toBe("cat-01.png");
    expect(downloadFileName("https://cdn.example/a/b/clip.MP4", 1)).toBe("clip.MP4");
  });

  it("does not mistake a signed token for a filename", () => {
    const signed = `https://cdn.example/${"a".repeat(120)}.png?sign=1`;
    expect(downloadFileName(signed, 2)).toBe("relayab-3.png");
  });

  it("falls back when there is no usable basename", () => {
    expect(downloadFileName("https://cdn.example/", 0)).toBe("relayab-1.png");
    expect(downloadFileName("https://cdn.example/download?id=7", 0)).toBe("relayab-1.png");
    expect(downloadFileName("not a url", 0)).toBe("relayab-1.png");
  });

  it("uses the caller's fallback extension for video", () => {
    expect(downloadFileName("https://cdn.example/", 0, "mp4")).toBe("relayab-1.mp4");
    expect(downloadFileName("data:application/octet-stream;base64,AAAA", 0, "mp4")).toBe(
      "relayab-1.mp4",
    );
  });
});

describe("saving from the media tester", () => {
  it("draws a download control in both the image and the video result", () => {
    // Two call sites on the image side (url artifacts, then inline ones) and one
    // on the video side.
    const calls = TESTER.match(/<ArtifactDownload/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("asks saveArtifact, because `download` is ignored cross-origin", () => {
    expect(TESTER).toContain("saveArtifact(src, filename)");
    // The naive version is exactly what this replaced.
    expect(TESTER).not.toMatch(/<a[^>]+download=/);
    expect(DOWNLOAD).toContain('mode: "cors"');
    expect(DOWNLOAD).toContain("window.open");
  });

  it("labels the control in both languages", () => {
    expect(DICTS["zh-CN"]["dashboard.models.media.download"]).toBe("下载");
    expect(DICTS.en["dashboard.models.media.download"]).toBe("Download");
  });
});
