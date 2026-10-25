/**
 * tests/unit/ui-density.test.ts
 *
 * How much room a thing takes, against how much it has to say.
 *
 * The complaint this file answers is not "the colours are wrong" — it is that
 * a screen has parts that are mostly empty and parts that hold far too much,
 * and that the second kind pushes the first kind off a small screen.
 *
 * Four rules, each one a defect that was actually shipped:
 *
 *   1. **A card's content does not draw a second border.** A row inside a card
 *      that carries its own border is a box in a box, and it reads as one more
 *      surface where there was one.
 *   2. **A card does not get taller because its neighbour is tall.** Two cards
 *      side by side stretch to the taller one, so the shorter one ends up with
 *      a pane of empty space inside it.
 *   3. **The drawer is closed without JavaScript.** `isMobile` is decided in an
 *      effect, so the first paint — and any page with no script at all — drew
 *      the panel `fixed` and untransformed, straight over the content.
 *   4. **A table that is too wide for a phone drops its quiet columns.** Seven
 *      columns on a 375px screen is a row of crumbs and a sideways scroll.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const APP_FILES = filesIn(join(ROOT, "src", "app"));

describe("a card's content does not draw a second border", () => {
  it("the overview's usage figures are a plain grid", () => {
    // They were three bordered boxes in a row: a border inside the card's own
    // border, one line of text in 42 pixels, and the name pinned to the far
    // left of the card with the figure pinned to the far right.
    const overview = read("src", "app", "(admin)", "admin", "page.tsx");
    expect(overview).not.toContain("rounded-md border border-border");
    expect(overview).toContain("function Metric(");
    expect(overview).toMatch(/grid gap-4 sm:grid-cols-3/);
  });
});

describe("a card does not get taller because its neighbour is tall", () => {
  it("the overview's two cards keep their own heights", () => {
    const overview = read("src", "app", "(admin)", "admin", "page.tsx");
    expect(overview).toContain("mt-6 grid items-start gap-6 lg:grid-cols-2");
  });
});

describe("the drawer is closed without JavaScript", () => {
  const sidebar = read("src", "components", "layouts", "sidebar", "Sidebar.tsx");
  const header = read("src", "components", "layouts", "AppHeader.tsx");

  it("the closed state is the default, and the open drawer is the exception", () => {
    // `isMobile` is decided in an effect. The server's markup and the first
    // paint both have it `false`, and a `fixed` panel with no transform sits on
    // top of the page — a 240px slab of navigation over the content, on every
    // load, until the script arrives. With no script it never goes away.
    expect(sidebar).toContain(
      'open ? "translate-x-0" : "translate-x-[calc(-100%_-_0.5rem)]"',
    );
    // The transform is not behind an `isMobile` branch any more.
    expect(sidebar).not.toMatch(/isMobile\s*\n\s*\?\s*open/);
  });

  it("and the way back into the navigation is there before the script runs", () => {
    // The bar is `lg:hidden`, so it only exists below 1024px — exactly where
    // the sidebar is a drawer. Asking `isMobile` as well was redundant, and
    // it cost the button on the first paint: a phone had a header with no way
    // into the navigation at all.
    expect(header).not.toContain("{isMobile && (");
    expect(header).toContain('onClick={() => setOpen(!open)}');
  });
});

describe("a table too wide for a phone drops its quiet columns", () => {
  /**
   * Every table header in the app, and how many columns it has.
   *
   * The rule is about the widest ones only: below six columns a row is still
   * a row. Above it, something has to give, and the something is the column
   * nobody came to read.
   */
  function tableHeads(): { file: string; columns: number; hidden: number }[] {
    const out: { file: string; columns: number; hidden: number }[] = [];
    for (const file of APP_FILES) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(/<THead>([\s\S]*?)<\/THead>/g)) {
        const head = match[1];
        out.push({
          file: file.replace(ROOT, ""),
          columns: (head.match(/<TH\b/g) ?? []).length,
          hidden: (head.match(/hidden\b/g) ?? []).length,
        });
      }
    }
    return out;
  }

  it("every table over six columns hides at least one of them on a small screen", () => {
    const wide = tableHeads().filter((t) => t.columns > 6);
    // Something to check — otherwise the rule below is vacuous.
    expect(wide.length, "no table wide enough to need the rule").toBeGreaterThan(0);
    const offenders = wide.filter((t) => t.hidden === 0).map((t) => `${t.file}: ${t.columns} columns`);
    expect(
      offenders,
      "a table this wide needs a column that steps aside on a phone:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the admin overview's usage table gives up its two quiet columns", () => {
    const overview = read("src", "app", "(admin)", "admin", "page.tsx");
    expect(overview).toContain('className="hidden sm:table-cell"');
    expect(overview).toContain('className="hidden xl:table-cell text-right"');
  });

  it("and so do the admin keys table and the providers table", () => {
    const keys = read("src", "app", "(admin)", "admin", "keys", "page.tsx");
    expect(keys).toContain('className="hidden xl:table-cell"');
    expect(keys).toContain('className="hidden lg:table-cell"');

    const providers = read("src", "app", "(admin)", "admin", "providers", "page.tsx");
    expect(providers).toContain('className="hidden lg:table-cell"');
  });

  it("and the search providers table waits for a genuinely wide window", () => {
    // Nine columns. At 1280px they did not fit, and the browser squeezed the
    // headers until 「优先级」 was three characters stacked vertically and
    // 「每次调用积分」 was five — a header row 120 pixels tall with vertical
    // words in it. The endpoint and the priority now wait for 2xl.
    const search = read("src", "app", "(admin)", "admin", "search", "page.tsx");
    expect(search).toContain('className="hidden 2xl:table-cell"');
  });
});

describe("the stat tile is as tall as its two lines", () => {
  const card = read("src", "components", "ui", "Card.tsx");

  it("the label and the icon share one line", () => {
    // Aligned to the top, the label sat at the top edge of a 32px icon with
    // 16 pixels of nothing under it, and the tile read as taller than the
    // lines it held.
    expect(card).toContain('className="flex items-center justify-between gap-2"');
  });

  it("and the gaps between the two lines are the tight ones", () => {
    expect(card).toContain('className="mt-1 text-xl font-semibold');
    expect(card).toContain("sm:mt-2 sm:text-2xl");
    expect(card).not.toContain("sm:mt-3");
  });

  it("and it is a label and a number — nothing else", () => {
    // It used to take a `hint` and a `trend`, and every page that used them
    // paid for a line of small text under a number the number already
    // answered: 「8」 with 「8 已启用密钥」 under it, while the page said the
    // same thing again in the panel below.
    //
    // A tile that needs a caption to explain itself is a card that wants two
    // fields, not a caption.
    expect(card).not.toMatch(/\bhint\??:/);
    expect(card).not.toMatch(/\btrend\??:/);
    expect(card).not.toContain("trendClass");
  });
});

/**
 * Let the layout say it.
 *
 * A caption under a title, a second line under a number, a note that repeats
 * the column beside it — each one is a sentence the reader has to read to
 * learn nothing the screen had not already shown. The rule is narrow on
 * purpose: a line stays when it says something the layout cannot show (why a
 * value is what it is, what happens if you touch it, what a badge means).
 */
describe("the phone layout is two up, not one", () => {
  it("the overview's four figures stand two to a row", () => {
    // One column below `sm` meant four tiles stood in a stack on a phone —
    // 84 pixels each, 384 of them, and the page's real content started
    // below the fold.
    const overview = read("src", "app", "(admin)", "admin", "page.tsx");
    expect(overview).toMatch(/grid grid-cols-2[^"]*lg:grid-cols-4/);
  });

  it("and so do the account's three", () => {
    const dashboard = read("src", "app", "(user)", "dashboard", "page.tsx");
    expect(dashboard).toMatch(/grid grid-cols-2[^"]*lg:grid-cols-3/);
  });

  it("and the tile drops its icon on a narrow screen", () => {
    // A tile two-up on a phone is 160 pixels wide. A 28-pixel chip beside
    // the label is a fifth of the row spent on decoration, and it is what
    // made the label's own line 28 pixels tall instead of 16.
    const card = read("src", "components", "ui", "Card.tsx");
    expect(card).toMatch(/hidden h-7 w-7[^\n]*sm:flex/);
  });
});

describe("the layout says it, so the page does not", () => {
  /** The pages whose content names itself — the tiles, the cards, the table. */
  const SELF_NAMING_PAGES: string[][] = [
    ["src", "app", "(admin)", "admin", "page.tsx"],
    ["src", "app", "(admin)", "admin", "users", "page.tsx"],
    ["src", "app", "(admin)", "admin", "settings", "page.tsx"],
    ["src", "app", "(admin)", "admin", "search", "page.tsx"],
    ["src", "app", "(user)", "dashboard", "page.tsx"],
    ["src", "app", "(user)", "dashboard", "settings", "page.tsx"],
  ];

  for (const parts of SELF_NAMING_PAGES) {
    it(`${parts.join("/")} carries no description under its title`, () => {
      const source = read(...parts);
      expect(
        source,
        "the layout already names this page's content — the sentence under the " +
          "title says it a second time",
      ).not.toContain("SectionPageLayout.Description");
    });
  }

  it("an action menu does not describe itself as a menu of actions", () => {
    // The modal's body is a list of buttons. A description reading 「操作」
    // above it tells the reader nothing the buttons do not.
    for (const parts of [
      ["src", "app", "(admin)", "admin", "users", "UserActions.tsx"],
      ["src", "app", "(admin)", "admin", "keys", "KeyActions.tsx"],
      ["src", "app", "(user)", "dashboard", "UserKeyActions.tsx"],
    ]) {
      const source = read(...parts);
      expect(source, `${parts.join("/")} describes its menu of actions`).not.toContain(
        'description={t("common.actions")}',
      );
    }
  });

  it("a form does not describe itself with its own field labels", () => {
    // The 「新建用户」 modal said 「用户名」 above a field labelled 「用户名」,
    // and the password card said 「先输入当前密码，然后输入两次新密码」 above
    // three fields that say exactly that.
    const createUser = read("src", "app", "(admin)", "admin", "users", "CreateUserButton.tsx");
    expect(createUser).not.toContain('description={t("admin.users.create.username")}');

    const login = read("src", "app", "(auth)", "login", "page.tsx");
    expect(login).not.toContain("login.signInDesc");

    const settings = read("src", "app", "(user)", "dashboard", "settings", "page.tsx");
    expect(settings).not.toContain("settings.assistantCredential.desc");
    expect(settings).not.toContain("settings.password.desc");
  });

  it("and a card does not repeat what the field below it says", () => {
    // The 「用户额度配置」 card said the pool belongs to the account and every
    // key draws from it — and the 「积分池总量」 field underneath said the same
    // thing, a card's worth apart.
    const users = read("src", "app", "(admin)", "admin", "users", "page.tsx");
    expect(users).not.toContain("admin.users.allocation.desc");
  });

  it("and the dictionary has no key left over for the sentences that went", () => {
    // A removed sentence whose key stayed is a trap: the next page that
    // reaches for it gets text nobody remembers approving.
    const dict = read("src", "lib", "i18n", "dict.ts");
    for (const key of [
      "dashboard.subtitle",
      "admin.overview.description",
      "admin.users.description",
      "admin.searchProviders.summary",
      "admin.settings.description",
      "settings.subtitle",
      "dashboard.apiKeys.description",
      "admin.stat.tokensHint",
      "login.signInDesc",
      "settings.assistantCredential.desc",
      "settings.password.desc",
      "admin.users.allocation.desc",
    ]) {
      expect(dict, `"${key}" is no longer used by anything`).not.toContain(`"${key}":`);
    }
  });
});
