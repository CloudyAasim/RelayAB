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
import { markdownToHtml } from "@/lib/markdown";
import { buttonVariants } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

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
/**
 * A root-relative path, which is how a model actually writes one of ours: it
 * copies `/api/assistant/artifacts/…` straight out of the tool result. Treating
 * only absolute addresses as links left it sitting in the prose as plain text,
 * which is the same complaint as before with a smaller trigger.
 *
 * Requires a second slash and no whitespace, so ordinary punctuation and bare
 * words are not mistaken for a path.
 */
const RELATIVE_PATH = /(?<![\w/])\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%/-]*)+/g;

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

  rest = rest.replace(RELATIVE_PATH, (url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: url });
    return " ";
  });

  push({ kind: "text", value: rest });
  return segments.map((s) => (s.kind === "text" ? { ...s, value: s.value.replace(/[ \t]{2,}/g, " ") } : s));
}

/**
 * Split a model answer into its reasoning and the part it meant for the reader.
 *
 * Reasoning arrives inline in the same text as the answer, so without this it
 * sits in the middle of every reply as a wall of first-person deliberation. It
 * is kept - deleting it would be taking the model's words away - just put out
 * of the way until asked for.
 */
export function splitThinking(text: string): { thinking: string[]; answer: string } {
  const thinking: string[] = [];
  const answer = text
    .replace(/<think>([\s\S]*?)(?:<\/think>|$)/gi, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) thinking.push(trimmed);
      return "\n\n";
    })
    .trim();
  return { thinking, answer };
}

/**
 * The same typography the docs panel uses, at chat size. Reusing it rather than
 * inventing a second scale is the point: rendered Markdown that looks like the
 * rest of the product's Markdown is one thing to get right, two are not.
 */
const PROSE_CLASS =
  "prose prose-sm max-w-none break-words text-foreground prose-headings:mt-3 prose-headings:mb-1.5 " +
  "prose-p:my-1.5 prose-pre:my-2 prose-pre:bg-foreground/[0.03] " +
  "prose-code:before:content-none prose-code:after:content-none prose-a:text-primary";

/**
 * One contiguous run of prose, rendered as Markdown.
 *
 * Split by URL first so a link becomes a real anchor instead of being escaped
 * into text by the Markdown renderer. Each run is rendered separately, which
 * means a list interrupted by a link will break into blocks around it - an
 * acceptable price for not losing the link.
 */
function Prose({ text }: { text: string }) {
  const segments = splitLinks(text);
  if (segments.length === 1 && segments[0].kind === "text") {
    return (
      <div
        className={PROSE_CLASS}
        // The renderer escapes every input before emitting markup, and is the
        // same audited path the docs panel uses.
        dangerouslySetInnerHTML={{ __html: markdownToHtml(segments[0].value) }}
      />
    );
  }
  return (
    <div className={PROSE_CLASS}>
      {segments.map((segment, i) =>
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
          <span key={`t-${i}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(segment.value) }} />
        ),
      )}
    </div>
  );
}

/**
 * An assistant message.
 *
 * `pretty` is the user's choice, and it is the only thing that decides whether
 * this looks like a document or like a terminal: with it off, the text is shown
 * exactly as it arrived, which is still a perfectly good way to read a
 * conversation and the way to see what the model actually wrote.
 */
export function AssistantBody({
  text,
  thinkingLabel,
  pretty,
  expandLabel,
  collapseLabel,
}: {
  text: string;
  thinkingLabel: string;
  pretty: boolean;
  expandLabel: string;
  collapseLabel: string;
}) {
  if (!text) {
    return <span className="text-muted-foreground">{thinkingLabel}</span>;
  }

  if (!pretty) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  const { thinking, answer } = splitThinking(text);
  return (
    <div className="space-y-2 break-words">
      {thinking.map((block, i) => (
        <details key={i} className="rounded-md border border-border/60 bg-muted/40">
          <summary className="cursor-pointer list-none px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <span className="font-medium">{thinkingLabel}</span>
          </summary>
          <div className="border-t border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
            <Prose text={block} />
          </div>
        </details>
      ))}
      {answer ? (
        <Prose text={answer} />
      ) : thinking.length ? null : (
        <div className="whitespace-pre-wrap">{text}</div>
      )}
    </div>
  );
}

/**
 * The tool's JSON with the artefact references taken out.
 *
 * They are the one part the reader does not need: the picture is already on
 * screen right above, and the raw array is the same link a second time, in a
 * worse form. Everything else in the result is worth showing on demand.
 */
export function toolContentForDisplay(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
    const { artifacts: _dropped, ...rest } = parsed as Record<string, unknown>;
    if (_dropped === undefined) return content;
    return JSON.stringify(rest, null, 2);
  } catch {
    // A refusal is prose, not JSON. Show it as it is.
    return content;
  }
}

/**
 * A tool result: the artefact it produced, and the rest of what it said.
 *
 * The collapsed row is labelled with the tool's own name and whether it
 * succeeded, because a box that only says "⚙ generate_image" gives the reader
 * nothing to go on until they open it.
 */
export function ToolResultCard({
  toolName,
  label,
  content,
  downloadLabel,
}: {
  toolName: string | null | undefined;
  label: string;
  content: string;
  downloadLabel: string;
}) {
  const display = toolContentForDisplay(content);
  const failed = /\n?\s*"ok":\s*false/.test(content) || /^工具执行失败/.test(content);

  return (
    <div className="space-y-2">
      <MediaArtifacts artifacts={artifactsFromToolContent(content)} downloadLabel={downloadLabel} />
      <details className="group rounded-lg border border-border bg-muted/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-destructive" : "bg-primary"}`}
          />
          <span className="font-medium">{toolName ?? label}</span>
          <span className="text-[11px] opacity-70 group-open:hidden">{label}</span>
          <span className="ml-auto text-[11px] opacity-70 group-open:hidden">展开</span>
          <span className="ml-auto hidden text-[11px] opacity-70 group-open:inline">收起</span>
        </summary>
        {display.trim() ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-xs">
            {display}
          </pre>
        ) : null}
      </details>
    </div>
  );
}
/** A short, honest description of a file, for the panel beside it. */
const KIND_LABEL: Record<ArtifactRef["kind"], string> = {
  image: "图片",
  audio: "音频",
  video: "视频",
};

function sizeLabel(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaArtifacts({
  artifacts,
  downloadLabel,
}: {
  artifacts: ArtifactRef[];
  downloadLabel: string;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="space-y-4">
      {artifacts.map((artifact) => {
        const size = sizeLabel(artifact.bytes);
        return (
          <figure
            key={artifact.id}
            /* Beside the file, not under it. A caption line under a picture puts
               the two facts the reader wants - what it is, and where it lives -
               at the far edge of a 900px column, and makes the download a
               word in running text. */
            className="flex flex-col gap-3 sm:flex-row sm:items-start"
          >
            {artifact.kind === "image" ? (
              <a
                href={artifact.url}
                target="_blank"
                rel="noreferrer"
                className="block shrink-0"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the URL is a
                    session-scoped route, not a static asset, and next/image would
                    need a loader that can authenticate the fetch. */}
                <img
                  src={artifact.url}
                  alt=""
                  className="max-h-80 w-auto max-w-full rounded-lg border border-border"
                />
              </a>
            ) : artifact.kind === "video" ? (
              <video
                src={artifact.url}
                controls
                preload="metadata"
                className="max-h-80 w-auto max-w-full shrink-0 rounded-lg border border-border"
              />
            ) : (
              <div className="shrink-0 sm:w-72">
                <audio src={artifact.url} controls preload="metadata" className="w-full" />
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-2.5">
              <dl className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">类型</dt>
                  <dd className="text-foreground">{KIND_LABEL[artifact.kind]}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">格式</dt>
                  <dd className="truncate font-mono text-foreground" title={artifact.contentType}>
                    {artifact.contentType}
                  </dd>
                </div>
                {size && (
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-muted-foreground">大小</dt>
                    <dd className="text-foreground">{size}</dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">链接</dt>
                  <dd className="min-w-0">
                    {/* The path the model keeps quoting back, shown where it can
                        be read and copied rather than inferred from prose. */}
                    <a
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all font-mono text-primary underline underline-offset-2"
                    >
                      {artifact.url}
                    </a>
                  </dd>
                </div>
              </dl>

              {/* A `download` attribute is not honoured once the browser has
                  followed a redirect to another origin, so the link asks our own
                  route to stream the file instead - and only then, which keeps
                  simply looking at a picture a cheap redirect. A real button
                  rather than a word in a caption: a link you have to read before
                  you know what it does is not a button. */}
              <a
                href={`${artifact.url}?dl=1`}
                download
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "no-underline hover:no-underline",
                )}
              >
                {downloadLabel}
              </a>
            </div>
          </figure>
        );
      })}
    </div>
  );
}
