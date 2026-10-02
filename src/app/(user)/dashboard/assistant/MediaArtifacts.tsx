"use client";

/**
 * src/app/(user)/dashboard/assistant/MediaArtifacts.tsx
 *
 * Renders what a tool actually produced.
 *
 * Everything here used to arrive as a line of text: the upstream's CDN URL for
 * an image, a byte count for a sound whose bytes were then discarded. A picture
 * you have to click a link to, or a length you can read but not hear, is not the
 * same as a picture in the conversation.
 *
 * The URLs are relative and session-scoped, which is what makes them safe to put
 * in a page: the browser resolves them against this origin with its own cookie,
 * so the server can check who is asking. An upstream CDN link would be fetched
 * anonymously by whoever the page is shown to.
 */
import type { ArtifactRef } from "@/lib/db/assistant-artifacts";

/**
 * Read the references a tool message carries.
 *
 * Returns an empty list for anything that is not a tool result carrying
 * artefacts — prose, a refusal, an old transcript written before this existed —
 * rather than throwing, because a missing picture must never break the
 * conversation around it.
 */
export function artifactsFromToolContent(content: string): ArtifactRef[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const found = (parsed as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(found)) return [];
    return found.filter((a): a is ArtifactRef => {
      if (!a || typeof a !== "object") return false;
      const candidate = a as Partial<ArtifactRef>;
      const kindOk =
        candidate.kind === "image" || candidate.kind === "audio" || candidate.kind === "video";
      return kindOk && typeof candidate.id === "string" && typeof candidate.url === "string";
    });
  } catch {
    return [];
  }
}

/**
 * Pull images out of the assistant's own text.
 *
 * The model was told not to paste links, and it mostly listens — but when it
 * does, `![alt](url)` in a plain-text renderer shows up as a row of brackets
 * and parentheses, which reads as the assistant being broken rather than as
 * the assistant being redundant. Rendering it costs nothing and removes the
 * worst version of the mistake.
 *
 * Only http(s) and same-origin paths become images. A `javascript:` URL in a
 * model response must never reach an `src`.
 */
export function splitMediaFromText(text: string): { media: string[]; text: string } {
  const media: string[] = [];
  const isSafe = (url: string): boolean => /^https?:\/\//i.test(url) || url.startsWith("/");

  const markdown = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
  let rest = text.replace(markdown, (_match, url: string) => {
    if (isSafe(url)) media.push(url);
    return "";
  });

  // A bare link on its own line, which is what a model writes when it decides
  // the URL is the interesting part.
  rest = rest.replace(/(^|\n)[ \t]*(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|mp3|m4a|wav|mp4|webm))[ \t]*(?=\n|$)/gi, (_match, lead: string, url: string) => {
    if (isSafe(url)) media.push(url);
    return lead;
  });

  return { media: [...new Set(media)], text: rest.replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * An assistant message: its text, plus any image the model pasted into it.
 *
 * The tool result above already renders the artefact itself, so this is only
 * about the case where the model decided to write the link out in prose. Kept
 * in this file because it is the same problem — a media file the conversation
 * should show rather than spell out.
 */
export function AssistantBody({ text, thinkingLabel }: { text: string; thinkingLabel: string }) {
  if (!text) {
    return <span className="text-muted-foreground">{thinkingLabel}</span>;
  }
  const { media, text: rest } = splitMediaFromText(text);
  return (
    <>
      {media.length > 0 && (
        <div className="mb-2 space-y-2">
          {media.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element -- these are
            // session-scoped routes, not static assets, and the media tag
            // carries the session cookie that the route authorises against.
            <img
              key={url}
              src={url}
              alt=""
              className="max-h-96 w-auto max-w-full rounded-lg border border-border"
            />
          ))}
        </div>
      )}
      {rest && <div className="whitespace-pre-wrap break-words">{rest}</div>}
    </>
  );
}

export function MediaArtifacts({ artifacts }: { artifacts: ArtifactRef[] }) {
  if (artifacts.length === 0) return null;
  return (
    <div className="space-y-3">
      {artifacts.map((artifact) => {
        if (artifact.kind === "image") {
          return (
            <a key={artifact.id} href={artifact.url} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- the URL is
                  a session-scoped route, not a static asset, and next/image would
                  need a loader that can authenticate the fetch. */}
              <img
                src={artifact.url}
                alt="生成结果"
                className="max-h-96 w-auto max-w-full rounded-lg border border-border"
              />
            </a>
          );
        }
        if (artifact.kind === "video") {
          return (
            <video
              key={artifact.id}
              src={artifact.url}
              controls
              preload="metadata"
              className="max-h-96 w-auto max-w-full rounded-lg border border-border"
            />
          );
        }
        return <audio key={artifact.id} src={artifact.url} controls preload="metadata" className="w-full" />;
      })}
    </div>
  );
}
