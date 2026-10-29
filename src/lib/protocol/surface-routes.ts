/**
 * src/lib/protocol/surface-routes.ts
 *
 * How one provider answers one client surface — the whole of it, in one place.
 *
 * ## Why this exists
 *
 * A provider row used to answer "which protocol am I" in five columns:
 * `kind`, `upstreamFormat`, `openaiEnabled`, `anthropicEnabled` and
 * `anthropicMode`. Two of them were the same question in two generations of
 * encoding, and the answer was per **face** (two of them) while the clients
 * have four **surfaces**. So a vendor that publishes both `/v1/chat/completions`
 * and `/v1/responses` could not be asked to serve one natively and the other by
 * translation — the row had one dialect for both.
 *
 * This module is the one place that answers it now: **one row per client
 * surface**, each saying one of three things.
 *
 *   - `unsupported` — this provider does not answer this surface.
 *   - `passthrough` — the request goes out in the shape it arrived in.
 *   - `route` — the request goes out in another dialect's shape, rewritten by
 *     the hub (Responses).
 *
 * ## The hub
 *
 * The "通用协议" the operator routes through is Responses: `proxyResponsesViaDialect`
 * is the single place that knows how to reach a given row, and Responses is the
 * shape it knows every row in. So a route to `chat` means "rewrite it into Chat
 * Completions on the way out, and back on the way in".
 *
 * ## Backwards compatibility
 *
 * Rows written before this existed carry no route table, so the routes are
 * **derived** from the old columns — and the derivation reproduces exactly what
 * the proxy used to do, so nothing changes for them. A row that has a table
 * uses the table. The old columns are read, not written; when a row is saved it
 * gets the table, and the old columns stop being the answer.
 */

/** The dialects a vendor's own API can speak. */
export type Dialect = "chat" | "responses" | "anthropic" | "gemini";

import { SURFACES } from "./text-specs";

/** The client surfaces the gateway serves — the one list, shared. */
export type SurfaceId = (typeof SURFACES)[number]["id"];

/**
 * What one surface does with one provider.
 *
 * `passthrough` is kept apart from `route` even though the two differ only in
 * which dialect is named, because the operator's choice is not "which dialect"
 * but "do I translate this one or not" — and a surface routed to its own
 * dialect by way of the hub would be a conversion that does nothing.
 */
export type SurfaceRoute =
  | { kind: "unsupported" }
  | { kind: "passthrough" }
  | { kind: "route"; dialect: Dialect };

/** The three ways a provider can be configured. */
export type ProtocolMode = "simple" | "advanced" | "passthrough";

/**
 * The dialect a surface speaks when it is not translated.
 *
 * The client's own vocabulary: a Chat Completions client sends a Chat body, a
 * Gemini client sends `contents`. Passing that body on untouched is only
 * correct when the upstream speaks the same dialect.
 */
export function ownDialectOf(surface: SurfaceId): Dialect {
  switch (surface) {
    case "openai-chat":
      return "chat";
    case "openai-responses":
      return "responses";
    case "anthropic-messages":
      return "anthropic";
    case "gemini-generate":
      return "gemini";
  }
}

/** The four surfaces, in the order the editor shows them. */
export const ROUTE_SURFACES: readonly SurfaceId[] = SURFACES.map((s) => s.id);

/** The stored shape: a route per surface. */
export type SurfaceRoutes = Record<SurfaceId, SurfaceRoute>;

/** An empty table — every surface unanswered. */
export function emptyRoutes(): SurfaceRoutes {
  const out = {} as SurfaceRoutes;
  for (const surface of ROUTE_SURFACES) out[surface] = { kind: "unsupported" };
  return out;
}

/**
 * The dialect a route ends up speaking, or null when the surface is not served.
 *
 * `passthrough` names the surface's own dialect; `route` names the target.
 */
export function targetDialect(route: SurfaceRoute, surface: SurfaceId): Dialect | null {
  if (route.kind === "unsupported") return null;
  if (route.kind === "passthrough") return ownDialectOf(surface);
  return route.dialect;
}

/**
 * The dialects this provider can be reached in — the vendor's own interfaces.
 *
 * Derived from the routes in simple mode (the operator routes to what the
 * vendor has), and declared in advanced mode (there the upstream is stated
 * once, separately from the downstream, and the routes follow from it).
 */
export function dialectsOf(routes: SurfaceRoutes): Dialect[] {
  const seen: Dialect[] = [];
  for (const surface of ROUTE_SURFACES) {
    const dialect = targetDialect(routes[surface], surface);
    if (dialect && !seen.includes(dialect)) seen.push(dialect);
  }
  return seen;
}

/**
 * The routes a provider row means, whether it says so in a table or in the
 * columns that came before.
 *
 * The derivation is the old behaviour, written as routes:
 *
 *   - the OpenAI face (Chat, Responses and Gemini surfaces) spoke **one**
 *     dialect — the row's — so those three surfaces all go there: their own
 *     dialect when it is that one, and a translation when it is not;
 *   - the Anthropic face was its own thing: the vendor's own endpoint when the
 *     row said `native`, and the OpenAI face's dialect when it said
 *     `translated`;
 *   - a face that was switched off answered nothing.
 */
export function routesFor(
  provider: {
    upstreamFormat?: string | null;
    openaiEnabled?: boolean | null;
    anthropicEnabled?: boolean | null;
    anthropicMode?: string | null;
    kind?: string | null;
  },
  routes?: readonly string[] | null,
): SurfaceRoutes {
  const stored = parseRoutes(routes);
  if (stored) return stored;

  const dialect = legacyDialect(provider);
  /**
   * The faces a row without the flags had.
   *
   * The same rule `defaultFaceFlags` has always used: an Anthropic row is
   * Anthropic-only, and everything else is OpenAI-only. A row that has the
   * flags says so itself, and the flags win.
   */
  const anthropicByDefault =
    provider.kind === "anthropic" || provider.upstreamFormat === "anthropic";
  const openaiOn = provider.openaiEnabled ?? !anthropicByDefault;
  const anthropicOn = provider.anthropicEnabled ?? anthropicByDefault;

  const out = emptyRoutes();
  if (openaiOn && dialect) {
    /**
     * The Chat surface always posts a Chat Completions body, so a Responses row
     * is reached on its **chat** endpoint — which is what the proxy has always
     * done with such a row, and what keeps working today. The route table is
     * where an operator says otherwise ("route this one to `/v1/responses`"),
     * and until they do, the old behaviour is the right one.
     */
    const chatTarget: Dialect = dialect === "responses" ? "chat" : dialect;
    out["openai-chat"] =
      chatTarget === "chat" ? { kind: "passthrough" } : { kind: "route", dialect: chatTarget };
    // The Gemini surface went through the hub even when the row spoke Gemini:
    // the client's `contents` were rewritten into Responses and back. The
    // derivation keeps that, because it is what the proxy did.
    out["gemini-generate"] = { kind: "route", dialect };
    out["openai-responses"] =
      dialect === "responses" ? { kind: "passthrough" } : { kind: "route", dialect };
  }
  if (anthropicOn) {
    out["anthropic-messages"] =
      provider.anthropicMode === "translated"
        ? dialect
          ? { kind: "route", dialect }
          : { kind: "unsupported" }
        : { kind: "passthrough" };
  }
  return out;
}

/**
 * The dialect the old columns name.
 *
 * `kind: "anthropic"` and `upstreamFormat: "anthropic"` are two spellings of
 * the same fact, and both are still in the wild. **`kind` wins**, because that
 * is the order `providerFaces` has always read them in: a row typed Anthropic
 * speaks Anthropic, whatever its format column says.
 */
function legacyDialect(provider: {
  upstreamFormat?: string | null;
  kind?: string | null;
}): Dialect | null {
  if (provider.kind === "anthropic") return "anthropic";
  const format = provider.upstreamFormat;
  if (format === "chat" || format === "responses" || format === "anthropic" || format === "gemini") {
    return format;
  }
  return null;
}

/**
 * Read a stored route table.
 *
 * A malformed table is **ignored** rather than half-applied: the row also
 * carries the columns that came before it, and a broken table must not take a
 * working provider offline. The editor is where a broken table is reported.
 */
export function parseRoutes(raws: readonly string[] | null | undefined): SurfaceRoutes | null {
  if (!raws || raws.length === 0) return null;
  const out = emptyRoutes();
  let found = false;
  for (const raw of raws) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as { surface?: unknown; kind?: unknown; dialect?: unknown };
    if (typeof entry.surface !== "string") continue;
    if (!(ROUTE_SURFACES as readonly string[]).includes(entry.surface)) continue;
    const surface = entry.surface as SurfaceId;
    if (entry.kind === "unsupported") {
      out[surface] = { kind: "unsupported" };
      found = true;
    } else if (entry.kind === "passthrough") {
      out[surface] = { kind: "passthrough" };
      found = true;
    } else if (entry.kind === "route" && isDialect(entry.dialect)) {
      out[surface] = { kind: "route", dialect: entry.dialect };
      found = true;
    }
  }
  return found ? out : null;
}

function isDialect(value: unknown): value is Dialect {
  return value === "chat" || value === "responses" || value === "anthropic" || value === "gemini";
}

/** The stored form of a route table: one JSON string per surface that is served. */
export function serializeRoutes(routes: SurfaceRoutes): string[] {
  const out: string[] = [];
  for (const surface of ROUTE_SURFACES) {
    const route = routes[surface];
    if (!route || route.kind === "unsupported") continue;
    out.push(JSON.stringify(route.kind === "route" ? { surface, ...route } : { surface, kind: route.kind }));
  }
  return out;
}

/**
 * The routes of a provider in passthrough mode: every surface answered in its
 * own vocabulary.
 *
 * The vendor has to speak all four for this to be honest, which is exactly
 * what the mode says: nothing is translated, so a vendor that speaks two of
 * them cannot be in this mode.
 */
export function passthroughRoutes(): SurfaceRoutes {
  const out = emptyRoutes();
  for (const surface of ROUTE_SURFACES) out[surface] = { kind: "passthrough" };
  return out;
}

/**
 * The routes an advanced-mode provider means, given the dialects its vendor
 * speaks.
 *
 * A surface is served natively when the vendor speaks that dialect, and by
 * translation to the first declared dialect when it does not. That is the whole
 * of "只要支持这四种协议的其中一种就可以正常连接": one declaration, and every
 * surface finds a way through.
 */
export function advancedRoutes(dialects: readonly Dialect[]): SurfaceRoutes {
  const out = emptyRoutes();
  if (dialects.length === 0) return out;
  for (const surface of ROUTE_SURFACES) {
    const own = ownDialectOf(surface);
    if (dialects.includes(own)) {
      out[surface] = { kind: "passthrough" };
    } else {
      out[surface] = { kind: "route", dialect: dialects[0] };
    }
  }
  return out;
}

/**
 * The routes a provider means, whichever way it says so.
 *
 * The precedence is the whole of the three modes:
 *
 *   - **passthrough** — nothing is translated, so every surface is answered in
 *     its own vocabulary;
 *   - **advanced** — the upstream is declared apart from the downstream, and
 *     the routes follow from that declaration;
 *   - **simple** — the route table decides, and a row without one is read from
 *     the columns that came before it.
 *
 * A stored table beats the declaration, because it is the more specific
 * statement: an operator who wrote one row by hand meant that row.
 */
export function routesOf(provider: {
  protocolMode?: string | null;
  surfaceRoutes?: readonly string[] | null;
  upstreamDialects?: readonly string[] | null;
  upstreamFormat?: string | null;
  openaiEnabled?: boolean | null;
  anthropicEnabled?: boolean | null;
  anthropicMode?: string | null;
  kind?: string | null;
}): SurfaceRoutes {
  const stored = parseRoutes(provider.surfaceRoutes);
  if (stored) return stored;
  if (provider.protocolMode === "passthrough") return passthroughRoutes();
  if (provider.protocolMode === "advanced") {
    const dialects = (provider.upstreamDialects ?? []).filter(isDialect);
    return advancedRoutes(dialects);
  }
  return routesFor(provider, null);
}

/**
 * Whether a provider answers a surface at all.
 *
 * The candidate filter the surfaces use: a provider that does not serve this
 * surface is not a candidate for it, whatever the model mapping says.
 */
export function servesSurface(
  provider: Parameters<typeof routesOf>[0],
  surface: SurfaceId,
): boolean {
  return routesOf(provider)[surface].kind !== "unsupported";
}

/** The dialect a provider answers a surface in, or null when it does not. */
export function dialectForSurface(
  provider: Parameters<typeof routesOf>[0],
  surface: SurfaceId,
): Dialect | null {
  return targetDialect(routesOf(provider)[surface], surface);
}
