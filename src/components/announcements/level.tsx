/**
 * src/components/announcements/level.tsx
 *
 * How each announcement level looks, in one place.
 *
 * No `"use client"`: the same map is read by the anonymous docs page (a server
 * component) and by the banner (a client one), and a second copy is how `danger`
 * ends up red on one surface and grey on the next.
 */
import { Badge, type Tone } from "@/components/ui/Badge";
import {
  AlertOctagon,
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { AnnouncementLevel } from "@/lib/announcements/types";

const TONES: Record<AnnouncementLevel, Tone> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};

const ICONS: Record<AnnouncementLevel, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: AlertOctagon,
};

/**
 * The surface a notice is drawn on.
 *
 * Hairline border plus a wash of the level's own colour — the same treatment the
 * level badge uses, so a chip and the box around it are visibly the same fact.
 * Not a filled block: a notice that shouts turns the page into an alarm, and the
 * ordinary case has to stay quiet.
 */
const NOTICE_CLASS: Record<AnnouncementLevel, string> = {
  info: "border-info/30 bg-info/10",
  success: "border-success/30 bg-success/10",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/30 bg-destructive/10",
};

/**
 * The level's colour as foreground, for the icon that sits beside the title.
 *
 * The notice's own wash is too pale to tint text with, so the mark takes the
 * saturated end of the same colour instead.
 */
const TEXT_CLASS: Record<AnnouncementLevel, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

export function levelTone(level: AnnouncementLevel): Tone {
  return TONES[level];
}

export function noticeToneClass(level: AnnouncementLevel): string {
  return NOTICE_CLASS[level];
}

export function noticeTextClass(level: AnnouncementLevel): string {
  return TEXT_CLASS[level];
}

export function LevelIcon({
  level,
  className,
}: {
  level: AnnouncementLevel;
  className?: string;
}) {
  const Icon = ICONS[level];
  return <Icon className={className} aria-hidden="true" />;
}

/** The level as a chip. Needs no translation of its own: the caller labels it. */
export function LevelChip({
  level,
  label,
}: {
  level: AnnouncementLevel;
  label: string;
}) {
  return (
    <Badge tone={TONES[level]}>
      <LevelIcon level={level} className="h-3 w-3" />
      {label}
    </Badge>
  );
}