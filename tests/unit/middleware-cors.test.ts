/**
 * tests/unit/middleware-cors.test.ts
 *
 * Validates the CORS helpers used by src/middleware.ts.
 *
 * Regression context: the ONLYOFFICE AI plugin fetches
 * `GET {base}/v1/models` straight from the browser. Before these headers
 * existed the request reached the relay and returned 200, but the browser
 * dropped the response, so the plugin reported that no model could be loaded
 * while `curl` showed everything working.
 */
import { describe, it, expect } from "vitest";
import {
  applyCorsHeaders,
  corsHeaders,
  isCorsPathname,
  isPreflight,
} from "@/lib/http/cors";

describe("isCorsPathname", () => {
  it("exposes the public OpenAI surface", () => {
    expect(isCorsPathname("/v1/models")).toBe(true);
    expect(isCorsPathname("/v1/chat/completions")).toBe(true);
    expect(isCorsPathname("/v1")).toBe(true);
    expect(isCorsPathname("/v1/v1/models")).toBe(true);
  });

  it("exposes the Anthropic surface", () => {
    expect(isCorsPathname("/anthropic/v1/messages")).toBe(true);
    expect(isCorsPathname("/api/anthropic/v1/messages")).toBe(true);
  });

  it("exposes the handler-level /api/v1 paths", () => {
    expect(isCorsPathname("/api/v1/models")).toBe(true);
  });

  it("keeps cookie-authenticated surfaces closed", () => {
    expect(isCorsPathname("/api/admin/users")).toBe(false);
    expect(isCorsPathname("/api/user/keys")).toBe(false);
    expect(isCorsPathname("/api/auth/login")).toBe(false);
    expect(isCorsPathname("/login")).toBe(false);
    expect(isCorsPathname("/")).toBe(false);
  });

  it("does not match sibling prefixes", () => {
    expect(isCorsPathname("/v1beta/models")).toBe(false);
    expect(isCorsPathname("/api/v10/models")).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes the caller origin and asks caches to vary on it", () => {
    const headers = corsHeaders({ origin: "https://docs.example.com" });
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://docs.example.com");
    expect(headers["Vary"]).toBe("Origin");
  });

  it("falls back to * when no Origin is sent", () => {
    const headers = corsHeaders({});
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers["Vary"]).toBeUndefined();
  });

  it("never enables credentialed access", () => {
    const headers = corsHeaders({ origin: "https://docs.example.com" });
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("allows the methods the relay implements", () => {
    const headers = corsHeaders({ origin: "https://docs.example.com" });
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });

  it("echoes the requested headers of a preflight", () => {
    const headers = corsHeaders({
      origin: "https://docs.example.com",
      requestedHeaders: "authorization,x-api-key",
    });
    expect(headers["Access-Control-Allow-Headers"]).toBe("authorization,x-api-key");
  });

  it("falls back to a sensible allow-list without a preflight request", () => {
    const headers = corsHeaders({ origin: "https://docs.example.com" });
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers["Access-Control-Allow-Headers"]).toContain("x-api-key");
    expect(headers["Access-Control-Allow-Headers"]).toContain("anthropic-version");
  });

  it("caps how long a browser may cache the preflight", () => {
    expect(corsHeaders({})["Access-Control-Max-Age"]).toBe("86400");
  });
});

describe("applyCorsHeaders", () => {
  it("writes headers onto an existing Headers instance", () => {
    const target = new Headers({ "Content-Type": "application/json" });
    applyCorsHeaders(target, { origin: "https://docs.example.com" });
    expect(target.get("Access-Control-Allow-Origin")).toBe("https://docs.example.com");
    expect(target.get("Content-Type")).toBe("application/json");
  });

  it("appends to an existing Vary header instead of replacing it", () => {
    const target = new Headers({ Vary: "RSC, Next-Router-State-Tree" });
    applyCorsHeaders(target, { origin: "https://docs.example.com" });
    expect(target.get("Vary")).toBe("RSC, Next-Router-State-Tree, Origin");
  });

  it("does not duplicate an existing Origin entry in Vary", () => {
    const target = new Headers({ Vary: "Origin" });
    applyCorsHeaders(target, { origin: "https://docs.example.com" });
    expect(target.get("Vary")).toBe("Origin");
  });
});

describe("isPreflight", () => {
  it("recognises an OPTIONS request that carries an Origin", () => {
    const headers = new Headers({ Origin: "https://docs.example.com" });
    expect(isPreflight("OPTIONS", headers)).toBe(true);
    expect(isPreflight("options", headers)).toBe(true);
  });

  it("ignores OPTIONS without an Origin", () => {
    expect(isPreflight("OPTIONS", new Headers())).toBe(false);
  });

  it("ignores ordinary requests", () => {
    expect(isPreflight("GET", new Headers({ Origin: "https://docs.example.com" }))).toBe(false);
  });
});
