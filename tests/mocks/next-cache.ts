/**
 * Stand-in for `next/cache` in the Vitest run.
 *
 * `revalidateTag()` throws
 *   "Invariant: static generation store missing in revalidateTag"
 * when it is called outside a Next.js request context — which is exactly the
 * situation in unit tests. The provider repository calls it after every write
 * (`src/lib/db/providers.ts`), so without this stub every test that creates or
 * updates a provider dies before it reaches the code under test.
 *
 * Wired up via `resolve.alias` in `vitest.config.ts`. The production build
 * still resolves the real `next/cache`.
 */

export function revalidateTag(): void {}

export function revalidatePath(): void {}

export function unstable_noStore(): void {}

export function unstable_cache<T>(fn: T): T {
  return fn;
}
