/**
 * src/components/docs/ProtocolReference.tsx
 *
 * Renders an adapter protocol **from the repository file** so the admin panel
 * and the repo can never disagree about the syntax. Ships with one-click copy
 * in both Markdown and plain text, because this is the block operators paste
 * into an AI assistant to get a spec written or corrected.
 *
 * Three protocols, one component: the media one (`docs/模型适配协议/README.md`),
 * the search one (`docs/搜索适配协议/README.md`) and the text one
 * (`docs/文本适配协议/README.md`). They are read through the same reader
 * pattern, and the assistant's `get_media_spec_reference` /
 * `get_search_spec_reference` / `get_text_spec_reference` read the same files,
 * so the panel and the model always see the same text.
 *
 * The files are on disk at runtime — `pnpm start` runs `next start` from the
 * project root — and they are read through `readProtocolDoc` /
 * `readSearchProtocolDoc` / `readTextProtocolDoc`. There used to be no way for
 * the assistant to read the media protocol: it lives in a file rather than in
 * the i18n dictionary, so `read_docs` returned the sentence that announces it
 * and none of it.
 */
import { getT } from "@/lib/i18n/server";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown";
import { readProtocolDoc } from "@/lib/docs/protocol-doc";
import { readSearchProtocolDoc } from "@/lib/docs/search-protocol-doc";
import { readTextProtocolDoc } from "@/lib/docs/text-protocol-doc";
import { CopyButtons } from "./CopyButtons";

export async function ProtocolReference({
  kind = "media",
}: {
  kind?: "media" | "search" | "text";
}) {
  const { t } = await getT();
  const { text: source } =
    kind === "search"
      ? await readSearchProtocolDoc()
      : kind === "text"
        ? await readTextProtocolDoc()
        : await readProtocolDoc();

  const buttons = source
    ? [
        {
          key: "markdown",
          label: t("admin.docs.copyProtocolMarkdown"),
          value: source,
        },
        {
          key: "text",
          label: t("admin.docs.copyProtocolPlain"),
          value: markdownToPlainText(source),
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      {buttons.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2.5">
          <span className="text-xs text-muted-foreground">
            {t("admin.docs.copyProtocolHint")}
          </span>
          <CopyButtons
            options={buttons}
            copiedLabel={t("docs.copy.copied")}
            failLabel={t("docs.copy.failed")}
          />
        </div>
      )}

      {source ? (
        <div
          className="prose prose-sm max-w-none text-foreground dark:prose-invert prose-headings:scroll-mt-20 prose-pre:bg-foreground/[0.03] prose-code:before:content-none prose-code:after:content-none"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(source) }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("admin.docs.protocolUnavailable")}
        </p>
      )}
    </div>
  );
}
