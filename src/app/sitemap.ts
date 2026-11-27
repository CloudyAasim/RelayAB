import type { MetadataRoute } from "next";
import { resolvePublicUrl } from "@/lib/public-url";
import { USER_SECTION_ID_LIST } from "@/lib/docs/sections";

/**
 * Dynamic for the same reason as robots.ts: absolute URLs need the request's
 * public origin, which does not exist during a build-time prerender.
 */
export const dynamic = "force-dynamic";

/**
 * `parameters` is a reference chapter for operators wiring up their own
 * deployment, not a landing page someone searches for; leaving it out keeps
 * the sitemap to pages that stand on their own.
 */
const EXCLUDED_DOC_SECTIONS = new Set(["parameters"]);

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let origin = "";
  try {
    origin = await resolvePublicUrl();
  } catch {
    origin = "";
  }
  if (!origin) return [];

  const url = (path: string) => `${origin}${path}`;

  return [
    { url: url("/"), changeFrequency: "weekly", priority: 1 },
    { url: url("/docs"), changeFrequency: "weekly", priority: 0.8 },
    { url: url("/login"), changeFrequency: "monthly", priority: 0.3 },
    { url: url("/license"), changeFrequency: "yearly", priority: 0.2 },
    ...USER_SECTION_ID_LIST.filter((id) => !EXCLUDED_DOC_SECTIONS.has(id)).map(
      (id) => ({
        url: url(`/docs/${id}`),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      }),
    ),
  ];
}
