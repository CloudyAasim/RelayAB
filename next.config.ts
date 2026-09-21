import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";

/**
 * Next.js configuration for RelayAB.
 *
 * Notes:
 * - We use @emulators/adapter-next's `withEmulate` wrapper so that the
 *   embedded Vercel REST API emulator (mounted at /api/_emu) can find its
 *   bundled font files when bundled for serverless deployment.
 * - The wrapper only registers a custom `outputFileTracingIncludes` entry.
 *   In production the emulator is NOT actually loaded (see route.ts); the
 *   `withEmulate` call is therefore a no-op at runtime, but keeps us safe
 *   if we ever flip the conditional.
 */
const baseConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  /**
   * Public proxy paths are OpenAI/Anthropic compatible, while the handlers
   * live under /api/*. Rewrites keep the documented client-facing surface
   * (`/v1/chat/completions`, `/v1/models`, `/anthropic/v1/messages`) wired to
   * those handlers without duplicating the route code.
   */
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/anthropic/:path*", destination: "/api/anthropic/:path*" },
    ];
  },
  // Avoid exposing framework hints to upstream APIs
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default withEmulate(baseConfig, { routePrefix: "/api/_emu" });
