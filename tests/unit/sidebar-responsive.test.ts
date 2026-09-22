import { describe, it, expect } from "vitest";
import { sidebarStateForViewport } from "@/components/layouts/sidebar";

/**
 * The sidebar picks its layout from the viewport: the expanded rail (256px)
 * needs room, otherwise it is collapsed. `lg` (1024px) is where the rail stops
 * being a drawer, but 1024px minus 256px leaves too narrow a content column,
 * so the expanded default only kicks in from 1280px up.
 */
describe("sidebarStateForViewport", () => {
  it("stays collapsed on narrow viewports", () => {
    expect(sidebarStateForViewport(320)).toBe("collapsed");
    expect(sidebarStateForViewport(768)).toBe("collapsed");
    expect(sidebarStateForViewport(1024)).toBe("collapsed");
    expect(sidebarStateForViewport(1279)).toBe("collapsed");
  });

  it("expands once the rail fits alongside the content", () => {
    expect(sidebarStateForViewport(1280)).toBe("expanded");
    expect(sidebarStateForViewport(1440)).toBe("expanded");
    expect(sidebarStateForViewport(2560)).toBe("expanded");
  });
});
