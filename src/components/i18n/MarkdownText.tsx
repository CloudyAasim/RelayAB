/**
 * MarkdownText — a dictionary string, rendered as the markdown it is.
 *
 * The dictionary carries markdown in a few places: `**emphasis**` and
 * `` `code` ``. The panels that showed those strings printed the markers
 * verbatim, because a `<p>` prints what it is given — so the reader saw
 * `**here is the part that matters**` with the asterisks still on it, and
 * `reasoning_effort` with the backticks still on it.
 *
 * The user documentation had it too, and that one is public.
 *
 * This renders the string through the same escaping renderer the docs panel
 * uses, so the emphasis becomes emphasis and the code becomes code, and
 * nothing a string contains can introduce markup that runs.
 *
 * A `<span>`, because the caller decides what it is: a paragraph, a note, a
 * line of a table. The block renderer would wrap its output in a `<p>`, and a
 * `<p>` inside a `<p>` is not a thing.
 */
import { inlineMarkdownToHtml } from "@/lib/markdown";

export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: inlineMarkdownToHtml(text) }}
    />
  );
}
