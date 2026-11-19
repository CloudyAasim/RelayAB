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
import type { PublicAnnouncement } from "@/lib/announcements/types";

interface Props {
  models: CatalogModel[];
  providers: Array<{ name: string; enabled: boolean; modelCount: number }>;
  site: { name: string; description: string; supportContact: string };
  publicUrl: string;
  announcement?: PublicAnnouncement | null;
}

export function ModelCatalogPanel(props: Props) {
  return <ModelCatalog {...props} />;
}
