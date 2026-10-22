import type { Config } from "tailwindcss";
// Loaded as ESM by Next.js/tsx, where `require` is unavailable — import the
// plugins instead of calling require() in the plugins array.
import forms from "@tailwindcss/forms";
import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

/**
 * Tailwind config — wires the CSS variables from `src/app/globals.css`
 * into Tailwind utility classes (`bg-card`, `text-muted-foreground`,
 * `border-input`, `ring-ring`, `bg-sidebar`, …).
 *
 * Each role is mapped to a CSS variable rather than a hardcoded color,
 * so toggling `html.dark` swaps the whole theme without rebuilding classes.
 *
 * The legacy `brand-*` scale is kept as an alias for the primary blue
 * (so existing `text-brand-600` references still resolve).
 */
/**
 * A theme colour that can also be asked for at partial opacity.
 *
 * Tailwind cannot add an alpha to a colour that is a bare `var(--x)`: the
 * utility is dropped from the stylesheet and the class does nothing at all.
 * That is not a subtle difference — `bg-primary/10` is how every status pill,
 * every selected row and every tinted notice is drawn, and every one of them
 * was rendering with *no background at all* (verified against the built
 * stylesheet: `.bg-primary` was in it, `.bg-primary\/10` was not).
 *
 * So a theme colour is a function here: asked for plainly it answers with the
 * variable, asked for at 10% it answers with a mix of the same variable. One
 * place, and every `/10` in the codebase starts working — in both modes, since
 * the mix is of a variable that `.dark` overrides.
 */
type ThemedColor = (args: { opacityValue?: number | string }) => string;

const themed = (name: string): ThemedColor =>
  ({ opacityValue }) => {
    // Tailwind asks for the plain colour with a NaN opacity and for a tinted
    // one with the opacity as a *string* ("0.1"), so both have to be read
    // through Number() before they can be told apart.
    const alpha = Number(opacityValue);
    return opacityValue === undefined || !Number.isFinite(alpha)
      ? `var(--${name})`
      : `color-mix(in oklch, var(--${name}) ${Math.round(alpha * 100)}%, transparent)`;
  };

/**
 * The theme's colour roles.
 *
 * Tailwind's own types say a colour is a string, but a colour may also be a
 * function — that is how it asks for one at partial opacity. The cast is
 * where the two meet; nothing else about the shape is unusual.
 */
const themeColors = {
  background: themed("background"),
  foreground: themed("foreground"),
  card: {
    DEFAULT: themed("card"),
    foreground: themed("card-foreground"),
  },
  popover: {
    DEFAULT: themed("popover"),
    foreground: themed("popover-foreground"),
  },
  primary: {
    DEFAULT: themed("primary"),
    foreground: themed("primary-foreground"),
  },
  secondary: {
    DEFAULT: themed("secondary"),
    foreground: themed("secondary-foreground"),
  },
  muted: {
    DEFAULT: themed("muted"),
    foreground: themed("muted-foreground"),
  },
  accent: {
    DEFAULT: themed("accent"),
    foreground: themed("accent-foreground"),
  },
  destructive: {
    DEFAULT: themed("destructive"),
    foreground: themed("destructive-foreground"),
  },
  success: {
    DEFAULT: themed("success"),
    foreground: themed("success-foreground"),
  },
  warning: {
    DEFAULT: themed("warning"),
    foreground: themed("warning-foreground"),
  },
  info: {
    DEFAULT: themed("info"),
    foreground: themed("info-foreground"),
  },
  neutral: {
    DEFAULT: themed("neutral"),
    foreground: themed("neutral-foreground"),
  },
  // The charts are the same coast, read from deep water out to the sand.
  chart: {
    1: themed("chart-1"),
    2: themed("chart-2"),
    3: themed("chart-3"),
    4: themed("chart-4"),
    5: themed("chart-5"),
  },
  border: themed("border"),
  input: themed("input"),
  ring: themed("ring"),
  sidebar: {
    DEFAULT: themed("sidebar"),
    foreground: themed("sidebar-foreground"),
    primary: themed("sidebar-primary"),
    "primary-foreground": themed("sidebar-primary-foreground"),
    accent: themed("sidebar-accent"),
    "accent-foreground": themed("sidebar-accent-foreground"),
    border: themed("sidebar-border"),
    ring: themed("sidebar-ring"),
  },
  // Legacy brand-* scale kept for any existing references. It is the same
  // sea blue as `--primary`, so a leftover reference still belongs to the
  // theme instead of standing out as the old indigo.
  brand: {
    50: "#f0f7fb",
    100: "#dcecf5",
    200: "#bcd9ec",
    300: "#8dbfe0",
    400: "#569fce",
    500: "#2f83bb",
    600: "#1f68a0",
    700: "#1b5383",
    800: "#1a476c",
    900: "#193c5a",
  },
} as unknown as Record<string, string>;

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: themeColors,
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      /**
       * One soft shadow, used where a surface floats above the page.
       *
       * Breeze's discipline is one shadow, not three: a card lifted off the
       * page should read as *paper on paper*, so the shadow is short and
       * slightly blue rather than a grey blur.
       */
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 40 60 / 0.04), 0 1px 3px -1px rgb(15 40 60 / 0.06)",
        float: "0 12px 32px -12px rgb(15 40 60 / 0.18)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Noto Sans CJK SC"',
        ],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      /**
       * Shared curve for the sidebar expand/collapse motion. A decelerating
       * ease (fast start, gentle settle) reads as "the rail is opening or
       * closing" rather than the abrupt feel of `ease-in-out`. Defined here
       * instead of an arbitrary `ease-[cubic-bezier(...)]` class, which
       * Tailwind reports as ambiguous.
       */
      transitionTimingFunction: {
        sidebar: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        /**
         * The indeterminate progress bar.
         *
         * KDE's busy progress bar slides a segment across the track: the work
         * is real, the total is unknown, and a bar that sits still reads as a
         * frozen screen.
         */
        "progress-slide": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(300%)" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "progress-slide": "progress-slide 1.4s ease-in-out infinite",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 200ms ease-out",
        "slide-down": "slide-down 200ms ease-out",
      },
    },
  },
  plugins: [forms, typography, animate],
};

export default config;
