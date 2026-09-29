/**
 * src/components/docs/ProtocolReference.tsx
 *
 * Renders the media adapter protocol **from the repository file**
 * (`docs/模型适配协议/README.md`) so the admin panel and the repo can never
 * disagree about the syntax. Ships with one-click copy in both Markdown and
 * plain text, because this is the block operators paste into an AI assistant
 * to get a spec written or corrected.
 *
 * `outputFileTracingIncludes` in next.config.ts keeps the file in the
 * deployment bundle; if it is ever missing the page degrades to a note plus
 * the still-working copy buttons.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getT } from "@/lib/i18n/server";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown";
import { CopyButtons } from "./CopyButtons";

const PROTOCOL_DOC = path.join(process.cwd(), "docs", "模型适配协议", "README.md");

export async function ProtocolReference() {
  const { t } = await getT();

  let source = "";
  try {
    source = await readFile(PROTOCOL_DOC, "utf8");
  } catch {
    source = "";
  }

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
