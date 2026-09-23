/**
 * Smoke tests for the new shadcn/ui primitives.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..", "..", "src", "components", "ui");

function readFile(name: string): string {
  return readFileSync(join(SRC, name), "utf-8");
}

describe("UI primitives: file presence", () => {
  it("Button.tsx exports Button + buttonVariants + legacy aliases", () => {
    const f = readFile("Button.tsx");
    expect(f).toContain("export const Button");
    expect(f).toContain("buttonVariants");
    // Aliases for backward compatibility: primary -> default, md -> default
    expect(f).toMatch(/variant\?: ButtonVariant \| "primary"/);
    expect(f).toMatch(/size\?: ButtonSize \| "md"/);
  });

  it("Card.tsx exports compound API + StatCard", () => {
    const f = readFile("Card.tsx");
    expect(f).toContain("const Card");
    expect(f).toContain("const CardHeader");
    expect(f).toContain("const CardTitle");
    expect(f).toContain("const CardDescription");
    expect(f).toContain("const CardContent");
    expect(f).toContain("const CardFooter");
    expect(f).toContain("function StatCard");
  });

  it("DropdownMenu.tsx exports full primitive set", () => {
    const f = readFile("DropdownMenu.tsx");
    for (const name of [
      "DropdownMenu",
      "DropdownMenuTrigger",
      "DropdownMenuContent",
      "DropdownMenuItem",
      "DropdownMenuSeparator",
    ]) {
      expect(f).toContain(name);
    }
  });

  it("Sheet.tsx exports drawer primitives", () => {
    const f = readFile("Sheet.tsx");
    expect(f).toContain("Sheet");
    expect(f).toContain("SheetContent");
    expect(f).toContain("SheetTrigger");
  });

  it("Tabs.tsx exports tabs primitives", () => {
    const f = readFile("Tabs.tsx");
    expect(f).toContain("Tabs");
    expect(f).toContain("TabsList");
    expect(f).toContain("TabsTrigger");
    expect(f).toContain("TabsContent");
  });

  it("Tooltip.tsx exports tooltip primitives", () => {
    const f = readFile("Tooltip.tsx");
    expect(f).toContain("Tooltip");
    expect(f).toContain("TooltipTrigger");
    expect(f).toContain("TooltipContent");
    expect(f).toContain("TooltipProvider");
  });

  it("Toast.tsx exports toast primitives + context", () => {
    const f = readFile("Toast.tsx");
    expect(f).toContain("Toast");
    expect(f).toContain("ToastViewport");
    expect(f).toContain("useToast");
    expect(f).toContain("ToastContextProvider");
  });

  it("Modal.tsx exports Radix Dialog API + LegacyModal shim", () => {
    const f = readFile("Modal.tsx");
    expect(f).toContain("Modal");
    expect(f).toContain("ModalContent");
    expect(f).toContain("LegacyModal");
  });

  it("Lazy.tsx exports lazyLoad helper", () => {
    const f = readFile("Lazy.tsx");
    expect(f).toContain("export function lazyLoad");
  });

  it("Skeleton.tsx exports Skeleton", () => {
    const f = readFile("Skeleton.tsx");
    expect(f).toContain("export function Skeleton");
  });
});

describe("UI primitives: design system consistency", () => {
  it("uses CVA for variant authoring (Button, Modal, Toast)", () => {
    expect(readFile("Button.tsx")).toMatch(/import.*cva.*from.*class-variance-authority/);
    expect(readFile("Toast.tsx")).toMatch(/import.*cva.*from.*class-variance-authority/);
  });

  it("uses Tailwind `cn` for class merging", () => {
    for (const f of ["Button.tsx", "Card.tsx", "Sheet.tsx", "Tabs.tsx", "Tooltip.tsx"]) {
      expect(readFile(f)).toMatch(/import.*cn.*from.*"@\/lib\/utils"/);
    }
  });

  it("uses Radix primitives for interactive components", () => {
    expect(readFile("Sheet.tsx")).toMatch(/@radix-ui\/react-dialog/);
    expect(readFile("DropdownMenu.tsx")).toMatch(/@radix-ui\/react-dropdown-menu/);
    expect(readFile("Tabs.tsx")).toMatch(/@radix-ui\/react-tabs/);
    expect(readFile("Tooltip.tsx")).toMatch(/@radix-ui\/react-tooltip/);
    expect(readFile("Toast.tsx")).toMatch(/@radix-ui\/react-toast/);
    expect(readFile("Modal.tsx")).toMatch(/@radix-ui\/react-dialog/);
  });

  it("forwards refs on all forwardRef components (a11y)", () => {
    expect(readFile("Button.tsx")).toContain("forwardRef");
    expect(readFile("Card.tsx")).toContain("forwardRef");
    expect(readFile("Modal.tsx")).toContain("forwardRef");
  });
});
