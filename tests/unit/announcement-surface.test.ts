/**
 * tests/unit/announcement-surface.test.ts
 *
 * The announcements feature has four surfaces and they must not drift apart:
 *
 *   - the strip at the top of every signed-in page (one notice),
 *   - the centre that lists all of them (`/dashboard/announcements`),
 *   - the admin page that publishes them,
 *   - the public docs page an anonymous visitor reads.
 *
 * These are source-level guards, in the same style as the other shell tests:
 * the thing worth pinning is an arrangement (mount-then-reveal, live-only tint,
 * one source of truth for the level colours) rather than a rendered string.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DICTS } from "@/lib/i18n/dict";
import { ANNOUNCEMENT_LEVELS } from "@/lib/announcements/types";

const SRC = join(process.cwd(), "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf-8");

const BANNER = read("components", "announcements", "AnnouncementBanner.tsx");
const LEVEL = read("components", "announcements", "level.tsx");
const MARKDOWN = read("components", "announcements", "AnnouncementMarkdown.tsx");
const SHELL = read("components", "layouts", "AuthenticatedLayout.tsx");
const READER_PAGE = read("app", "(user)", "dashboard", "announcements", "page.tsx");
const ADMIN_PAGE = read("app", "(admin)", "admin", "announcements", "page.tsx");
const CATALOG = read("components", "docs", "ModelCatalog.tsx");
const PUBLIC_FRAME = read("components", "docs", "PublicDocsFrame.tsx");
const USER_DOCS = read("app", "(user)", "dashboard", "docs", "UserDocsScreen.tsx");

const LOCALES = ["zh-CN", "en"] as const;

describe("the announcement strip carries one notice, not a feed", () => {
  it("is a client component", () => {
    // It reads localStorage, which the server cannot do.
    expect(BANNER.startsWith('"use client"')).toBe(true);
  });

  it("is revealed after mount, never during render", () => {
    // Rendering it first and hiding it on hydration flashes a notice the reader
    // closed a week ago. The guard has to be a state flag set in an effect.
    expect(BANNER).toContain("useState(false)");
    expect(BANNER).toMatch(/useEffect\(\(\) => \{[\s\S]*?setMounted\(true\)/);
    expect(BANNER).toContain("if (!mounted) return null;");
  });

  it("shows only the first notice and links to the rest", () => {
    expect(BANNER).toContain("visible[0]");
    expect(BANNER).toContain('href="/dashboard/announcements"');
    // `-1` because the one in the strip is already visible.
    expect(BANNER).toContain("visible.length - 1");
    expect(BANNER).toContain('t("announcements.moreCount"');
  });

  it("remembers a dismissal before it re-renders", () => {
    expect(BANNER).toContain("readDismissedIds()");
    expect(BANNER).toContain("writeDismissedIds(next)");
    // Write first: a reload in the same breath still remembers.
    const writeAt = BANNER.indexOf("writeDismissedIds(next)");
    const stateAt = BANNER.indexOf("setDismissed(next)");
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(stateAt);
  });

  it("labels the close button for a screen reader", () => {
    expect(BANNER).toContain('aria-label={t("announcements.bannerDismiss")}');
  });

  it("takes its colours from the shared level map, not from its own copy", () => {
    expect(BANNER).toContain("noticeToneClass(current.level)");
    expect(BANNER).toContain("LevelIcon");
    // No bare colour literal: a second spelling is how `danger` ends up red on
    // one surface and grey on the next.
    expect(BANNER).not.toMatch(/bg-(red|green|yellow|blue)-\d/);
  });
});

describe("the notice body is rendered, not escaped into prose", () => {
  it("goes through the house markdown renderer", () => {
    // `markdownToHtml` escapes before it emits, so an operator's prose cannot
    // become markup; the component exists so the banner, the reader page and
    // the docs page cannot each invent their own treatment.
    expect(MARKDOWN).toContain("markdownToHtml(body)");
    expect(MARKDOWN).toContain("prose prose-sm max-w-none text-foreground dark:prose-invert");
    expect(MARKDOWN).toContain("dangerouslySetInnerHTML");
  });

  it("stays usable from a server component", () => {
    // No state, so no `"use client"` — the anonymous docs page imports it too.
    expect(MARKDOWN.startsWith('"use client"')).toBe(false);
    expect(LEVEL.startsWith('"use client"')).toBe(false);
  });
});

describe("the level's look lives in exactly one place", () => {
  it("covers every level in both the tone and the icon map", () => {
    for (const level of ANNOUNCEMENT_LEVELS) {
      expect(LEVEL).toContain(`${level}: "`);
    }
    expect(LEVEL).toContain("Record<AnnouncementLevel, Tone>");
    expect(LEVEL).toContain("Record<AnnouncementLevel, LucideIcon>");
  });

  it("is what the banner, the reader page, the admin table and the docs block all use", () => {
    expect(BANNER).toContain('from "./level"');
    expect(READER_PAGE).toContain('from "@/components/announcements/level"');
    expect(ADMIN_PAGE).toContain("LevelBadge");
    expect(CATALOG).toContain('from "@/components/announcements/level"');
  });
});

describe("the shell puts the strip in the right place", () => {
  it("sits inside the inset, above the page", () => {
    const inset = SHELL.indexOf("<SidebarInset>");
    const banner = SHELL.indexOf("<AnnouncementBanner");
    const main = SHELL.indexOf("<main", banner);
    expect(inset).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(inset);
    expect(main).toBeGreaterThan(banner);
  });

  it("is skipped on the assistant, whose height is exact", () => {
    // The chat computes "viewport minus app header" and pins its composer to
    // that bottom edge; a strip above it would push the composer under the fold.
    expect(SHELL).toContain("!EDGE_TO_EDGE_ROUTES.has(pathname)");
    expect(SHELL).toContain("announcements.length > 0");
  });

  it("renders nothing when there is no notice", () => {
    expect(SHELL).toContain("announcements = []");
  });
});

describe("the notice centre is a reader's history", () => {
  it("is gated and always fresh", () => {
    expect(READER_PAGE).toContain('export const dynamic = "force-dynamic"');
    expect(READER_PAGE).toContain("getCurrentUser()");
    expect(READER_PAGE).toContain('redirect("/login")');
  });

  it("takes one clock reading for the whole page", () => {
    // Two rows whose windows touch must not disagree because a millisecond
    // passed between two `new Date()` calls.
    expect(READER_PAGE).toContain("const now = new Date();");
    expect(READER_PAGE.match(/new Date\(\)/g)).toHaveLength(1);
  });

  it("lists only what was published, not drafts or withdrawn rows", () => {
    // `listPublishedAnnouncements` owns that rule; the page must not re-filter.
    expect(READER_PAGE).toContain("listPublishedAnnouncements(now)");
    expect(READER_PAGE).not.toContain("listAnnouncements(");
  });

  it("tints a live notice and mutes a finished one", () => {
    expect(READER_PAGE).toContain('announcementState(announcement, now) === "live"');
    expect(READER_PAGE).toContain("live && noticeToneClass(announcement.level)");
    expect(READER_PAGE).toContain("!live && \"bg-muted/30\"");
    expect(READER_PAGE).toContain("live ? noticeTextClass(announcement.level) : \"text-muted-foreground\"");
    // The wash is the level saying "this applies"; a red box around a finished
    // maintenance window is an alarm about nothing.
    expect(READER_PAGE).toContain('{!live && <Badge tone="neutral">{t("announcements.ended")}</Badge>}');
  });

  it("says when it was posted, and until when when it is still live", () => {
    expect(READER_PAGE).toContain('t("announcements.posted"');
    expect(READER_PAGE).toContain('t("announcements.until"');
    expect(READER_PAGE).toContain("live && announcement.endsAt");
  });

  it("has an empty state rather than an empty page", () => {
    expect(READER_PAGE).toContain("<EmptyState");
    expect(READER_PAGE).toContain('t("announcements.empty")');
  });

  it("does not import the database from a page the client never sees anyway", () => {
    // Cheap insurance: the reader page is a server component, so `node:sqlite`
    // here is fine — but the *components* it imports must stay client-safe.
    expect(READER_PAGE).not.toContain('"use client"');
  });
});

describe("the admin page publishes, it does not merely list", () => {
  it("shows every row, including the ones readers cannot see", () => {
    // A notice that has not started and one that was never written look
    // identical from a reader's side; filtering this page to "live" would hide
    // exactly the rows worth checking.
    expect(ADMIN_PAGE).toContain("listAnnouncements()");
    expect(ADMIN_PAGE).not.toContain("listPublishedAnnouncements");
  });

  it("names the derived state instead of storing one", () => {
    expect(ADMIN_PAGE).toContain("announcementState(a, now)");
    expect(ADMIN_PAGE).toContain("admin.announcements.state.");
  });

  it("is admin-only and always fresh", () => {
    expect(ADMIN_PAGE).toContain('export const dynamic = "force-dynamic"');
    expect(ADMIN_PAGE).toContain('redirect("/dashboard")');
  });
});

describe("the public docs page shows the newest active notice", () => {
  it("fetches it where there is no shell to carry a banner", () => {
    expect(PUBLIC_FRAME).toContain("listActiveAnnouncements()");
    expect(PUBLIC_FRAME).toContain("toPublicAnnouncement(active[0])");
    expect(CATALOG).toContain("{announcement && (");
  });

  it("does not repeat it for a signed-in reader, who already has the strip", () => {
    expect(USER_DOCS).not.toContain("announcement");
  });
});

describe("the retirement of settings.announcement is complete", () => {
  it("leaves no key behind in either locale", () => {
    for (const key of ["admin.docsSettings.announcement"]) {
      for (const locale of LOCALES) {
        expect(key in DICTS[locale], `${locale} still has ${key}`).toBe(false);
      }
    }
  });

  it("leaves no per-level admin labels: the words are shared with readers", () => {
    // One vocabulary for the banner, the table, the form and the docs page —
    // a second set under `admin.announcements.level.*` is how the admin table
    // starts calling a level something the reader never sees.
    for (const level of ANNOUNCEMENT_LEVELS) {
      expect(`admin.announcements.level.${level}` in DICTS.en).toBe(false);
      expect(`admin.announcements.level.${level}` in DICTS["zh-CN"]).toBe(false);
    }
  });
});

describe("the announcement words exist in both locales", () => {
  const KEYS = [
    "announcements.title",
    "announcements.description",
    "announcements.empty",
    "announcements.empty.description",
    "announcements.bannerDismiss",
    "announcements.pinnedBadge",
    "announcements.until",
    "announcements.posted",
    "announcements.ended",
    "announcements.moreCount",
    "nav.announcements",
    "admin.announcements.title",
    "admin.announcements.description",
    "admin.announcements.new",
    "admin.announcements.edit",
    "admin.announcements.empty",
    "admin.announcements.empty.description",
    "admin.announcements.titleLabel",
    "admin.announcements.body",
    "admin.announcements.bodyHint",
    "admin.announcements.level",
    "admin.announcements.levelHint",
    "admin.announcements.startsAt",
    "admin.announcements.endsAt",
    "admin.announcements.windowHint",
    "admin.announcements.pinned",
    "admin.announcements.pinnedHint",
    "admin.announcements.enabled",
    "admin.announcements.enable",
    "admin.announcements.disable",
    "admin.announcements.confirmDelete",
    "admin.announcements.saved",
    "admin.announcements.table.state",
    "admin.announcements.table.window",
    "admin.announcements.noWindow",
  ];

  it("defines every key in zh-CN and en", () => {
    for (const key of KEYS) {
      expect(DICTS["zh-CN"][key], `zh-CN is missing ${key}`).toBeTruthy();
      expect(DICTS.en[key], `en is missing ${key}`).toBeTruthy();
    }
  });

  it("defines the four level words readers see", () => {
    for (const level of ANNOUNCEMENT_LEVELS) {
      const key = `announcements.level.${level}`;
      expect(DICTS["zh-CN"][key], `zh-CN is missing ${key}`).toBeTruthy();
      expect(DICTS.en[key], `en is missing ${key}`).toBeTruthy();
    }
  });

  it("defines the four derived states the admin table prints", () => {
    for (const state of ["live", "scheduled", "expired", "off"]) {
      const key = `admin.announcements.state.${state}`;
      expect(DICTS["zh-CN"][key], `zh-CN is missing ${key}`).toBeTruthy();
      expect(DICTS.en[key], `en is missing ${key}`).toBeTruthy();
    }
  });

  it("keeps the placeholders the interpolation actually receives", () => {
    // `translate` only substitutes named braces; a key that lost its `{date}`
    // drops the fact it was carrying, and nothing else would notice.
    for (const locale of LOCALES) {
      expect(DICTS[locale]["announcements.posted"]).toContain("{date}");
      expect(DICTS[locale]["announcements.until"]).toContain("{date}");
      expect(DICTS[locale]["announcements.moreCount"]).toContain("{count}");
      expect(DICTS[locale]["admin.announcements.confirmDelete"]).toContain("{title}");
    }
  });
});
