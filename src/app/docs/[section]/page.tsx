import { notFound } from "next/navigation";
import { PublicDocsFrame } from "@/components/docs/PublicDocsFrame";
import { isUserDocId } from "@/lib/docs/sections";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};

export default async function PublicDocsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isUserDocId(section)) notFound();
  // The document is one page with tabs; the slug only chooses which tab opens,
  // so a link to a chapter is still a link to a chapter. The catalogue is not
  // repeated here — the frame decides it, the same as on the index.
  return <PublicDocsFrame basePath="/docs" section={section} />;
}
