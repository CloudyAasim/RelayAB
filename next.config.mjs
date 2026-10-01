/**
 * Next.js configuration for RelayAB.
 *
 * This file is `.mjs` rather than `.ts` on purpose.
 *
 * Next.js loads `next.config.*` on every start, and a TypeScript config has to
 * be compiled on the fly — which needs the `typescript` package present. On a
 * container image built with devDependencies pruned (the herokuish/Dokku
 * buildpack does exactly that) `next start` finds no TypeScript, tries to
 * install it, and the install re-resolves pnpm's store against a different
 * path than the one the build used:
 *
 *   ERR_PNPM_UNEXPECTED_STORE  The dependencies at "/app/node_modules" are
 *   currently linked from the store at "/tmp/pnpmcache.XXX/v10". pnpm now
 *   wants to use the store at "/app/.local/share/pnpm/store/v10"
 *
 * A plain `.mjs` config needs no compiler, so the runtime never reaches for
 * one and the failure mode cannot occur.
 *
 * Self-hosted deployment (Debian + systemd + nginx): the app is started with
 * `next start` from a full checkout of the repository. Note that two admin doc
 * pages read files straight off disk at request time — see
 * `components/docs/ProtocolReference.tsx` and
 * `components/docs/SpecCheckReference.tsx`, which both resolve paths from
 * `process.cwd()`. A trimmed deployment or an `output: "standalone"` image
 * would leave those pages unable to read their source.
 *
 * @type {import("next").NextConfig}
 */
const baseConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * `node:sqlite` is a Node builtin (>= 22.5), but the webpack bundled with
   * this Next.js major predates it and tries to resolve it from npm, which
   * fails the production build. Externalising the specifier hands it to
   * Node's own resolver untouched. The same exclusion is declared in
   * vitest.config.ts for the test runner.
   *
   * @type {(config: import("webpack").Configuration, ctx: { isServer: boolean }) => import("webpack").Configuration}
   */
  webpack: (config, { isServer }) => {
    if (isServer) {
      const current = config.externals;
      const list = Array.isArray(current)
        ? current
        : typeof current === "function"
          ? [current]
          : [];
      config.externals = [...list, "node:sqlite"];
    }
    return config;
  },

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    /**
     * Client Router Cache lifetimes (seconds).
     *
     * Next.js defaults `dynamic` to 0, which means every client-side
     * navigation to one of these (cookie-gated, therefore dynamic) pages
     * throws away the RSC payload and re-hits the server again — including for
     * links the router already prefetched. A short window makes going
     * back/forward and hopping between the sidebar entries instant.
     *
     * Server Actions still invalidate the cache, so a create/rename/delete is
     * visible immediately; the window only covers reads.
     */
    staleTimes: {
      dynamic: 30,
      static: 180,
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

  /**
   * Avoid exposing framework hints to upstream APIs, and add the baseline
   * security headers applied to every response.
   *
   * Deliberately conservative:
   * - The CSP only pins `frame-ancestors` / `base-uri` / `object-src`. It does
   *   NOT define `default-src` / `script-src`, so it cannot break Next.js'
   *   inline bootstrap, while still blocking clickjacking, `<base>` hijacking
   *   and plugin/PDF embedding.
   * - HSTS is only emitted in production. Over plain HTTP a browser ignores it
   *   anyway, and we do not want a local test host pinned in a browser profile.
   */
  async headers() {
    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Content-Security-Policy",
        value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), payment=()",
      },
    ];
    if (process.env.NODE_ENV === "production") {
      securityHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000",
      });
    }
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default baseConfig;
