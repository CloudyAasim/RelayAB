import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { INTEGRATION_GUIDE, userChapterAnswers } from "@/lib/docs/sections";
import { PARAMETERS_SECTION } from "@/lib/docs/custom";
import { UserDocsApp } from "./UserDocsApp";
import { userDocGuides } from "@/lib/docs/custom";
import { getSettings } from "@/lib/db/settings";
import type { ReactNode } from "react";

/**
 * The integration docs: resolve this deployment's public URLs, hand the whole
 * document to the client, and get out of the way.
 *
 * Shared by the public `/docs` surface and the signed-in `/dashboard/docs`
 * surface. Nothing is fetched per chapter any more — see `UserDocsApp` for why
 * that is the fix rather than a preference.
 *
 * The operator's pages are read here, once, and the outline is built with the
 * answer already in hand: a tab for a chapter with nothing in it is the thing
 * that makes custom documentation look bolted on.
 */
export async function IntegrationDocs({
  basePath,
  section,
  initialPage = null,
  docPages,
  catalogue,
}: {
  basePath: string;
  section: string;
  /** Which page of the parameters guide a deep link names, if any. */
  initialPage?: string | null;
  docPages?: Awaited<ReturnType<typeof getSettings>>["docPages"];
  catalogue?: ReactNode;
}) {
  const { t } = await getT();
  const base = await resolvePublicUrl();

  const guides = userDocGuides(t, docPages);
  // Both counts are known here, so both labels resolve here. The alternative
  // — shipping a template, or a function that fills it in, across the
  // server/client boundary — is what made /docs answer 500 on every request.
  const integrationChapters =
    guides.find((g) => g.id === INTEGRATION_GUIDE)?.chapters.length ?? 0;
  const parametersPages =
    guides.find((g) => g.id === PARAMETERS_SECTION)?.pages.length ?? 0;

  return (
    <UserDocsApp
      guides={guides}
      initial={section}
      initialPage={initialPage}
      basePath={basePath}
      base={base}
      openaiBase={`${base}/v1`}
      anthropicBase={`${base}/anthropic`}
      catalogue={catalogue}
      chapterAnswers={userChapterAnswers(t)}
      guideCountLabel={t("docs.guide.chapters", { n: integrationChapters })}
      guidePagesLabel={t("docs.guide.pages", { n: parametersPages })}
      prevChapterLabel={t("docs.chapter.prev")}
      nextChapterLabel={t("docs.chapter.next")}
      outlineLabel={t("docs.sections")}
      copyPageLabel={t("docs.copyPage")}
      copiedLabel={t("docs.copy.copied")}
      copyFailedLabel={t("docs.copy.failed")}
    />
  );
}
