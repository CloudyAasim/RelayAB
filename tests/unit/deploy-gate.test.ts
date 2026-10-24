/**
 * tests/unit/deploy-gate.test.ts
 *
 * The production host has 3.8 GiB of RAM and no swap. `next build` used to
 * type-check inside the build, on that host, and that step took eleven minutes
 * and took the whole machine down with it three times in one day: the kernel's
 * OOM killer reaps sshd and nginx, and the symptom is a site that accepts TCP
 * connections and never answers.
 *
 * So the arrangement is now:
 *
 *   - **the check is a CI gate** — the `verify` job runs the type check and
 *     the tests on a runner with memory to spare, and the deploy waits for it;
 *   - **the host only compiles** — `next build` skips the type check, which
 *     is why a build there takes a minute instead of twelve;
 *   - **the build has a ceiling** — the Dockerfile caps the build's heap, so a
 *     spike fails a build instead of failing the machine.
 *
 * Each of those three can be undone by one line, and the failure mode of
 * undoing it is a silent outage. Hence this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "deploy.yml"), "utf-8");
const NEXT_CONFIG = readFileSync(join(ROOT, "next.config.mjs"), "utf-8");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf-8");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

describe("the type check is a CI gate", () => {
  it("there is a verify job that runs it", () => {
    expect(WORKFLOW).toMatch(/^\s{2}verify:/m);
    expect(WORKFLOW).toMatch(/pnpm run type-check/);
  });

  it("and it runs the tests too", () => {
    expect(WORKFLOW).toMatch(/pnpm run test/);
  });

  it("and the deploy waits for it", () => {
    // Without this the two run side by side and a broken commit still reaches
    // the host — the gate would be a gate in name only.
    const deployBlock = WORKFLOW.slice(WORKFLOW.indexOf("\n  deploy:"));
    expect(deployBlock).toMatch(/needs:\s*verify/);
  });

  it("and the check it runs is a real one", () => {
    expect(PACKAGE.scripts["type-check"]).toContain("tsc --noEmit");
  });
});

describe("the host build does not type-check", () => {
  it("next build skips the type check", () => {
    expect(NEXT_CONFIG).toMatch(/ignoreBuildErrors:\s*true/);
  });

  it("and the comment says why, so the next reader does not undo it", () => {
    // A config flag with no explanation is a flag somebody will "fix".
    expect(NEXT_CONFIG).toMatch(/type check is a CI gate/i);
  });
});

describe("a documentation-only commit does not reach the host", () => {
  /**
   * The host has 3.8 GiB of RAM and no swap, and a build there has taken the
   * whole machine down four times — the fourth on a commit that changed
   * nothing but Markdown. The cost of a deployment does not depend on the size
   * of the change, so the change that should not pay for a rebuild is the one
   * that changes no runtime bytes.
   *
   * The dangerous half of this is the *base*: diffing from the last commit
   * that reached the host, rather than from the last run, is what keeps a
   * skipped deployment from hiding code that still has to go out.
   */
  it("the verify job says whether a deployment is needed", () => {
    expect(WORKFLOW).toMatch(/outputs:[\s\S]{0,300}deploy: \$\{\{ steps\.changes\.outputs\.deploy \}\}/);
    expect(WORKFLOW).toMatch(/id:\s*changes/);
  });

  it("and the deploy job waits for that answer", () => {
    const deployBlock = WORKFLOW.slice(WORKFLOW.indexOf("\n  deploy:"));
    expect(deployBlock).toMatch(/if:.*needs\.verify\.outputs\.deploy == 'true'/);
  });

  it("the base is the last commit whose deploy job actually succeeded", () => {
    // A run whose deploy was skipped deployed nothing. Using it as the base
    // would let a skipped deployment hide code that still has to go out.
    expect(WORKFLOW).toMatch(/select\(\.name=="deploy"\)/);
    expect(WORKFLOW).toMatch(/"\$conclusion" = "success"/);
  });

  it("the diff has the history it needs", () => {
    // A shallow clone does not contain the base commit, so the diff would be
    // empty and everything would look like a documentation-only change.
    const verifyBlock = WORKFLOW.slice(WORKFLOW.indexOf("\n  verify:"), WORKFLOW.indexOf("\n  deploy:"));
    expect(verifyBlock).toMatch(/fetch-depth:\s*0/);
  });

  it("a protocol document is not documentation, because the application reads it", () => {
    // The three protocol documents are rendered by the admin pages and read by
    // the assistant's readers — they change what the running application
    // serves, so changing them has to rebuild it.
    for (const name of ["模型适配协议", "搜索适配协议", "文本适配协议"]) {
      expect(WORKFLOW, `${name} is not excluded from the docs-only rule`).toContain(name);
    }
  });

  it("and anything that is not Markdown always deploys", () => {
    expect(WORKFLOW).toMatch(/non_doc=.*grep -v -E '\\\.md\$'/);
  });
});

describe("the build has a memory ceiling", () => {
  it("the build stage caps its heap", () => {
    // Without a ceiling, the spike is decided by how much memory happens to
    // be free — and the answer has been "the whole machine" three times.
    const buildStage = DOCKERFILE.slice(
      DOCKERFILE.indexOf("AS build"),
      DOCKERFILE.indexOf("AS runtime"),
    );
    expect(buildStage).toMatch(/NODE_OPTIONS="--max-old-space-size=\d+"/);
  });

  it("and the ceiling is above the measured peak of the build", () => {
    // Measured on this repository: the whole build peaks at 1.65–1.74 GiB with
    // the worker count capped at 2. The limit applies to the main process
    // alone, so it has to sit above that figure or the build starts failing
    // for a reason that has nothing to do with the code.
    const match = /--max-old-space-size=(\d+)/.exec(DOCKERFILE);
    expect(match, "no memory ceiling in the Dockerfile").not.toBeNull();
    const limitMiB = Number(match![1]);
    expect(limitMiB).toBeGreaterThan(2048);
    // …and below the host's RAM, or it buys nothing.
    expect(limitMiB).toBeLessThan(3800);
  });
});
