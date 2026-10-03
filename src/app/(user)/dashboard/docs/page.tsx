import { UserDocsScreen } from "./UserDocsScreen";
import { USER_DOC_DEFAULT } from "@/lib/docs/sections";

export const metadata = { title: { absolute: "接入文档 - RelayAB" } };
export const dynamic = "force-dynamic";

export default async function DocsPage() {
  return <UserDocsScreen basePath="/dashboard/docs" section={USER_DOC_DEFAULT} />;
}
