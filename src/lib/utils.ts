/**
 * src/lib/utils.ts
 *
 * Tiny shared utilities.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { unitsToCredits } from "./quota/credits";

/**
 * Standard `cn` helper: clsx + tailwind-merge so duplicate Tailwind
 * classes get resolved correctly (last one wins).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a 积分 amount stored in integer 0.001-积分 units.
 *
 * Whole amounts render as "500"; fractional amounts keep up to 3 decimals
 * ("1.234", "0.001") so tiny requests stay visible without noise.
 */
export function formatCredits(units: number): string {
  const credits = unitsToCredits(units);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(credits);
}

/**
 * Format credits with floor (round down) — for remaining/balance display.
 * 4.1 and 4.8 both display as "4".
 * This avoids visual confusion between decimal points and thousand-separators.
 */
export function formatCreditsFloor(units: number): string {
  const credits = unitsToCredits(units);
  const floored = Math.floor(credits);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(floored);
}

/**
 * Format credits with ceiling (round up) — for consumed/used display.
 * 4.1 and 4.8 both display as "5".
 * Shows users what they've potentially spent, not less.
 */
export function formatCreditsCeil(units: number): string {
  const credits = unitsToCredits(units);
  const ceiled = Math.ceil(credits);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(ceiled);
}

/**
 * Compare two pieces of text the same way on every machine.
 *
 * `localeCompare` with no locale follows the **ambient** locale, and the
 * ambient locale is not the same everywhere: on a machine with a Chinese
 * locale it sorts by pinyin, and on the CI runner — which has no UTF-8
 * locale set — it falls back to code point order. The same deployment
 * therefore showed its pages in two different orders depending on where it
 * ran, and the test that pinned the order only ever saw the one its own
 * machine produced.
 *
 * So: compare the lower-cased strings by code point. That is the same answer
 * on every platform and every Node build, it is case-insensitive for Latin
 * text (so "apple" sorts before "Banana", as a reader expects), and for
 * Chinese it is a stable order rather than a pinyin order that only some
 * machines agree on.
 */
export function compareText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

/** Format a number with thousand separators. */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD, HH:mm` (24-hour, log-friendly and
 * unambiguous for a Chinese-first UI).
 *
 * Pass `timeZone` (an IANA name such as "UTC" or "Asia/Shanghai") to render the
 * timestamp in the user's chosen display timezone. Omitted, the runtime's own
 * zone is used.
 *
 * Built from `formatToParts` rather than a locale string, so the separator and
 * field order cannot drift with the runtime's locale data.
 */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // 24-hour clock (h23 keeps midnight at 00:00 rather than 24:00).
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}, ${get("hour")}:${get("minute")}`;
}
