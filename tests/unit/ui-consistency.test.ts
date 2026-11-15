/**
 * tests/unit/ui-consistency.test.ts
 *
 * The editing dialogs and the test page had drifted into several spellings of
 * the same two things: the status line under a form and the box that names the
 * URL a test will hit. These guards keep the shared components in use, so a new
 * form cannot quietly grow a third style.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DICTS } from "@/lib/i18n/dict";

const SRC = join(process.cwd(), "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf-8");

const PROVIDER_FORM = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx"),
  "utf-8",
);
const PROVIDER_EDIT = readFileSync(
  join(process.cwd(), "src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx"),
  "utf-8",
);

describe("one status line, one footer", () => {
  it("the three provider editors use FormStatus and FormFooter", () => {
    for (const [name, source] of [
      ["providers create", PROVIDER_FORM],
      ["providers edit", PROVIDER_EDIT],
      ["media providers", read("app", "(admin)", "admin", "media-providers", "MediaProviderForm.tsx")],
      ["search providers", read("app", "(admin)", "admin", "search", "SearchProviderForm.tsx")],
    ] as const) {
      expect(source, `${name} does not use FormStatus`).toContain("<FormStatus");
      expect(source, `${name} does not use FormFooter`).toContain("<FormFooter");
      expect(source, `${name} still hand-rolls a destructive alert`).not.toContain(
        "border-destructive/30 bg-destructive/10",
      );
    }
  });

  it("the media and search editors use the shared Textarea for JSON", () => {
    for (const source of [
      read("app", "(admin)", "admin", "media-providers", "MediaProviderForm.tsx"),
      read("app", "(admin)", "admin", "search", "SearchProviderForm.tsx"),
    ]) {
      expect(source).toContain("<Textarea");
      expect(source).not.toContain('className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"');
    }
  });
});

describe("one endpoint line", () => {
  it("every panel that names a request URL uses EndpointLine", () => {
    for (const file of [
      ["app", "(user)", "dashboard", "models", "ModelTester.tsx"],
      ["app", "(user)", "dashboard", "models", "MediaTester.tsx"],
      ["app", "(user)", "dashboard", "models", "CustomModelProbe.tsx"],
      ["app", "(user)", "dashboard", "models", "OtherMediaProbe.tsx"],
      ["app", "(user)", "dashboard", "models", "OtherSearchProbe.tsx"],
    ] as const) {
      expect(read(...file), `${file.at(-1)} does not use EndpointLine`).toContain("<EndpointLine");
    }
  });
});

describe("similar choices are native selects", () => {
  it("the provider mode, the test configuration and the search source are selects", () => {
    expect(read("app", "(admin)", "admin", "providers", "ProviderModeSwitch.tsx")).toContain("<Select");
    expect(read("app", "(user)", "dashboard", "models", "ModelTester.tsx")).toContain('variant="select"');
    expect(read("app", "(user)", "dashboard", "models", "MediaTester.tsx")).toContain('variant="select"');
    expect(read("app", "(user)", "dashboard", "models", "SearchTester.tsx")).toContain("<Select");
    expect(read("components", "ui", "Select.tsx")).toContain("<select");
  });
});
describe("the shell is shared and the rail keeps its groups", () => {
  it("admin docs render through the same reader as the user guide", () => {
    const admin = read("app", "(admin)", "admin", "docs", "AdminDocsScreen.tsx");
    expect(admin).toContain("<UserDocsApp");
    expect(admin).toContain("AdminDocsContent");
    expect(read("lib", "docs", "sections.ts")).toContain("content?: ReactNode");
    expect(read("app", "(admin)", "admin", "docs", "page.tsx")).toContain("AdminDocsScreen");
  });

  it("both docs surfaces offer the chapter filter", () => {
    expect(read("components", "docs", "IntegrationDocs.tsx")).toContain('searchLabel={t("docs.search")}');
    expect(read("app", "(admin)", "admin", "docs", "AdminDocsScreen.tsx")).toContain('searchLabel={t("docs.search")}');
  });

  it("collapsed sidebar groups are separated by a rule, not dropped", () => {
    expect(read("components", "layouts", "sidebar", "Sidebar.tsx")).toContain(
      "h-px w-10 rounded-full bg-sidebar-border/70",
    );
  });

  it("the assistant's call modes are three native options", () => {
    const panel = read("app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");
    expect(panel).toContain("<Select");
    expect(panel).toContain('value="gateway"');
    expect(panel).toContain('value="other"');
  });
});
describe("no dead labels left behind", () => {
  it("the keys the cleanup removed are gone from both locales", () => {
    for (const key of [
      "dashboard.models.search.source",
      "dashboard.models.search.sourceLocal",
      "dashboard.models.other.title",
      "dashboard.models.custom.title",
      "dashboard.models.custom.desc",
    ]) {
      expect(key in DICTS["zh-CN"], `zh still has ${key}`).toBe(false);
      expect(key in DICTS.en, `en still has ${key}`).toBe(false);
    }
  });
});
