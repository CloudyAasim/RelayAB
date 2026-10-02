/**
 * tests/unit/assistant-viewport-fit.test.ts
 *
 * The assistant is the one screen that owns the whole viewport: it cancels the
 * shell's padding and pins the composer to the bottom edge. That makes it the
 * one screen where a unit the browser does not understand turns into a page
 * that looks broken, and these are the ways that happens.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const CHAT = readFileSync(join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"), "utf-8");
const ROOT_LAYOUT = readFileSync(join(SRC, "app", "layout.tsx"), "utf-8");

describe("assistant: the chat fits the viewport", () => {
  it("declares a vh height before the dvh one, so an older browser still gets a height", () => {
    // `dvh` is the right unit on a phone - it follows the collapsing address bar
    // and the keyboard - but a browser that does not parse it discards the whole
    // declaration, and a height-less flex column collapses to its content, which
    // reads as a page that failed to render rather than as a missing unit.
    const vh = CHAT.match(/h-\[calc\(100vh[^\]]*\]/);
    const dvh = CHAT.match(/h-\[calc\(100dvh[^\]]*\]/);
    expect(vh, "no 100vh fallback: a browser without dvh gets no height at all").not.toBeNull();
    expect(dvh, "no 100dvh: the chat does not follow the mobile viewport").not.toBeNull();
    // Tailwind emits classes in source order, so the second one wins where it
    // is understood and the first stands in where it is not.
    expect(vh!.index!).toBeLessThan(dvh!.index!);
  });

  it("has no minimum height", () => {
    // A floor is a promise the viewport may not keep: a phone in landscape is
    // shorter than 384px, and honouring the floor puts the composer below the
    // fold on exactly the devices with the least room.
    const match = CHAT.match(/className="[^"]*\bmin-h-\[\d+rem\][^"]*"/);
    expect(match, `a rem minimum height crept back: ${match?.[0] ?? ""}`).toBeNull();
  });

  it("cancels the shell's padding on every side, so the chat really is edge to edge", () => {
    // `main` is p-4 / sm:p-6 / lg:p-8. Each breakpoint's padding has to be
    // cancelled at that same breakpoint or the height arithmetic is off by it.
    for (const [breakpoint, pad] of [
      ["", "4"],
      ["sm:", "6"],
      ["lg:", "8"],
    ] as const) {
      for (const side of ["mx", "mt", "mb"] as const) {
        expect(
          CHAT,
          `missing -${side}-${pad} at the ${breakpoint || "base"} breakpoint`,
        ).toContain(`${breakpoint}-${side}-${pad}`);
      }
    }
  });

  it("lets the message list scroll instead of the page", () => {
    expect(CHAT).toContain("ref={scrollRef}");
    // `min-h-0` is what lets a flex child actually shrink below its content,
    // which is the difference between the list scrolling and the page growing.
    expect(CHAT).toContain("min-h-0 flex-1 overflow-y-auto");
  });
});

describe("root layout: the on-screen keyboard", () => {
  it("asks the browser to shrink the layout viewport when the keyboard opens", () => {
    // The keyboard is an overlay by default, and a composer pinned to the
    // bottom of a full-height chat is exactly what ends up underneath it.
    expect(ROOT_LAYOUT).toContain("interactiveWidget");
    expect(ROOT_LAYOUT).toContain("resizes-content");
  });

  it("caps the zoom so focusing a field cannot leave the page sideways-scrolled", () => {
    expect(ROOT_LAYOUT).toContain("maximumScale");
  });
});
