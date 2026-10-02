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
 * Split the assistant's prose into text and links.
 *
 * A previous version turned image-looking URLs in here into pictures as well,
 * which was wrong twice over: the artefact is already rendered by the tool
 * message directly above, so every generated image appeared twice; and when the
 * model *meant* to hand over a link, the reader got a second picture instead of
 * something clickable.
 *
 * The rule this encodes: pictures come from tool results, and a URL in prose is
 * a link, always. The system prompt tells the model the same thing.
 *
 * Only http(s) and same-origin paths become links. A `javascript:` or `data:`
 * URL in a model response has nowhere to go.
 */
export type Segment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; label: string };

function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith("/");
}

const MARKDOWN_IMAGE = /!\[\s*([^\]]*)\s*\]\(\s*([^)\s]+)[^)]*\)/g;
const BARE_URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/gi;

export function splitLinks(text: string): Segment[] {
  const segments: Segment[] = [];
  const push = (segment: Segment): void => {
    const last = segments[segments.length - 1];
    if (last && last.kind === "text" && segment.kind === "text") {
      last.value += segment.value;
      return;
    }
    segments.push(segment);
  };

  // Markdown image syntax is a redundant reference to something already shown,
  // so it becomes a plain link rather than a second picture - and never literal
  // brackets, which is what it looked like before.
  let rest = text.replace(MARKDOWN_IMAGE, (_match, alt: string, url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: alt.trim() || url });
    return "";
  });

  rest = rest.replace(BARE_URL, (url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: url });
    return " ";
  });

  push({ kind: "text", value: rest });
  return segments.map((s) => (s.kind === "text" ? { ...s, value: s.value.replace(/[ \t]{2,}/g, " ") } : s));
}

/**
 * An assistant message: its prose, with any URL it mentions made clickable.
 *
 * Pictures are NOT rendered here. The tool result directly above already shows
 * whatever was produced, and a second copy - whether the model pasted a link or
 * the page turned the link into one - is the picture appearing twice.
 */
export function AssistantBody({ text, thinkingLabel }: { text: string; thinkingLabel: string }) {
  if (!text) {
    return <span className="text-muted-foreground">{thinkingLabel}</span>;
  }
  return (
    <div className="whitespace-pre-wrap break-words">
      {splitLinks(text).map((segment, i) =>
        segment.kind === "link" ? (
          <a
            key={`${segment.value}-${i}`}
            href={segment.value}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-primary"
          >
            {segment.label}
          </a>
        ) : (
          <span key={`t-${i}`}>{segment.value}</span>
        ),
      )}
    </div>
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
