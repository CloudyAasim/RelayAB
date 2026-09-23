/**
 * Lazy boundary — wraps dynamic-imported components with a skeleton placeholder.
 *
 *   const HeavyEditor = lazyLoad(
 *     () => import("./HeavyEditor"),
 *     (mod) => mod.HeavyEditor
 *   );
 */
"use client";

import * as React from "react";

/**
 * Generic lazy loader. `loader` returns a module object; `resolve` picks
 * the export to use as the component.
 */
export function lazyLoad<P extends Record<string, unknown>>(
  loader: () => Promise<P>,
  resolve: (mod: P) => React.ComponentType<any>,
): React.LazyExoticComponent<React.ComponentType<any>> {
  return React.lazy(async () => {
    try {
      const mod = await loader();
      const Component = resolve(mod);
      return { default: Component as React.ComponentType<any> };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[lazyLoad] failed to load module:", err);
      const Broken: React.FC = () => null;
      return { default: Broken };
    }
  });
}
