/**
 * Public documentation page — no login.
 *
 * The three documentation surfaces (public / user / admin) share one renderer;
 * this is the unauthenticated entry point to it. The index and every chapter
 * are the same component, so there is nothing here that can differ from
 * `/docs/<chapter>`.
 */
import { PublicDocsFrame } from "@/components/docs/PublicDocsFrame";
import { USER_DOC_DEFAULT } from "@/lib/docs/sections";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};
export const dynamic = "force-dynamic";

export default async function PublicDocsPage() {
  return <PublicDocsFrame basePath="/docs" section={USER_DOC_DEFAULT} />;
}
