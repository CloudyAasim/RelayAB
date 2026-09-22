/**
 * src/lib/nav.ts
 *
 * Sidebar / nav highlighting rules.
 */

/**
 * Whether a nav entry should render as the current page.
 *
 * Section roots must match **exactly**. A plain prefix match makes
 * `/dashboard` light up on `/dashboard/docs`, which left the dashboard entry
 * looking permanently selected. Nested entries keep the prefix behaviour so
 * `/dashboard/docs/anything` still highlights `/dashboard/docs`.
 */
export function isNavItemActive(
  pathname: string | null | undefined,
  href: string,
  opts: { exact?: boolean } = {},
): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  if (opts.exact) return false;
  return pathname.startsWith(href + "/");
}
