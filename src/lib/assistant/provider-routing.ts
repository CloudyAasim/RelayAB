/**
 * src/lib/assistant/provider-routing.ts
 *
 * A provider's routing, in the shape both the assistant and the administrator
 * read it.
 *
 * The route table is four rows of "not served / as it arrived / rewritten into
 * X" — one row per client interface. The columns that came before the table
 * are its summary, and a summary is a poor thing to read a routing from: the
 * assistant could change one of them and never learn which interface it moved.
 *
 * So both sides read the table itself.
 */
import { SURFACES } from "@/lib/protocol/text-specs";
import {
  resolveRoutes,
  routesOf,
  type SurfaceRoutes,
} from "@/lib/protocol/surface-routes";
import type { Provider } from "@/lib/db/types";

/** One client interface, and what happens to a request that arrives there. */
export interface DescribedRoute {
  /** The client endpoint this row answers. */
  endpoint: string;
  /**
   * What the provider does with it.
   *
   * `unsupported` — it does not answer it. `passthrough` — it answers it as
   * the request arrived. `route` — the gateway rewrites the request into
   * `dialect` and the answer back.
   */
  answer: "unsupported" | "passthrough" | "route";
  /** The dialect the request is rewritten into, when it is rewritten. */
  dialect: string | null;
}

/** The route table, one entry per client interface. */
export function describeRoutes(routes: SurfaceRoutes): DescribedRoute[] {
  return SURFACES.map((surface) => {
    const route = routes[surface.id];
    if (route.kind === "unsupported") {
      return { endpoint: surface.clientPath, answer: "unsupported", dialect: null };
    }
    if (route.kind === "passthrough") {
      return { endpoint: surface.clientPath, answer: "passthrough", dialect: null };
    }
    return { endpoint: surface.clientPath, answer: "route", dialect: route.dialect };
  });
}

/**
 * The routing a patch would leave behind.
 *
 * The same resolution the write boundary does, so the approval screen shows
 * the routing the change actually produces — not the column it happened to
 * touch. Null when the patch says nothing about the routing.
 */
export function routesAfterPatch(
  provider: Provider,
  patch: Record<string, unknown>,
): SurfaceRoutes | null {
  const legacyPatched =
    patch.upstreamFormat !== undefined ||
    patch.openaiEnabled !== undefined ||
    patch.anthropicEnabled !== undefined ||
    patch.anthropicMode !== undefined;
  if (
    patch.surfaceRoutes === undefined &&
    patch.protocolMode === undefined &&
    patch.upstreamDialects === undefined &&
    !legacyPatched
  ) {
    return null;
  }
  return resolveRoutes({
    routes: patch.surfaceRoutes as string[] | undefined,
    protocolMode: patch.protocolMode as string | undefined,
    upstreamDialects: patch.upstreamDialects as string[] | undefined,
    legacy: legacyPatched
      ? {
          upstreamFormat: (patch.upstreamFormat as string) ?? provider.upstreamFormat,
          openaiEnabled: (patch.openaiEnabled as boolean) ?? provider.openaiEnabled,
          anthropicEnabled: (patch.anthropicEnabled as boolean) ?? provider.anthropicEnabled,
          anthropicMode:
            (patch.anthropicMode as "native" | "translated") ?? provider.anthropicMode,
          kind: provider.kind,
        }
      : null,
  });
}

/** The row's current routing. */
export function routesOfProvider(provider: Provider): SurfaceRoutes {
  return routesOf(provider);
}
