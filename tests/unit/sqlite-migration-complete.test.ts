/**
 * tests/unit/sqlite-migration-complete.test.ts
 *
 * The move off Redis/Upstash/Vercel is only finished when the *instructions*
 * are finished too. Code that no longer reads `REDIS_URL` is easy to achieve
 * by accident; a README that still tells the next operator to set it is the
 * part that keeps costing time, because the person following it gets a
 * confident, wrong answer rather than a missing one.
 *
 * Concretely, `scripts/check-env.ts` used to report "no database configured"
 * on a perfectly healthy SQLite deployment and tell the operator to set a
 * Valkey connection string. Nothing failed; it was simply wrong.
 *
 * These guards are deliberately about *text*, not behaviour — a stale
 * `REDIS_URL` in a doc or a template is invisible to every other test here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", ".next", "playwright-report", "test-results", ".tmp-relayab-test"].includes(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const all = walk(ROOT);
const isText = (f: string): boolean =>
  /\.(ts|tsx|js|mjs|cjs|json|md|css|yml|yaml|sh|html|example)$/.test(f) || f.endsWith(".env.example");

/** Files a user might read or copy. Runtime code is covered by the other tests. */
const DOCUMENTED = all.filter((f) => {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  return (
    isText(f) &&
    !rel.startsWith("tests/") &&
    (rel.startsWith("docs/") ||
      rel.startsWith("deploy/") ||
      rel.startsWith("README") ||
      rel === ".env.example" ||
      rel.startsWith("src/app/"))
  );
});

/** Code that runs. A comment explaining *why* the old store went away is fine. */
const RUNTIME = all.filter((f) => {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  return isText(f) && (rel.startsWith("src/lib/") || rel.startsWith("src/app/") || rel.startsWith("scripts/"));
});

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

describe("SQLite migration is complete", () => {
  it("has no runtime dependency on Redis or Upstash", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    const offenders = deps.filter((d) => /redis|upstash|@vercel|valkey/i.test(d));
    expect(offenders, `runtime deps still on a retired store: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no runtime code reads a Redis/Upstash env var", () => {
    // Comments are excluded: "the Redis version relied on HINCRBY" is history
    // worth keeping, a `process.env.REDIS_URL` read is not.
    const offenders = RUNTIME.filter((f) =>
      /\b(REDIS_URL|UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_URL|KV_REST_API_TOKEN|EMULATE_VERCEL_LOCAL)\b/.test(
        stripComments(readFileSync(f, "utf8")),
      ),
    ).map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(offenders, `these still read a retired variable:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no user-facing document tells anyone to configure Redis", () => {
    // Matching the bare words is not enough: half the docs correctly *say*
    // "no Redis/Valkey, no port, no password", and that is the message we
    // want. What must not survive is an instruction — "set REDIS_URL to…",
    // "still supported", a curl against an Upstash URL.
    //
    // A negation check is unavoidable: "**Nothing to install.** No
    // `apt install valkey-server`" is advice we want to keep, and
    // "设置 X 不会有任何效果" is exactly as true. Both contain the pattern.
    const INSTRUCTS = [
      /设置\s*`?REDIS_URL(?!`?\s*或?\s*`?REDIS_URL`?\s*不会有)/,
      /设置\s*`?UPSTASH_REDIS_REST(?!.*不会有)/,
      /Set\s+`?REDIS_URL/i,
      /set\s+`?UPSTASH_REDIS_REST(?!.*(?:no effect|nothing))/i,
      /仍然支持[^\n]*Upstash/,
      /Still supported[^\n]*Upstash/i,
      /code still supports/i,
      /UPSTASH_REDIS_REST_URL\/hgetall/,
      /UPSTASH_REDIS_REST_URL\/keys\//,
      /直接 hit Upstash|Hit Upstash Redis Directly/i,
    ];
    const offenders = DOCUMENTED.filter((f) => {
      const src = readFileSync(f, "utf8");
      return INSTRUCTS.some((re) => re.test(src));
    }).map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(
      offenders,
      `these instruct the operator to set up a store that no longer exists:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("but a document may still say Redis is gone", () => {
    // Guards the guard: if "no Redis/Valkey" ever starts failing this, the
    // negation handling above has become too aggressive to be useful.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/Redis|Valkey/);
  });

  it("the environment template describes SQLite as the only store", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("RELAY_DB_PATH");
    expect(env).not.toMatch(/\bREDIS_URL\b/);
  });

  it("check-env validates the store that actually exists", () => {
    const src = stripComments(readFileSync(join(ROOT, "scripts", "check-env.ts"), "utf8"));
    expect(src).toContain("RELAY_DB_PATH");
    // The script must actually touch the filesystem; "the variable is set" is
    // not the question, "can the process write there" is.
    expect(src).toMatch(/writeFileSync|mkdirSync/);
    expect(src).not.toMatch(/UPSTASH_/);
  });

  it("health reports sqlite and nothing else", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "health.ts"), "utf8");
    expect(src).toMatch(/storage: HealthReport\["storage"\]/);
    // A dead redis:// sniffer is how the old store's ghost survived the port.
    expect(stripComments(src)).not.toMatch(/redis:\/\/|rediss:\/\//i);
    // The retired mock-store switch has no code left to switch.
    expect(stripComments(src)).not.toContain("EMULATE_VERCEL_LOCAL");
  });

  it("no build or deploy config still targets Vercel", () => {
    const candidates = [
      "next.config.mjs",
      "vercel.json",
      ".github/workflows/deploy.yml",
      "Procfile",
      "app.json",
    ].filter((f) => existsSync(join(ROOT, f)));
    expect(candidates.length).toBeGreaterThan(0);

    // Comments explaining the branch strategy legitimately mention Vercel
    // ("main is the frozen Vercel build"). What must not exist is a Vercel
    // *build target*: a vercel.json, or a `builds`/`vercel-build` directive.
    const offenders = candidates.filter((f) => {
      const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
      return /vercel\.json|"builds"\s*:|vercel-build|\/api\/vercel/i.test(src);
    });
    expect(offenders, `still configured for a Vercel build: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the systemd unit does not wait on a database service", () => {
    const unit = join(ROOT, "deploy", "relayab.service");
    if (!existsSync(unit)) return;
    const src = readFileSync(unit, "utf8");
    expect(src).not.toMatch(/valkey-server|redis/i);
  });
});
