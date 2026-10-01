/**
 * Public documentation page — no login.
 *
 * The three documentation surfaces (public / user / admin) share one outline
 * and one renderer; this is the unauthenticated entry point to it. What it adds
 * is the live model catalogue, and only when the operator has switched that on:
 * a relay that publishes its catalogue is normal and the public docs are where
 * someone evaluating it looks first, but a private self-hosted relay may not
 * want its vendor list readable by anyone. That call belongs to the operator,
 * so it is a setting rather than a default.
 */
import { PublicDocsFrame } from "@/components/docs/PublicDocsFrame";
import { USER_DOC_DEFAULT } from "@/lib/docs/sections";
import { getSettings } from "@/lib/db/settings";
import { buildModelCatalog } from "@/lib/docs/catalog";
import { resolvePublicUrl } from "@/lib/public-url";
import { ModelCatalogPanel } from "@/components/docs/ModelCatalogPanel";

export const metadata = {
  title: { absolute: "接入文档 - RelayAB" },
};
export const dynamic = "force-dynamic";

export default async function PublicDocsPage() {
  const settings = await getSettings();

  if (settings.publicCatalog !== true) {
    return <PublicDocsFrame basePath="/docs" section={USER_DOC_DEFAULT} />;
  }

  const [catalog, publicUrl] = await Promise.all([buildModelCatalog(), resolvePublicUrl()]);

  return (
    <div className="space-y-6">
      <ModelCatalogPanel
        models={catalog.models}
        providers={catalog.providers}
        site={catalog.site}
        publicUrl={publicUrl}
      />
      <PublicDocsFrame basePath="/docs" section={USER_DOC_DEFAULT} />
    </div>
  );
}
