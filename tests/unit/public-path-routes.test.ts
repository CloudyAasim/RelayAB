/**
 * `next.config.ts` rewrites `/v1/:path*` to `/api/v1/:path*`, but Next only
 * applies a rewrite when no file-system route matches first. A hand-written
 * `src/app/v1/**` route therefore SHADOWS the rewrite — which is how
 * `/v1/chat/completions` ended up served by a stale copy that predated
 * streaming support and returned 500 on `stream: true`.
 *
 * These invariants keep the public paths wired to the same handlers as the
 * `/api` ones. The single intentional exception is the
 * `/v1/chat/completions/responses` alias, which has no `/api` counterpart.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..", "..");
const PUBLIC_ROOT = join(ROOT, "src", "app", "v1");

/** All route files under src/app/v1, as POSIX-ish relative paths. */
function routeFiles(dir: string = PUBLIC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "route.ts") {
      out.push(relative(PUBLIC_ROOT, full).split("\\").join("/"));
    }
  }
  return out.sort();
}

describe("public /v1 routes do not shadow the rewrite", () => {
  it("only the /v1/chat/completions/responses alias has a hand-written route", () => {
    expect(routeFiles()).toEqual(["chat/completions/responses/route.ts"]);
  });

  it("the rewrite maps the public paths to the API routes", () => {
    const config = require("fs").readFileSync(join(ROOT, "next.config.ts"), "utf-8");
    expect(config).toContain('source: "/v1/:path*"');
    expect(config).toContain('destination: "/api/v1/:path*"');
    expect(config).toContain('source: "/anthropic/:path*"');
    expect(config).toContain('destination: "/api/anthropic/:path*"');
  });

  it("the API chat route is the one with streaming support", () => {
    const apiRoute = require("fs").readFileSync(
      join(ROOT, "src/app/api/v1/chat/completions/route.ts"),
      "utf-8",
    );
    expect(apiRoute).toContain("proxyResultToResponse");
    // And no duplicate carries the old buffered-only serialization.
    expect(routeFiles()).not.toContain("chat/completions/route.ts");
  });
});
