import type { MetadataRoute } from "next";
import { resolvePublicUrl } from "@/lib/public-url";

/**
 * Dynamic because the sitemap URL is resolved from the request/config, not
 * baked at build time — a build-time prerender has no headers and would freeze
 * `http://localhost:3000` into the shipped file.
 */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  let origin = "";
  try {
    origin = await resolvePublicUrl();
  } catch {
    origin = "";
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The console, the API surface and the proxy endpoint are per-user or
        // machine-facing; indexing them only produces login walls in results.
        disallow: ["/admin", "/dashboard", "/api/", "/v1/"],
      },
    ],
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
