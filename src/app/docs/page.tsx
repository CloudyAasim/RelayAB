/**
 * Public documentation page - accessible without login.
 */
import { PublicDocsFrame } from "@/components/docs/PublicDocsFrame";
import { USER_DOC_DEFAULT } from "@/lib/docs/sections";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};

export default function PublicDocsPage() {
  return <PublicDocsFrame basePath="/docs" section={USER_DOC_DEFAULT} />;
}
