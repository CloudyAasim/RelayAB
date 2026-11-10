/**
 * tests/unit/watch-deploy-observe-only.test.ts
 *
 * The deploy watcher that preceded this one had a `MAX_MISSES = 2` rule: two
 * transient timeouts during a container swap were read as "the deploy is
 * broken", and it cancelled the deploy that was still running — which took
 * production down (08 §六 item 7). Its replacement has to be *textually*
 * incapable of that, because the next person will otherwise re-add "just one
 * status call" and reintroduce the same failure with better manners.
 *
 * So this guard reads the source: only `healthz` may be fetched, no request may
 * be a write, and nothing may reach the GitHub API.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, "scripts", "watch-deploy.cjs"), "utf8");

describe("watch-deploy is observe-only", () => {
  it("watches healthz and the revision it reports", () => {
    expect(src).toContain("/healthz");
    expect(src).toContain("revision");
  });

  it("sends no write request", () => {
    expect(src).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
  });

  it("cannot cancel a deployment or mutate anything", () => {
    // ASCII "cancel" only: the Chinese prose in the header is free to explain
    // what the old script did wrong.
    expect(src).not.toMatch(/\bcancel\b/i);
    expect(src).not.toMatch(/api\.github\.com/i);
    expect(src).not.toMatch(/\bgh run\b/i);
  });

  it("is wired as a package script so the next person finds it", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["watch-deploy"]).toBe("node scripts/watch-deploy.cjs");
  });
});
