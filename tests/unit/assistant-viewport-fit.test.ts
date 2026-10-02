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
const SHELL = readFileSync(join(SRC, "components", "layouts", "AuthenticatedLayout.tsx"), "utf-8");

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

  it("never reaches outside the box that clips it", () => {
    // The page body is rendered inside an `overflow-hidden` element, so a child
    // that pokes out with negative margins is cut off at the edge. This is what
    // trimmed the chat's top bar and composer: the `-mx-*`/-mt-*/-mb-* that
    // looked like a way to get full-bleed. On a desktop the centred reading
    // column left slack to absorb the overflow, so it hid there and only
    // showed on a phone, where the column is the full width.
    expect(CHAT, "the chat still uses negative margins to escape its container").not.toMatch(
      /-\m[xtb]-\d/,
    );
  });

  it("gets its edges from the shell instead", () => {
    // Same edge-to-edge result, achieved by dropping the page padding on the
    // route rather than by cancelling it from the inside out.
    expect(SHELL).toContain("EDGE_TO_EDGE_ROUTES");
    expect(SHELL).toMatch(/EDGE_TO_EDGE_ROUTES\.has\(pathname\)/);
    expect(SHELL).toContain('"/dashboard/assistant"');
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
