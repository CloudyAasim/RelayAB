/**
 * next.config.d.mts
 *
 * Type declaration for next.config.mjs.
 *
 * The config is deliberately plain JavaScript with no compiler in the loop --
 * see the header of next.config.mjs for why a buildpack that prunes
 * devDependencies must still be able to load it. That makes it invisible to
 * `tsc`, which has `allowJs: false`, so anything importing it fails with
 * TS7016.
 *
 * The one importer is tests/unit/next-config-build-cpus.test.ts, which needs to
 * re-evaluate the module under different NEXT_BUILD_CPUS values. Rather than
 * turn `allowJs` on for the whole project -- which would pull every stray `.js`
 * into the type-check and quietly change what the build verifies -- this
 * declares just the surface that is used.
 */
import type { NextConfig } from "next";

declare const config: NextConfig;

export default config;
