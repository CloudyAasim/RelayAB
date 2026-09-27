import { describe, it, expect } from "vitest";
import {
  TIMEZONE_OPTIONS,
  timezoneLabelKey,
  timezoneOffsetMinutes,
} from "@/lib/timezone";

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
});
