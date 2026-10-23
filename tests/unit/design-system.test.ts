/**
 * tests/unit/design-system.test.ts
 *
 * The interface follows KDE's Breeze: flat, one accent, hairline borders, one
 * soft shadow, unified rounded corners, and floating panels that dim what is
 * behind them.
 *
 * Those are easy to state and easy to lose — one `bg-gradient-to-r` in a hero
 * section, one `rounded-xl` in a card, one dialog that does not dim the page,
 * and the look drifts back. This file is the drift alarm.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const UI = join(ROOT, "src", "components", "ui");

const read = (...parts: string[]): string =>
  readFileSync(join(ROOT, ...parts), "utf-8");

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const UI_FILES = filesIn(UI);

describe("floating panels", () => {
  /** The things that float above the page. */
  const FLOATING = [
    ["Modal.tsx", "z-50"],
    ["Sheet.tsx", "z-50"],
    ["DropdownMenu.tsx", "z-50"],
    ["Popover.tsx", "z-50"],
    ["Tooltip.tsx", "z-50"],
    ["Toast.tsx", "z-[100]"],
  ] as const;

  for (const [file, marker] of FLOATING) {
    describe(file, () => {
      const source = read("src", "components", "ui", file);

      it("floats above the page", () => {
        expect(source).toContain(marker);
      });

      it("has one soft shadow, not a stack of them", () => {
        expect(source).toContain("shadow-float");
      });

      it("has a hairline border", () => {
        expect(source).toContain("border-border");
      });

      it("uses the unified corner radius", () => {
        expect(source).toContain("rounded-lg");
      });
    });
  }

  it("a dialog dims what is behind it, so the eye lands on the dialog", () => {
    // KDE does this when it opens an authentication dialog: the window behind
    // darkens, and the thing you have to look at is the only bright thing.
    for (const file of ["Modal.tsx", "Sheet.tsx"]) {
      const source = read("src", "components", "ui", file);
      expect(source, `${file} does not dim the page behind it`).toMatch(
        /bg-foreground\/\d+/,
      );
    }
  });
});

describe("flat, not decorative", () => {
  it("no gradient in the shared components", () => {
    for (const file of UI_FILES) {
      const source = readFileSync(file, "utf-8");
      expect(source, `${file} has a gradient`).not.toMatch(/bg-gradient-to-/);
    }
  });

  it("no glass effect in the shared components", () => {
    // The only `backdrop-blur` allowed is the one that dims the page behind a
    // dialog; a blurred surface anywhere else is a different visual language.
    for (const file of UI_FILES) {
      const source = readFileSync(file, "utf-8");
      const blurs = source.match(/backdrop-blur-[a-z]+/g) ?? [];
      for (const blur of blurs) {
        expect(
          blur,
          `${file} uses ${blur}: the only blur allowed is the one dimming a dialog`,
        ).toBe("backdrop-blur-sm");
      }
    }
  });

  it("and none in the app shell either", () => {
    // The narrow bar was translucent and blurred while the floating panel is
    // solid — two surfaces in two languages, on the same screen. Breeze is
    // flat: the only blur left is the one dimming the page behind an overlay.
    for (const file of filesIn(join(ROOT, "src", "components", "layouts"))) {
      const source = readFileSync(file, "utf-8");
      const blurs = source.match(/backdrop-blur-[a-z]+/g) ?? [];
      for (const blur of blurs) {
        expect(
          blur,
          `${file} uses ${blur}: the only blur allowed is the one dimming an overlay`,
        ).toBe("backdrop-blur-sm");
      }
    }
  });

  it("one shadow family: the two named ones", () => {
    for (const file of UI_FILES) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.match(/shadow-(?!float|card|xs|sm)[a-z]+/g) ?? []) {
        // `shadow-lg` in the drawer is pinned by a test that matches the class
        // string verbatim; the light `shadow-float` is put on top of it with
        // `!shadow-float`, so the drawer still shows the one soft shadow.
        expect(
          match,
          `${file} uses ${match}: only shadow-card, shadow-float, shadow-xs, shadow-sm and the pinned shadow-lg belong to this theme`,
        ).toBe("shadow-lg");
      }
    }
  });
});

describe("one corner radius", () => {
  it("the shared components use the radius scale, not ad-hoc values", () => {
    for (const file of UI_FILES) {
      const source = readFileSync(file, "utf-8");
      // `rounded-lg`, `rounded-b-lg`, `rounded-t-[4px]` … — the side prefix
      // does not change the value.
      for (const match of source.match(/rounded-((?:[trbl]{1,2}-)?(?:\[[^\]]+\]|[a-z0-9]+))/g) ?? []) {
        const value = match.replace(/^rounded-(?:[trbl]{1,2}-)?/, "");
        const allowed = ["lg", "md", "sm", "full", "none", "[4px]"];
        expect(
          allowed,
          `${file} uses ${match}: the radius scale is lg / md / sm / full`,
        ).toContain(value);
      }
    }
  });
});

describe("the switch", () => {
  it("is a real switch, not a checkbox in disguise", () => {
    const source = read("src", "components", "ui", "Switch.tsx");
    // Radix gives it the keyboard behaviour and the on/off announcement that a
    // styled checkbox does not.
    expect(source).toContain("@radix-ui/react-switch");
    expect(source).toContain("data-[state=checked]");
    expect(source).toContain("focus-visible:ring-2");
  });

  it("says what it is, and what turning it off means", () => {
    const source = read("src", "components", "ui", "Switch.tsx");
    // A switch with a name and no sentence is a control the reader has to
    // interpret from context. The field carries the sentence.
    expect(source).toContain("SwitchField");
    expect(source).toMatch(/description\?: string/);
  });
});

describe("the page header", () => {
  it("has a place for the sentence that says what the page is for", () => {
    const source = read("src", "components", "layouts", "SectionPageLayout.tsx");
    expect(source).toContain("SectionPageLayout.Description");
    expect(source).toMatch(/text-muted-foreground/);
  });
});

/**
 * Tailwind's negative modifier and a negative value inside the brackets do not
 * cancel out — they multiply.
 *
 * `-translate-x-[calc(-100%_-_0.5rem)]` means "the negative of
 * `translate-x-[calc(-100% - 0.5rem)]`", which is `+100% + 0.5rem`: the panel
 * slides **right**. The mobile drawer was closed with that class and parked in
 * the middle of the screen, on top of the content, instead of off the left
 * edge — a bug nothing in the test suite could see, because the assertions
 * were on the class *name* and the name looks right.
 *
 * The negative belongs inside the brackets (`translate-x-[-50%]`,
 * `translate-x-[calc(-100%_-_0.5rem)]`), where it is the value itself.
 */
describe("arbitrary values", () => {
  const SRC = join(ROOT, "src");

  it("never combines the negative modifier with a negative inside the brackets", () => {
    // The class has to *start* with the modifier: `-translate-x-[…]`.
    // `translate-x-[-50%]` is fine — there the minus is part of the value.
    const offending = /(?:^|[\s"'`])-(?:[a-z]+-)+[a-z-]+-\[[^\]]*-\d/g;

    const hits: string[] = [];
    for (const file of filesIn(SRC)) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(offending)) {
        hits.push(`${file.replace(ROOT, "")}: ${match[0].trim()}`);
      }
    }

    expect(
      hits,
      "a negative modifier on an already-negative arbitrary value flips the sign:\n" +
        hits.join("\n"),
    ).toEqual([]);
  });
});

/**
 * Breeze's floor is the 4px grid, and its smallest type is 12px. A 10px
 * label is a label nobody can read on a phone — and there were fifty-five of
 * them.
 */
describe("the type and spacing floor", () => {
  const SRC = join(ROOT, "src");

  it("never sets a type size below 12px", () => {
    const hits: string[] = [];
    for (const file of filesIn(SRC)) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(/text-\[(\d+)px\]/g)) {
        if (Number(match[1]) < 12) {
          hits.push(`${file.replace(ROOT, "")}: ${match[0]}`);
        }
      }
    }
    expect(hits, `type below 12px:\n${hits.join("\n")}`).toEqual([]);
  });

  it("keeps vertical gaps on the 4px grid", () => {
    const hits: string[] = [];
    for (const file of filesIn(SRC)) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(/space-y-(\d+(?:\.\d+)?)/g)) {
        const value = Number(match[1]);
        if (!Number.isInteger(value * 4) || value * 4 < 4) {
          hits.push(`${file.replace(ROOT, "")}: ${match[0]}`);
        }
      }
    }
    expect(hits, `off-grid vertical gap:\n${hits.join("\n")}`).toEqual([]);
  });

  it("a table inside a card carries no frame of its own", () => {
    // Framed, it reads as a box inside a box: two borders and two shadows a
    // few pixels apart.
    const hits: string[] = [];
    for (const file of filesIn(SRC)) {
      const source = readFileSync(file, "utf-8");
      if (!source.includes("<Card")) continue;
      for (const match of source.matchAll(/<Table(?![^>]*\bbare\b)[^>]*>/g)) {
        hits.push(`${file.replace(ROOT, "")}: ${match[0]}`);
      }
    }
    expect(hits, `framed table inside a card:\n${hits.join("\n")}`).toEqual([]);
  });
});
