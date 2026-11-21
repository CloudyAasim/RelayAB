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
 * A notice that **is** the panel: a hairline in the level's colour, and that
 * colour at ten percent.
 *
 * This goes on the card itself — `<Card className={live ? noticeToneClass(level)
 * : "bg-muted/30"}>` — never on a box drawn inside one. The centre used to nest
 * it: a `rounded-md` bordered tint inside a `rounded-lg` bordered `Card`, so one
 * fact arrived with two hairlines and two radii, and the notice read as a card
 * that somebody had put another card in. Kirigami's `InlineMessage` is the
 * reference for the replacement: one pale rectangle, the level's own colour.
 *
 * The border is `/30` at every level. `warning` used to be `/40`, which made one
 * level's hairline heavier than the other three for no reason a reader could
 * see.
 */
const NOTICE_CLASS: Record<AnnouncementLevel, string> = {
  info: "border-info/30 bg-info/10",
  success: "border-success/30 bg-success/10",
  warning: "border-warning/30 bg-warning/10",
  danger: "border-destructive/30 bg-destructive/10",
};

/**
 * The wash without a hairline: for a notice that is already *inside* a bordered
 * panel and only needs to be a region of it.
 *
 * The docs catalog is the case — the newest active notice sits in the panel that
 * also carries the site's own name and description, and a second border around
 * it would draw a box inside a box for a block that is not one.
 */
const SURFACE_CLASS: Record<AnnouncementLevel, string> = {
  info: "bg-info/10",
  success: "bg-success/10",
  warning: "bg-warning/10",
  danger: "bg-destructive/10",
};

/**
 * The level's colour as foreground, for the icon that sits beside the title.
 *
 * The notice's own wash is too pale to tint text with, so the mark takes the
 * saturated end of the same colour instead. On the banner strip this is the whole
 * of the level's presence: the strip itself stays window chrome, and only the
 * mark carries the colour.
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

export function noticeSurfaceClass(level: AnnouncementLevel): string {
  return SURFACE_CLASS[level];
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

/**
 * The level as a chip. Needs no translation of its own: the caller labels it.
 *
 * The chip already carries the level's mark, so a surface that shows a chip does
 * not also draw a bare `LevelIcon` beside the title — that is the same fact twice
 * in a row (two warning triangles, side by side), and it was what the centre and
 * every detail page did. A surface picks one: the chip, or the mark on the
 * heading, not both.
 */
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