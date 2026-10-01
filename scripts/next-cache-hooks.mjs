/**
 * scripts/next-cache-hooks.mjs
 *
 * Points `next/cache` at ./next-cache-stub.cjs for one process, so maintenance
 * scripts can drive the repositories without a Next.js request context.
 *
 * Loaded via `tsx --import ./scripts/next-cache-hooks.mjs`.
 *
 * The interception is on `Module._resolveFilename` rather than an ESM
 * `register()` hook because `tsx` compiles this project to CommonJS, and
 * `_resolveFilename` is the only seam that sees those requires. It must run
 * before the data layer is first required, which is what `--import` guarantees.
 *
 * Deliberately not wired into tsconfig paths or vitest.config.ts: the
 * production build must keep resolving the real `next/cache`.
 *
 * @see ./next-cache-stub.cjs
 */
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stubPath = require.resolve("./next-cache-stub.cjs");

const original = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, ...rest) {
  if (request === "next/cache") return stubPath;
  return original.call(this, request, ...rest);
};
