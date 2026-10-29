/**
 * tests/unit/surface-routes.test.ts
 *
 * How a provider answers a client surface — the whole of it.
 *
 * A provider row used to answer "which protocol am I" in five columns, two of
 * them the same question in two generations of encoding, and the answer was per
 * **face** (two) while the clients have four **surfaces**. So a vendor that
 * publishes both `/v1/chat/completions` and `/v1/responses` could not be asked
 * to serve one natively and the other by translation.
 *
 * Now: one row per surface, each saying one of three things — not answered,
 * passed through as it arrived, or routed to a dialect through the hub.
 *
 * The rules pinned here:
 *
 *   1. **A row written before the table keeps behaving exactly as it did.**
 *      The derivation is the old behaviour written as routes, and it is the
 *      safety net for the whole migration: adding a column must not change
 *      anyone's traffic.
 *   2. **A stored table wins** over the columns that came before it.
 *   3. **A broken table is ignored** rather than half-applied — the row also
 *      carries the old columns, and one malformed entry must not take a
 *      working provider offline.
 *   4. **Passthrough mode** answers every surface in its own vocabulary.
 *   5. **Advanced mode** derives the routes from the upstream's declaration:
 *      a surface the vendor speaks natively is passed through, and one it does
 *      not is routed to the first dialect it does speak.
 */
import { describe, it, expect } from "vitest";
import {
  advancedRoutes,
  dialectsOf,
  ownDialectOf,
  parseRoutes,
  passthroughRoutes,
  routesFor,
  routesOf,
  serializeRoutes,
  servesSurface,
  targetDialect,
  type Dialect,
  type SurfaceId,
} from "@/lib/protocol/surface-routes";

/** A row as the old columns described it. */
function legacy(over: {
  upstreamFormat?: string;
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicMode?: string;
  kind?: string;
}) {
  return {
    upstreamFormat: over.upstreamFormat ?? "responses",
    openaiEnabled: over.openaiEnabled ?? true,
    anthropicEnabled: over.anthropicEnabled ?? false,
    anthropicMode: over.anthropicMode ?? "native",
    kind: over.kind ?? "openai",
  };
}

/** The dialect each surface ends up in, in the order the surfaces are listed. */
function targets(routes: ReturnType<typeof routesFor>): (Dialect | null)[] {
  return (["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"] as SurfaceId[]).map(
    (surface) => targetDialect(routes[surface], surface),
  );
}

describe("a row written before the route table behaves as it always did", () => {
  it("a Chat Completions upstream", () => {
    // The Chat surface posted a Chat body to `/chat/completions`; the Responses
    // surface went through the hub; the Gemini surface went through the hub;
    // the Anthropic face was off.
    expect(targets(routesFor(legacy({ upstreamFormat: "chat" })))).toEqual([
      "chat",
      "chat",
      null,
      "chat",
    ]);
  });

  it("a Responses upstream", () => {
    // The Chat surface posted a Chat body to `/chat/completions` — the Chat
    // face has always posted a Chat body, whatever the row's dialect — and the
    // Responses surface was served natively.
    expect(targets(routesFor(legacy({ upstreamFormat: "responses" })))).toEqual([
      "chat",
      "responses",
      null,
      "responses",
    ]);
  });

  it("an Anthropic upstream", () => {
    expect(targets(routesFor(legacy({ upstreamFormat: "anthropic" })))).toEqual([
      "anthropic",
      "anthropic",
      null,
      "anthropic",
    ]);
  });

  it("a Gemini upstream", () => {
    expect(targets(routesFor(legacy({ upstreamFormat: "gemini" })))).toEqual([
      "gemini",
      "gemini",
      null,
      "gemini",
    ]);
  });

  it("with the Anthropic face on, in both of its shapes", () => {
    // `native` — the vendor's own `/v1/messages`. `translated` — the gateway
    // rewrites it into the dialect the OpenAI face speaks.
    //
    // The Chat surface of a Responses row posts a Chat body to
    // `/chat/completions` — that is what the Chat face has always done, and it
    // is why the first entry is `chat` and not `responses`.
    expect(targets(routesFor(legacy({ anthropicEnabled: true })))).toEqual([
      "chat",
      "responses",
      "anthropic",
      "responses",
    ]);
    expect(
      targets(routesFor(legacy({ upstreamFormat: "chat", anthropicEnabled: true, anthropicMode: "translated" }))),
    ).toEqual(["chat", "chat", "chat", "chat"]);
  });

  it("and a row whose kind says Anthropic, whatever its format column says", () => {
    // `kind` is the vendor type and it wins: a row typed Anthropic speaks
    // Anthropic.
    expect(
      targets(routesFor(legacy({ upstreamFormat: "responses", kind: "anthropic" }))),
    ).toEqual(["anthropic", "anthropic", null, "anthropic"]);
  });

  it("with both faces off, nothing is answered", () => {
    expect(
      targets(routesFor(legacy({ openaiEnabled: false, anthropicEnabled: false }))),
    ).toEqual([null, null, null, null]);
  });
});

describe("a stored table is the answer", () => {
  const table = serializeRoutes({
    "openai-chat": { kind: "passthrough" },
    "openai-responses": { kind: "route", dialect: "chat" },
    "anthropic-messages": { kind: "unsupported" },
    "gemini-generate": { kind: "route", dialect: "responses" },
  });

  it("and it beats the columns that came before it", () => {
    const routes = routesOf({
      ...legacy({ upstreamFormat: "anthropic" }),
      surfaceRoutes: table,
    });
    expect(targets(routes)).toEqual(["chat", "chat", null, "responses"]);
  });

  it("and a broken entry is ignored rather than half-applied", () => {
    // The row also carries the old columns, and one malformed entry must not
    // take a working provider offline: the malformed one is dropped and the
    // good one still counts.
    //
    // A surface the table does not mention is **not answered** — that is the
    // rule the editor writes to: a blank row means "this provider does not
    // answer this surface".
    const routes = routesOf({
      ...legacy({ upstreamFormat: "chat" }),
      surfaceRoutes: ["{not json", JSON.stringify({ surface: "openai-chat", kind: "route", dialect: "chat" })],
    });
    expect(targets(routes)).toEqual(["chat", null, null, null]);
    expect(
      servesSurface({ ...legacy({ upstreamFormat: "chat" }), surfaceRoutes: ["{not json"] }, "openai-chat"),
    ).toBe(true);
  });

  it("and a table that says nothing usable leaves the row as it was", () => {
    const routes = routesOf({
      ...legacy({ upstreamFormat: "chat" }),
      surfaceRoutes: ["{not json", JSON.stringify({ surface: "nowhere", kind: "route" })],
    });
    expect(targets(routes)).toEqual(["chat", "chat", null, "chat"]);
  });

  it("and a row that says one surface is answered says only that one", () => {
    const routes = parseRoutes([
      JSON.stringify({ surface: "openai-chat", kind: "passthrough" }),
    ]);
    expect(routes).not.toBeNull();
    expect(targets(routes!)).toEqual(["chat", null, null, null]);
  });
});

describe("the two modes that replace the old half-and-half", () => {
  it("passthrough answers every surface in its own vocabulary", () => {
    const routes = routesOf({ protocolMode: "passthrough" });
    expect(targets(routes)).toEqual(["chat", "responses", "anthropic", "gemini"]);
    // And the dialects are the four the vendor would have to speak.
    expect(dialectsOf(routes).sort()).toEqual(["anthropic", "chat", "gemini", "responses"]);
  });

  it("advanced derives the routes from the upstream's own declaration", () => {
    // A vendor that speaks chat and responses: each of those surfaces is
    // served natively, and the two it does not speak are routed to the first
    // dialect it does.
    const routes = routesOf({
      protocolMode: "advanced",
      upstreamDialects: ["chat", "responses"],
    });
    expect(targets(routes)).toEqual(["chat", "responses", "chat", "chat"]);
  });

  it("and one dialect is enough for the vendor to be reachable", () => {
    const routes = routesOf({ protocolMode: "advanced", upstreamDialects: ["gemini"] });
    expect(targets(routes)).toEqual(["gemini", "gemini", "gemini", "gemini"]);
    expect(dialectsOf(routes)).toEqual(["gemini"]);
  });

  it("and the advanced routes are the ones the declaration implies", () => {
    expect(targets(advancedRoutes(["anthropic"]))).toEqual([
      "anthropic",
      "anthropic",
      "anthropic",
      "anthropic",
    ]);
    // No dialect at all: the vendor speaks nothing the gateway can reach, so
    // nothing is answered — which is a fact about the declaration, not a
    // default.
    expect(targets(advancedRoutes([]))).toEqual([null, null, null, null]);
  });
});

describe("the shape of the thing itself", () => {
  it("a surface's own dialect is the one it speaks", () => {
    expect(ownDialectOf("openai-chat")).toBe("chat");
    expect(ownDialectOf("openai-responses")).toBe("responses");
    expect(ownDialectOf("anthropic-messages")).toBe("anthropic");
    expect(ownDialectOf("gemini-generate")).toBe("gemini");
  });

  it("and a table round-trips", () => {
    const routes = passthroughRoutes();
    expect(targets(parseRoutes(serializeRoutes(routes))!)).toEqual(targets(routes));
  });
});
