/**
 * The two gaps the assistant itself ran into.
 *
 * 1. It could not take a proposal back. `propose_*` only created, so when a
 *    proposal was superseded the model reported a stale one as still queued and
 *    left it there. A tool that cannot withdraw is a queue nobody can tidy.
 *
 * 2. The catalogue kept showing what the change had just replaced. The
 *    revalidation lived inside the `doc_pages.update` branch, so a price
 *    change — which the catalogue prints — left that page showing the old
 *    numbers. Approve a reprice, go and look, and the model still reads as free.
 *    The approval screen described the change and the page that would confirm it
 *    did not, which is the same failure twice.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolDefinitions } from "@/lib/assistant/tools";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const TOOLS = read("src", "lib", "assistant", "tools.ts");
const DB = read("src", "lib", "db", "assistant.ts");
const APPLY = read("src", "app", "api", "assistant", "actions", "[id]", "route.ts");

describe("a proposal can be taken back", () => {
  const names = toolDefinitions(true).map((t) => t.function.name);

  it("there is a tool for it", () => {
    expect(names).toContain("withdraw_proposal");
  });

  it("and it is wired to an implementation", () => {
    expect(TOOLS).toMatch(/case "withdraw_proposal":/);
    expect(TOOLS).toMatch(/async function withdrawProposal\(/);
  });

  it("only a pending row can be withdrawn", () => {
    // The predicate is the whole point. A status update without it would let
    // "withdraw" rewrite the record of an approved change while leaving the
    // change in place — the queue and the database disagreeing, which is the
    // state this file exists to prevent.
    expect(DB).toMatch(
      /UPDATE assistant_actions SET status = 'rejected'[^;]*status = 'pending'/s,
    );
  });

  it("and a refusal says so rather than reporting success", () => {
    // The model has to be able to tell the user "already applied, that is not a
    // withdrawal" instead of leaving them believing a queue is clean.
    expect(TOOLS).toContain("撤不了");
    expect(TOOLS).toContain("它已经生效了");
  });
});

describe("a change that the catalogue prints refreshes the catalogue", () => {
  it("the revalidation is a function, not a pair of lines in one branch", () => {
    expect(APPLY).toMatch(/async function revalidateCatalog\(/);
    expect(APPLY).toMatch(/revalidatePath\("\/docs", "layout"\)/);
    expect(APPLY).toMatch(/revalidatePath\("\/dashboard\/docs", "layout"\)/);
  });

  it("and a provider update calls it", () => {
    // The branch that changes prices, context and thinking levels. Without the
    // call, approving a reprice left the model catalogue reading as free.
    const branch = APPLY.slice(
      APPLY.indexOf('claimed.kind === "provider.update"'),
      APPLY.indexOf('claimed.kind === "provider.create"'),
    );
    expect(branch).toContain("revalidateCatalog()");
  });

  it("and so does a document update, which always did", () => {
    const branch = APPLY.slice(
      APPLY.indexOf('claimed.kind === "doc_pages.update"'),
      APPLY.indexOf('claimed.kind === "media_provider.create"'),
    );
    expect(branch).toContain("revalidateCatalog()");
  });

  it("and the two pages are refreshed together, not one at a time", () => {
    // They are one catalogue rendered in two places. A later edit that added
    // only one of them would leave the same stale numbers showing somewhere
    // else, which is the bug this function exists to close.
    const fn = APPLY.slice(
      APPLY.indexOf("async function revalidateCatalog"),
      APPLY.indexOf("export async function POST"),
    );
    expect(fn).toContain('revalidatePath("/docs", "layout")');
    expect(fn).toContain('revalidatePath("/dashboard/docs", "layout")');
  });
});
