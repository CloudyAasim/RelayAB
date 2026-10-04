import { notFound } from "next/navigation";
import { PublicDocsFrame } from "@/components/docs/PublicDocsFrame";
import { isUserDocId } from "@/lib/docs/sections";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};

export default async function PublicDocsSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ p?: string | string[] }>;
}) {
  const { section } = await params;
  const sp = await searchParams;
  // The parameters guide pages within itself, so the page on screen travels in
  // the query: `/docs/parameters?p=voices-korean`. Read on the server so a deep
  // link opens that page rather than page one and then jumping to it.
  const page = Array.isArray(sp.p) ? sp.p[0] : sp.p;
  if (!isUserDocId(section)) notFound();
  // The document is one page with tabs; the slug only chooses which guide opens,
  // so a link to a chapter is still a link to a chapter. The catalogue is not
  // repeated here — the frame decides it, the same as on the index.
  return <PublicDocsFrame basePath="/docs" section={section} initialPage={page ?? null} />;
}
