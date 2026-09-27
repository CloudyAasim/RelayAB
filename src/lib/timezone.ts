/**
 * src/lib/timezone.ts
 *
 * Fixed-offset display timezones. The app only needs two, so we avoid pulling
 * in a full IANA/tz database: `shanghai` = UTC+8 (the default) and `utc` = UTC+0.
 *
 * Every reader that turns a stored (possibly absent) preference into an offset
 * or a label must go through here, so the default lives in exactly one place.
 */
import type { Timezone } from "@/lib/db/types";

export interface TimezoneOption {
  value: Timezone;
  /** i18n key for the human label. */
  labelKey: string;
  /** Fixed UTC offset in minutes. */
  offsetMinutes: number;
}

/** Display order: the default (Shanghai) first. */
export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
  { value: "shanghai", labelKey: "timezone.shanghai", offsetMinutes: 480 },
  { value: "utc", labelKey: "timezone.utc", offsetMinutes: 0 },
];

/** Offset for a stored preference; missing/unknown falls back to Shanghai. */
export function timezoneOffsetMinutes(timezone: Timezone | null | undefined): number {
  return timezone === "utc" ? 0 : 480;
}

/** i18n label key for a stored preference; missing/unknown falls back to Shanghai. */
export function timezoneLabelKey(timezone: Timezone | null | undefined): string {
  return timezone === "utc" ? "timezone.utc" : "timezone.shanghai";
}

export type TimezoneIana = "UTC" | "Asia/Shanghai";

/** IANA zone name for `Intl` date formatting; missing/unknown → Shanghai. */
export function timezoneToIana(timezone: Timezone | null | undefined): TimezoneIana {
  return timezone === "utc" ? "UTC" : "Asia/Shanghai";
}
