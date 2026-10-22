/**
 * tests/unit/theme-palette.test.ts
 *
 * The interface is styled after the **KDE Breeze** theme and its colour
 * schemes: the page is the *Window* colour, the content is the *View* colour,
 * the accent is Plasma Blue, and the neutrals are blue-grey rather than flat
 * grey. Two things about that are worth keeping true, and both are cheap to
 * check:
 *
 *   1. **Every role is defined, in both modes.** A missing `--warning` does
 *      not fail the build — it fails on a screen, as an invisible warning
 *      badge, and nobody notices until an operator says the badge is white.
 *   2. **The palette comes from the theme, not from the components.** A
 *      hand-written `text-slate-700` is the old grey-blue coming back, one
 *      class at a time, and it is invisible in review because the class is
 *      "just a colour". The theme variables are the only source of colour.
 *
 * The values checked here are KDE's own numbers, from the Breeze colour
 * schemes (`colors/BreezeLight.colors`, `colors/BreezeDark.colors`). The one
 * deliberate departure is pinned too: Plasma Blue with white text is 2.49:1,
 * so the *light* theme's accent is the same hue one step down, and the dark
 * theme keeps the bright Plasma Blue with a dark label. Pinning them means a
 * later change to the look is a deliberate act with a diff, not an accident.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import tailwindConfig from "../../tailwind.config";

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf-8");

/** Every colour role the components actually reference. */
const ROLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-accent",
  "sidebar-border",
  "sidebar-ring",
] as const;

/** The light theme block, from `:root` up to the first closing brace. */
function lightBlock(): string {
  const start = CSS.indexOf(":root,");
  const end = CSS.indexOf("}", start);
  return CSS.slice(start, end);
}

/** The dark theme block, from `.dark {` up to its closing brace. */
function darkBlock(): string {
  const start = CSS.indexOf(".dark {");
  const end = CSS.indexOf("}", start);
  return CSS.slice(start, end);
}

describe("the theme defines every colour role", () => {
  const light = lightBlock();
  const dark = darkBlock();

  it("in the light theme", () => {
    for (const role of ROLES) {
      expect(light, `--${role} is missing from the light theme`).toContain(`--${role}:`);
    }
  });

  it("in the dark theme", () => {
    for (const role of ROLES) {
      expect(dark, `--${role} is missing from the dark theme`).toContain(`--${role}:`);
    }
  });

  it("with a value in both", () => {
    for (const role of ROLES) {
      const inLight = /--[\w-]+:\s*([^;]+);/.exec(light.slice(light.indexOf(`--${role}:`)))?.[1];
      const inDark = /--[\w-]+:\s*([^;]+);/.exec(dark.slice(dark.indexOf(`--${role}:`)))?.[1];
      expect(inLight, `--${role} has no light value`).toBeTruthy();
      expect(inDark, `--${role} has no dark value`).toBeTruthy();
    }
  });

  it("and the surfaces are not the same surface in both modes", () => {
    // The *foregrounds* of a coloured surface are white in both modes — white
    // on a red button is white on a red button. What has to change between
    // the modes is the page itself: a light theme whose card is the same
    // colour as its background is a light theme with no cards in it.
    const SURFACES = [
      "background",
      "card",
      "popover",
      "secondary",
      "muted",
      "accent",
      "border",
      "input",
      "sidebar",
      "sidebar-accent",
      "sidebar-border",
    ];
    for (const role of SURFACES) {
      const inLight = /--[\w-]+:\s*([^;]+);/.exec(light.slice(light.indexOf(`--${role}:`)))?.[1];
      const inDark = /--[\w-]+:\s*([^;]+);/.exec(dark.slice(dark.indexOf(`--${role}:`)))?.[1];
      expect(inLight, `--${role} is the same in light and dark`).not.toBe(inDark);
    }
  });
});

/** Parse an `oklch(L C H)` value into its three numbers. */
function oklch(value: string): { l: number; c: number; h: number } | null {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!m) return null;
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

function role(block: string, name: string): string {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1] ?? "";
}

describe("the palette is the KDE Breeze one", () => {
  it("the dark theme uses Plasma Blue exactly as Breeze publishes it", () => {
    // #3daee9 — the accent of the Breeze colour schemes, unchanged.
    expect(darkBlock()).toContain("--primary: oklch(0.713 0.131 236)");
  });

  it("the light theme is the same hue, deep enough for a button label", () => {
    // Plasma Blue with white text is 2.49:1 — fine for a large selection
    // area, not for a 14px label. The light theme uses the same hue one step
    // down (5.50:1 with white).
    const primary = oklch(role(lightBlock(), "primary"));
    expect(primary).not.toBeNull();
    expect(primary!.h).toBeGreaterThan(235);
    expect(primary!.h).toBeLessThan(250);
    expect(primary!.c).toBeGreaterThan(0.09);
    expect(primary!.l).toBeLessThan(0.56);
  });

  it("the neutrals are blue-grey, not flat grey", () => {
    // Breeze's neutrals are #eff0f1 / #dee0e2 / #707d8a — almost neutral,
    // but on the cool side. A neutral with no chroma at all is the old look.
    for (const name of ["background", "secondary", "muted", "border", "muted-foreground"]) {
      const value = role(lightBlock(), name);
      const parsed = oklch(value);
      expect(parsed, `--${name} is not an oklch value: ${value}`).not.toBeNull();
      expect(parsed!.c, `--${name} has no colour of its own: ${value}`).toBeGreaterThan(0);
      expect(parsed!.h, `--${name} is not on the cool side: ${value}`).toBeGreaterThan(230);
      expect(parsed!.h, `--${name} is not on the cool side: ${value}`).toBeLessThan(260);
    }
  });

  it("the accent is the pastel selection tint", () => {
    // #eaf3fb — the light blue a selected row gets, used as a hover surface.
    const accent = oklch(role(lightBlock(), "accent"))!;
    expect(accent.c).toBeGreaterThan(0.01);
    expect(accent.l).toBeGreaterThan(0.94);
    // In the dark theme the same role is the deep ocean selection colour.
    const darkAccent = oklch(role(darkBlock(), "accent"))!;
    expect(darkAccent.l).toBeLessThan(0.5);
    expect(darkAccent.c).toBeGreaterThan(0.05);
  });

  it("in the dark theme the content sits *inside* the frame, as Plasma 6 does", () => {
    // Breeze Dark: the View (#141618) is darker than the Window (#202326).
    // That inversion is the whole reason the dark theme reads as a dark theme
    // rather than as a grey one.
    const page = oklch(role(darkBlock(), "background"))!;
    const card = oklch(role(darkBlock(), "card"))!;
    expect(card.l).toBeLessThan(page.l);
    // And in the light theme it is the other way round: the view is white.
    const lightPage = oklch(role(lightBlock(), "background"))!;
    const lightCard = oklch(role(lightBlock(), "card"))!;
    expect(lightCard.l).toBeGreaterThan(lightPage.l);
  });

  it("the radius is one step, not a pile of them", () => {
    expect(CSS).toContain("--radius: 0.625rem");
  });

  it("the icons are thin monochrome lines, as Breeze draws them", () => {
    expect(CSS).toMatch(/\.lucide\s*\{[^}]*stroke-width:\s*1\.75/);
  });
});

describe("a theme colour can be asked for at partial opacity", () => {
  /**
   * The bug this guards against is not visible in a screenshot of the source:
   * Tailwind drops the utility for a colour that is a bare `var(--x)`, so
   * `bg-primary/10` produced *no class at all* and every tinted pill, selected
   * row and notice in the app rendered with no background. The fix is in
   * `tailwind.config.ts`, where the theme colours are functions.
   *
   * Tailwind asks in two different ways and the answers have to be right in
   * both: the plain colour with a NaN opacity, and a tinted one with the
   * percentage as a **string** ("10"), not as the number 10.
   */
  const config = tailwindConfig as unknown as {
    theme: { extend: { colors: Record<string, unknown> } };
  };
  const colors = config.theme.extend.colors;

  const themeColor = (name: string) => {
    const entry = colors[name];
    if (typeof entry === "function") return entry as (args: { opacityValue?: number | string }) => string;
    return (entry as { DEFAULT?: (args: { opacityValue?: number | string }) => string } | undefined)
      ?.DEFAULT;
  };

  it("the primary is a function, not a bare variable string", () => {
    expect(typeof themeColor("primary")).toBe("function");
  });

  it("asked plainly, it answers with the variable", () => {
    const primary = themeColor("primary")!;
    expect(primary({ opacityValue: undefined })).toBe("var(--primary)");
    // What Tailwind actually sends for the plain colour.
    expect(primary({ opacityValue: NaN })).toBe("var(--primary)");
  });

  it("asked for a tint, it answers with a mix of the same variable", () => {
    const primary = themeColor("primary")!;
    // The opacity arrives as a string — "0.1", not "10".
    expect(primary({ opacityValue: "0.1" })).toBe(
      "color-mix(in oklch, var(--primary) 10%, transparent)",
    );
    // …and as a number it must not come out as "NaN%".
    expect(primary({ opacityValue: 0.1 })).toBe(
      "color-mix(in oklch, var(--primary) 10%, transparent)",
    );
  });

  it("every theme role behaves the same way", () => {
    for (const name of [
      "background",
      "foreground",
      "card",
      "popover",
      "primary",
      "secondary",
      "muted",
      "accent",
      "destructive",
      "success",
      "warning",
      "info",
      "border",
      "input",
      "ring",
    ]) {
      const fn = themeColor(name);
      expect(typeof fn, `--${name} is not a function`).toBe("function");
      expect(fn!({ opacityValue: undefined }), `--${name} plain`).toBe(`var(--${name})`);
      expect(fn!({ opacityValue: "0.25" }), `--${name} tinted`).toContain("25%");
    }
  });
});

describe("the components take their colour from the theme", () => {
  /**
   * The greys, blues and teals that used to be written straight into
   * components. Each of them is a colour that the theme now owns, and a
   * hardcoded one does not follow the dark mode.
   */
  const OFF_PALETTE = /\b(?:bg|text|border|ring|from|to|fill|stroke|decoration|divide|outline|shadow)-(?:slate|blue|indigo|sky|zinc|gray|grey|neutral|cyan|teal)-\d{2,3}\b/;

  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...filesUnder(full));
      else if (/\.(tsx|ts|css)$/.test(entry)) out.push(full);
    }
    return out;
  }

  const sources = [
    ...filesUnder(join(ROOT, "src", "app")),
    ...filesUnder(join(ROOT, "src", "components")),
  ];

  it("there is something to check", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  for (const file of sources) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    it(`uses no hardcoded palette colour in ${rel}`, () => {
      const text = readFileSync(file, "utf-8");
      const hit = OFF_PALETTE.exec(text);
      expect(hit, `${rel} hardcodes "${hit?.[0]}" — use a theme variable`).toBeNull();
    });
  }
});
