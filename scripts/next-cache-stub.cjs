/**
 * scripts/next-cache-stub.cjs
 *
 * No-op stand-in for `next/cache` when the data layer is driven outside a
 * Next.js request.
 *
 * `unstable_cache` and `revalidateTag` both assert on internal Next state that
 * only exists during a request and throw "Invariant: ... missing" otherwise.
 * The provider repository calls them on every read and write, so a maintenance
 * script run through `tsx` dies immediately. The Vitest suite solves the same
 * problem with a `resolve.alias`; a standalone script needs a require hook
 * instead, because putting this in tsconfig paths would also replace the real
 * module inside the Next build.
 *
 * CommonJS because `tsx` compiles the project to CJS, and because the
 * interception happens in `_resolveFilename`, which only sees CJS requires.
 *
 * @see ./next-cache-hooks.mjs
 */

exports.revalidateTag = function revalidateTag() {};
exports.revalidatePath = function revalidatePath() {};
exports.unstable_noStore = function unstable_noStore() {};

/**
 * `unstable_cache(fn)` degrades to calling `fn` directly.
 *
 * A maintenance script always wants fresh data — which is exactly what the
 * cache would have returned immediately after a write anyway.
 */
exports.unstable_cache = function unstable_cache(fn) {
  return fn;
};
