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

/**
 * Build worker count, overridable from the environment so the host can tune
 * it without a code change.
 *
 * `Number()` rather than `parseInt()` on purpose: `parseInt("1.5.2")` is `1`,
 * so a mistyped value would quietly become a valid-looking worker count
 * instead of falling back to the default. `Number()` rejects trailing garbage
 * outright, and the guard below turns anything non-integer or non-positive
 * into the safe default instead of handing Next.js `undefined` — which would
 * restore the core-derived worker count this setting exists to cap.
 *
 * @type {number}
 */
const parsedBuildCpus = Number(process.env.NEXT_BUILD_CPUS);
const buildCpus = Number.isInteger(parsedBuildCpus) && parsedBuildCpus > 0 ? parsedBuildCpus : 2;

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
    /**
     * Concurrent build workers.
     *
     * Next.js sizes its static-generation worker pool from the CPU count:
     * `cpus` defaults to `os.cpus().length - 1`, and each worker is a
     * separate Node process that loads the compiled server bundle.
     *
     * Measured on this repository (Next 15.5.25, 22 routes), peak resident
     * memory across the whole build, sampled every 700ms:
     *
     *   workers   peak resident
     *       15    2491.8 MiB
     *        3    1646.8 / 1739.9 MiB   <- what a 4-core host already did
     *        2    1731.1 / 1650.9 MiB
     *        1    1715.4 MiB
     *
     * The cliff is between 15 and 3. Below three the figure is flat — two
     * runs of 2 and two of 3 average within 3 MiB of each other, which is
     * inside the run-to-run spread — so on the current 4-core production host
     * this setting changes nothing measurable. It is here to stop the peak
     * from following the host's core count if the box is ever resized: 15
     * workers cost ~800 MiB more than 3, and the host has 3.8 GiB of RAM with
     * no swap.
     *
     * `NEXT_BUILD_CPUS` lets the host operator override the value without a
     * code change.
     *
     * Note: `experimental.memoryBasedWorkersCount` is deliberately NOT used.
     * It is `Math.max(Math.min(cpus, floor(freemem / 1e9)), 4)` — the `max`
     * enforces a *minimum* of 4 workers, so on a memory-starved box it raises
     * the worker count instead of lowering it.
     */
    cpus: buildCpus,
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
