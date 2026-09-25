import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Source-invariant guards for the security hardening pass.
 *
 * These pin down the fixes that are easy to regress by an innocent refactor:
 *   - the login form must never fall back to a GET (password in the URL);
 *   - the global security headers must stay present;
 *   - logout must evict the client Router Cache;
 *   - the session API surface must not be cacheable;
 *   - the login endpoint must throttle failures and not echo internals.
 */
const ROOT = join(__dirname, "..", "..");
function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

describe("security hardening: source invariants", () => {
  it("submits the login form as POST so credentials never hit the URL", () => {
    const login = read("src/app/(auth)/login/page.tsx");
    expect(login).toContain('method="post"');
    // The old default-GET form must not come back.
    expect(login).not.toContain('<form onSubmit={onSubmit} className=');
  });

  it("ships baseline security headers", () => {
    const config = read("next.config.ts");
    expect(config).toContain('"X-Content-Type-Options"');
    expect(config).toContain('"X-Frame-Options"');
    expect(config).toContain('"Content-Security-Policy"');
    expect(config).toContain("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    expect(config).toContain('"Permissions-Policy"');
    expect(config).toContain('"Strict-Transport-Security"');
    // HSTS must stay production-only.
    expect(config).toContain('process.env.NODE_ENV === "production"');
  });

  it("evicts the client Router Cache on logout", () => {
    const action = read("src/app/(auth)/logout-action.ts");
    expect(action).toContain('revalidatePath("/", "layout")');
    const route = read("src/app/api/auth/logout/route.ts");
    expect(route).toContain('revalidatePath("/", "layout")');
  });

  it("marks the session API surface as non-cacheable", () => {
    const mw = read("src/middleware.ts");
    expect(mw).toContain("NO_STORE_API_PREFIXES");
    expect(mw).toContain('"/api/auth"');
    expect(mw).toContain('"/api/admin"');
    expect(mw).toContain('"/api/user"');
    expect(mw).toContain('"Cache-Control", "no-store"');
  });

  it("throttles failed logins and does not leak internal errors", () => {
    const route = read("src/app/api/auth/login/route.ts");
    expect(route).toContain("checkLoginThrottle");
    expect(route).toContain("recordLoginFailure");
    expect(route).toContain("clearLoginFailures");
    expect(route).toContain('"rate_limited"');
    // The bootstrap failure branch must not echo `err.message`.
    expect(route).not.toContain('message: err instanceof Error ? err.message');
  });
});
