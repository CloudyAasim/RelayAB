import { describe, it, expect } from "vitest";
import {
  TIMEZONE_OPTIONS,
  timezoneLabelKey,
  timezoneOffsetMinutes,
  timezoneToIana,
} from "@/lib/timezone";
import { formatDate } from "@/lib/utils";

describe("timezone helpers", () => {
  it("maps stored values to offsets, defaulting to Shanghai (UTC+8)", () => {
    expect(timezoneOffsetMinutes("utc")).toBe(0);
    expect(timezoneOffsetMinutes("shanghai")).toBe(480);
    expect(timezoneOffsetMinutes(undefined)).toBe(480);
    expect(timezoneOffsetMinutes(null)).toBe(480);
  });

  it("maps stored values to label keys, defaulting to Shanghai", () => {
    expect(timezoneLabelKey("utc")).toBe("timezone.utc");
    expect(timezoneLabelKey("shanghai")).toBe("timezone.shanghai");
    expect(timezoneLabelKey(undefined)).toBe("timezone.shanghai");
  });

  it("offers exactly the two supported timezones, default first, with distinct labels", () => {
    expect(TIMEZONE_OPTIONS.map((option) => option.value)).toEqual([
      "shanghai",
      "utc",
    ]);
    expect(new Set(TIMEZONE_OPTIONS.map((option) => option.labelKey)).size).toBe(2);
    expect(new Set(TIMEZONE_OPTIONS.map((option) => option.offsetMinutes))).toEqual(
      new Set([480, 0]),
    );
  });

  it("maps to IANA names for Intl formatting, defaulting to Shanghai", () => {
    expect(timezoneToIana("utc")).toBe("UTC");
    expect(timezoneToIana("shanghai")).toBe("Asia/Shanghai");
    expect(timezoneToIana(undefined)).toBe("Asia/Shanghai");
  });
});

describe("formatDate with a timezone", () => {
  const iso = "2026-09-27T16:30:00.000Z"; // 00:30 next day in Shanghai

  it("renders the timestamp in the requested zone on a 24-hour clock", () => {
    expect(formatDate(iso, "UTC")).toContain("Sep 27");
    expect(formatDate(iso, "Asia/Shanghai")).toContain("Sep 28");

    // 16:30Z = 16:30 UTC and 00:30 next day in Shanghai, with no AM/PM suffix.
    expect(formatDate(iso, "UTC")).toContain("16:30");
    expect(formatDate(iso, "Asia/Shanghai")).toContain("00:30");
    expect(formatDate(iso, "UTC")).not.toMatch(/\b(AM|PM)\b/);
    expect(formatDate(iso, "Asia/Shanghai")).not.toMatch(/\b(AM|PM)\b/);
  });

  it("still handles missing values", () => {
    expect(formatDate(null, "UTC")).toBe("—");
    expect(formatDate(undefined, "Asia/Shanghai")).toBe("—");
  });
});
