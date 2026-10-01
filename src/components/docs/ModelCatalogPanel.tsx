"use client";

/**
 * src/components/docs/ModelCatalogPanel.tsx
 *
 * The public-facing wrapper around the catalogue.
 *
 * Same component the signed-in docs page uses — the data is identical and
 * comes from the same builder, so a model cannot appear on one surface and
 * not the other. It lives in `components/docs` because two routes render it
 * and a component under a route group is not a sensible home for that.
 */
import { ModelCatalog } from "./ModelCatalog";
import type { CatalogModel } from "@/lib/docs/catalog";

interface Props {
  models: CatalogModel[];
  providers: Array<{ name: string; enabled: boolean; modelCount: number }>;
  site: { name: string; description: string; announcement: string; supportContact: string };
  publicUrl: string;
}

export function ModelCatalogPanel(props: Props) {
  return <ModelCatalog {...props} />;
}
