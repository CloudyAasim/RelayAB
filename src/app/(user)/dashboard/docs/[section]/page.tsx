import { redirect } from "next/navigation";
import { UserDocsScreen } from "../UserDocsScreen";
import { USER_DOC_DEFAULT, isUserDocId } from "@/lib/docs/sections";

export const metadata = { title: { absolute: "接入文档 - RelayAB" } };
export const dynamic = "force-dynamic";

export default async function DocsSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ p?: string | string[] }>;
}) {
  const { section } = await params;
  // The parameters guide pages within itself, so the page on screen travels in
  // the query: `/dashboard/docs/parameters?p=voices-korean`. Read here rather
  // than in the client component, because the first paint would otherwise open
  // page one and then jump — a deep link to a page is a link to a page.
  const sp = await searchParams;
  const page = Array.isArray(sp.p) ? sp.p[0] : sp.p;
  // Streams (the dashboard has a loading boundary), so a thrown notFound()
  // would produce a soft 404. Send stale/typo'd slugs back to the index.
  if (!isUserDocId(section)) redirect(`/dashboard/docs/${USER_DOC_DEFAULT}`);
  // Same screen as the index; the slug only chooses the guide that opens.
  return (
    <UserDocsScreen basePath="/dashboard/docs" section={section} initialPage={page ?? null} />
  );
}
