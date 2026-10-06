"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
 * One of our own artefact paths, matched by the shape it actually has.
 *
 * This runs before the generic relative-path matcher, and it has to. That
 * matcher treats any run of `/segment/segment` as a single path, so two
 * artefact addresses written back to back — which is what a model does when it
 * is listing the results of one turn that made two pictures — merge into one
 * token. The reader then gets a single link to
 * `…/artifacts/<id>/api/assistant/artifacts/<id>`, which is not an address
 * anything serves, so both pictures are unreachable from the prose.
 *
 * The id is a fixed 26 characters of base62, so this is not a guess: it cannot
 * swallow the `/` that starts the next address, which is the entire point.
 */
const ARTIFACT_PATH = /\/api\/assistant\/artifacts\/[0-9A-Za-z]{26}(?:\?[^\s]*)?/g;

/**
 * A root-relative path, which is how a model actually writes one of ours: it
 * copies `/api/assistant/artifacts/…` straight out of the tool result.
 *
 * Requires a second slash and no whitespace, so ordinary punctuation and bare
 * words are not mistaken for a path.
 *
 * The query string is part of the path. It used to be cut off, which turned
 * `/docs/usage/range?from=2026-01-01` into a link to `/docs/usage/range` —
 * silently the wrong address rather than an obvious failure.
 */
const RELATIVE_PATH = /(?<![\w/])\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%-]+)*(?:\?[^\s]*)?/g;

/** A fenced block, then an inline span. Fenced first: it contains the inline form. */
const CODE_BLOCKS = [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g];

/**
 * What a shielded piece of code is replaced with while the link matchers run.
 *
 * Two private-use characters with an index between them, **padded with spaces**.
 * The padding is not cosmetic: `BARE_URL` matches `[^\s<>()]+`, which a bare
 * private-use character satisfies, so an unpadded sentinel sitting next to a URL
 * would be swallowed into the href. A space stops it, and the restore removes
 * exactly the one space on each side.
 */
const shieldFor = (index: number): string => ` \uE000${index}\uE001 `;
const SHIELD_BACK = / \uE000(\d+)\uE001 /g;

/**
 * One piece of our own: replace every code span with a placeholder, so the link
 * matchers cannot see inside it.
 *
 * A URL in backticks is not a link — it is an *example* of a URL, and the whole
 * point of the backticks is that it is not to be followed. Running the matchers
 * over it anyway pulled the address out of the sentence and left an orphaned
 * backtick on each side; `markdownToHtml` then read what was left as an empty
 * code span, so a perfectly ordinary sentence rendered as its punctuation with
 * nothing between it.
 *
 * It also produced `href="https://…`，通过"` — an address assembled out of
 * model output, carrying the backtick and the Chinese comma it should have
 * stopped at.
 */
function shieldCode(text: string): { masked: string; code: string[] } {
  const code: string[] = [];
  let masked = text;
  for (const re of CODE_BLOCKS) {
    masked = masked.replace(re, (match) => {
      code.push(match);
      return shieldFor(code.length - 1);
    });
  }
  return { masked, code };
}

function restoreCode(segments: Segment[], code: string[]): Segment[] {
  if (code.length === 0) return segments;
  return segments.map((s) =>
    s.kind === "text" ? { ...s, value: s.value.replace(SHIELD_BACK, (_m, i) => code[Number(i)] ?? "") } : s,
  );
}

export function splitLinks(text: string): Segment[] {
  const segments: Segment[] = [];
  const { masked, code } = shieldCode(text);
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
  let rest = masked.replace(MARKDOWN_IMAGE, (_match, alt: string, url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: alt.trim() || url });
    return "";
  });

  rest = rest.replace(BARE_URL, (url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: url });
    return " ";
  });

  rest = rest.replace(ARTIFACT_PATH, (url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: url });
    return " ";
  });

  rest = rest.replace(RELATIVE_PATH, (url: string) => {
    if (isSafeUrl(url)) push({ kind: "link", value: url, label: url });
    return " ";
  });

  push({ kind: "text", value: rest });
  // Restore before collapsing runs of spaces: the shields carry one space on each
  // side to stop `BARE_URL` eating them, and collapsing first would merge them
  // into the neighbouring text so the restore could no longer find them.
  const restored = restoreCode(segments, code);
  return restored.map((s) => (s.kind === "text" ? { ...s, value: s.value.replace(/[ \t]{2,}/g, " ") } : s));
}

/**
 * One piece of an assistant message, in the order the model wrote it.
 */
export interface AssistantPart {
  kind: "thinking" | "text";
  value: string;
}

/**
 * Split a model answer into its reasoning and the prose, **in place**.
 *
 * Reasoning arrives inline in the same text as the answer, so without this it
 * sits in the middle of every reply as a wall of first-person deliberation. It
 * is kept — deleting it would be taking the model's words away — just folded
 * away until asked for.
 *
 * The parts stay in the order they arrived. This used to collect the blocks
 * into an array and hand back one answer string, which threw away where each
 * block had been: the renderer then had to choose, and it put all of them at
 * the top. A model that thinks, answers, thinks again and answers again had its
 * second answer rendered above the first question it was answering.
 */
export function splitThinkingParts(text: string): AssistantPart[] {
  const parts: AssistantPart[] = [];
  // Scanned rather than `replace`d, because `replace` runs the whole string
  // before returning and by then the positions are gone. `exec` in a loop keeps
  // the offset of every match, so each piece of prose stays attached to the
  // reasoning that preceded it.
  const re = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      const before = text.slice(cursor, m.index).trim();
      if (before) parts.push({ kind: "text", value: before });
    }
    const inner = m[1].trim();
    if (inner) parts.push({ kind: "thinking", value: inner });
    // `m[0]` is at least "<think>", so this always advances.
    cursor = m.index + m[0].length;
  }

  if (cursor < text.length) {
    const after = text.slice(cursor).trim();
    if (after) parts.push({ kind: "text", value: after });
  }

  return parts;
}

/**
 * The same split, flattened: every block of reasoning, and the prose with the
 * reasoning removed.
 *
 * Kept for callers that genuinely want the two pools — a transcript search, a
 * test — and not for rendering, which has to use {@link splitThinkingParts} or
 * it will stack the reasoning at the top again.
 */
export function splitThinking(text: string): { thinking: string[]; answer: string } {
  const parts = splitThinkingParts(text);
  return {
    thinking: parts.filter((p) => p.kind === "thinking").map((p) => p.value),
    answer: parts
      .filter((p) => p.kind === "text")
      .map((p) => p.value)
      .join("\n\n")
      .trim(),
  };
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
  reasoning,
  thinkingLabel,
  pretty,
  expandLabel,
  collapseLabel,
}: {
  text: string;
  /**
   * The thinking, arriving as its own stream rather than wrapped in the answer.
   *
   * It used to be recovered by parsing `<think>` tags back out of `text`, which
   * works for exactly one vendor and exactly one configuration: MiniMax sends
   * it in a separate field, so the tags are absent, and the block that was
   * written and styled for this — with a summary that says clicking it does
   * something — had nothing to put in it. Hence "where did the thinking go".
   */
  reasoning?: string;
  thinkingLabel: string;
  pretty: boolean;
  expandLabel: string;
  collapseLabel: string;
}) {
  if (!text && !reasoning) {
    return <span className="text-muted-foreground">{thinkingLabel}</span>;
  }

  // Raw mode shows exactly what arrived, and the reasoning arrived as its own
  // deltas — so it belongs beside the text rather than inside it.
  if (!pretty) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {reasoning ? <div className="opacity-70">{reasoning}</div> : null}
        {text}
      </div>
    );
  }

  // In the order the model wrote it, so a second block of reasoning sits above
  // the paragraph it was reasoning about rather than above the whole reply.
  const parts = splitThinkingParts(text);
  const hasThinking = parts.some((p) => p.kind === "thinking");
  const hasProse = parts.some((p) => p.kind === "text" && p.value.trim());
  const streamReasoning = reasoning?.trim() ?? "";
  const showReasoningBlock = !hasThinking && streamReasoning.length > 0;

  if (!hasThinking && !hasProse && !showReasoningBlock) {
    return <div className="whitespace-pre-wrap">{text}</div>;
  }

  return (
    <div className="space-y-2 break-words">
      {showReasoningBlock && (
        /*
         * No `open` here, deliberately.
         *
         * It was `open={streaming}` so the reasoning would be readable as it
         * arrived — and that made the element controlled, so React wrote the
         * prop over the reader's own state on every re-render. Open it while the
         * answer is streaming and the next token snapped it shut. A disclosure
         * the reader cannot hold open is not a disclosure.
         *
         * Left to the element: collapsed by default, opened by the person who
         * wants it, and staying open. Which is what the block below a `<think>`
         * tag in the answer has always done — two reasoning blocks with the same
         * name should behave the same way.
         */
        <details className="group rounded-md border border-border/60 bg-muted/40">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <span className="font-medium">{thinkingLabel}</span>
            <span className="text-[10px] opacity-70 group-open:hidden">{expandLabel}</span>
            <span className="hidden text-[10px] opacity-70 group-open:inline">
              {collapseLabel}
            </span>
          </summary>
          <div className="border-t border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
            <Prose text={streamReasoning} />
          </div>
        </details>
      )}
      {parts.map((part, i) =>
        part.kind === "thinking" ? (
          <details
            key={`t-${i}`}
            className="group rounded-md border border-border/60 bg-muted/40"
          >
            {/*
              The `summary` is the whole affordance, so it has to say what
              clicking it does. The browser's own triangle is the only other cue
              and it is small, next to a label that reads as a heading rather
              than a control. `expandLabel` and `collapseLabel` were passed in
              and unused — the reasoning looked like a section that had nothing
              under it, which is why "where did the thinking go" was the
              report.
            */}
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <span className="font-medium">{thinkingLabel}</span>
              <span className="text-[10px] opacity-70 group-open:hidden">{expandLabel}</span>
              <span className="hidden text-[10px] opacity-70 group-open:inline">
                {collapseLabel}
              </span>
            </summary>
            <div className="border-t border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
              <Prose text={part.value} />
            </div>
          </details>
        ) : part.value.trim() ? (
          <Prose key={`p-${i}`} text={part.value} />
        ) : null,
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
    const { artifacts, ...rest } = parsed as { artifacts?: unknown } & Record<string, unknown>;
    if (artifacts === undefined) return content;
    /**
     * The URLs stay in the text, in place of the artefact objects.
     *
     * They used to be dropped, and the picture was only ever reachable through
     * the card above — so a transcript of the turn, or a copy of the raw tool
     * output, named a generated image that was in it nowhere. What a reader
     * wants from the raw form is the address, not the record that a card exists
     * somewhere above this line.
     */
    const urls = (Array.isArray(artifacts) ? artifacts : [])
      .map((a) =>
        typeof a === "string"
          ? a
          : a && typeof a === "object" && "url" in a && typeof (a as { url?: unknown }).url === "string"
            ? (a as { url: string }).url
            : null,
      )
      .filter((u): u is string => Boolean(u));
    return JSON.stringify({ ...rest, ...(urls.length > 0 ? { urls } : {}) }, null, 2);
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
  pretty = true,
}: {
  toolName: string | null | undefined;
  label: string;
  content: string;
  downloadLabel: string;
  /**
   * The output-format switch.
   *
   * It used to reach only the assistant's prose, so turning it off gave you a
   * plain-text answer next to a decorated tool card — two renderings of the
   * same reply, which is the one thing a switch like that is not supposed to
   * produce. The artefacts stay either way: a picture has no raw form.
   */
  pretty?: boolean;
}) {
  const display = toolContentForDisplay(content);
  const failed = /\n?\s*"ok":\s*false/.test(content) || /^工具执行失败/.test(content);
  const artifacts = artifactsFromToolContent(content);

  if (!pretty) {
    return (
      <div className="space-y-2">
        {artifacts.length > 0 && <MediaArtifacts artifacts={artifacts} downloadLabel={downloadLabel} />}
        <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          <span className="text-foreground">{toolName ?? label}</span>
          {"\n"}
          {display}
        </div>
      </div>
    );
  }

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

/**
 * What the file actually is, when the row could not know at first.
 *
 * A generated image usually lives at an upstream link, so its size and its
 * content type were never measured here — which left the panel saying
 * "application/octet-stream" and showing no size at all. One HEAD per artefact,
 * asked for only when the row is missing something, and only when it is on
 * screen. A HEAD that fails leaves the row as it was rather than showing a
 * number nobody measured.
 */
function useArtifactMeta(artifact: ArtifactRef): { bytes: number | null; contentType: string } {
  const [meta, setMeta] = useState<{ bytes: number | null; contentType: string }>({
    bytes: artifact.bytes,
    contentType: artifact.contentType,
  });

  useEffect(() => {
    // Nothing to ask: we already hold the file, so we know both answers.
    if (artifact.bytes !== null) {
      setMeta({ bytes: artifact.bytes, contentType: artifact.contentType });
      return;
    }
    let cancelled = false;
    fetch(`${artifact.url}?meta=1`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { bytes?: number | null; contentType?: string } } | null) => {
        if (cancelled || !json?.data) return;
        setMeta({
          bytes: typeof json.data.bytes === "number" ? json.data.bytes : null,
          contentType: json.data.contentType || artifact.contentType,
        });
      })
      .catch(() => {
        /* Leave the row as it was. */
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.url, artifact.bytes, artifact.contentType]);

  return meta;
}

/** Pixel dimensions, read off the image the browser has already loaded. */
function usePixelSize(ref: React.RefObject<HTMLImageElement | null>): [string | null, () => void] {
  const [size, setSize] = useState<string | null>(null);
  const onLoad = useCallback(() => {
    const el = ref.current;
    if (el?.naturalWidth && el?.naturalHeight) setSize(`${el.naturalWidth} × ${el.naturalHeight}`);
  }, [ref]);
  return [size, onLoad];
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
      {artifacts.map((artifact) => (
        <Artifact key={artifact.id} artifact={artifact} downloadLabel={downloadLabel} />
      ))}
    </div>
  );
}

function Artifact({ artifact, downloadLabel }: { artifact: ArtifactRef; downloadLabel: string }) {
  const meta = useArtifactMeta(artifact);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [pixels, onImageLoad] = usePixelSize(imgRef);
  const size = sizeLabel(meta.bytes);
  return (
    <figure
      /* Beside the file, not under it. A caption line under a picture puts the
         two facts the reader wants - what it is, and where it lives - at the
         far edge of a 900px column, and makes the download a word in running
         text. */
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      {artifact.kind === "image" ? (
        <a href={artifact.url} target="_blank" rel="noreferrer" className="block shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- the URL is a
              session-scoped route, not a static asset, and next/image would
              need a loader that can authenticate the fetch. */}
          <img
            ref={imgRef}
            src={artifact.url}
            alt=""
            onLoad={onImageLoad}
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
            <dd className="truncate font-mono text-foreground" title={meta.contentType}>
              {meta.contentType}
            </dd>
          </div>
          {/* Only for something with pixels; a sound has none. */}
          {pixels && (
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-muted-foreground">像素</dt>
              <dd className="font-mono text-foreground">{pixels}</dd>
            </div>
          )}
          {size && (
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-muted-foreground">大小</dt>
              <dd className="text-foreground">{size}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-muted-foreground">链接</dt>
            <dd className="min-w-0">
              {/* The path the model keeps quoting back, shown where it can be
                  read and copied rather than inferred from prose. */}
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

        {/* A `download` attribute is not honoured once the browser has followed
            a redirect to another origin, so the link asks our own route to
            stream the file instead - and only then, which keeps simply looking
            at a picture a cheap redirect. A real button rather than a word in a
            caption: a link you have to read before you know what it does is not
            a button. */}
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
}
