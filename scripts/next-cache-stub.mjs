/**
 * scripts/next-cache-stub.mjs
 *
 * No-op stand-in for `next/cache` when the data layer is driven outside a
 * Next.js request.
 *
 * `unstable_cache` and `revalidateTag` both assert on internal Next state that
 * only exists during a request, and throw "Invariant: … missing" otherwise. The
 * provider repository calls them on every read and write, so a maintenance
 * script run through `tsx` on the box dies immediately. The Vitest suite
 * solves the same problem with a `resolve.alias`; a standalone script needs a
 * resolver hook instead, because putting it in tsconfig paths would also
 * replace the real module inside the Next build.
 */

export function revalidateTag() {}
export function revalidatePath() {}
export function unstable_noStore() {}

/**
 * `unstable_cache(fn)` degrades to calling `fn` directly: a maintenance script
 * always wants fresh data, which is exactly what the cache would have returned
 * right after a write anyway.
 */
export function unstable_cache(fn, _key, _opts) {
  return fn;
}
