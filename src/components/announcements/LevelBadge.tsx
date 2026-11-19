"use client";

/**
 * src/components/announcements/LevelBadge.tsx
 *
 * The level chip for an announcement row, labelled through the dictionary.
 *
 * Client-side only because it reads the active locale; the map it draws from
 * lives in `./level`, which both sides of the boundary share.
 */
import { useT } from "@/components/i18n/I18nProvider";
import type { AnnouncementLevel } from "@/lib/announcements/types";
import { LevelChip } from "./level";

export function LevelBadge({ level }: { level: AnnouncementLevel }) {
  const t = useT();
  // One set of level words for both sides: the admin list and the notice a
  // reader sees have to call the same level the same thing.
  return <LevelChip level={level} label={t(`announcements.level.${level}`)} />;
}