import { redirect } from "next/navigation";
import { UserDocsScreen } from "../UserDocsScreen";
import { USER_DOC_DEFAULT, isUserDocId } from "@/lib/docs/sections";

export const metadata = { title: { absolute: "接入文档 - RelayAB" } };
export const dynamic = "force-dynamic";

export default async function DocsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  // Streams (the dashboard has a loading boundary), so a thrown notFound()
  // would produce a soft 404. Send stale/typo'd slugs back to the index.
  if (!isUserDocId(section)) redirect(`/dashboard/docs/${USER_DOC_DEFAULT}`);
  // Same screen as the index; the slug only chooses the tab that opens.
  return <UserDocsScreen basePath="/dashboard/docs" section={section} />;
}
