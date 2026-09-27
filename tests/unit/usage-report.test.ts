import { describe, it, expect } from "vitest";
import type { UsageLog } from "@/lib/db/types";
import {
  bucketOf,
  enumerateBuckets,
  fillSeries,
  group,
  resolveRange,
  series,
  summarize,
} from "@/lib/usage/report";

function log(over: Partial<UsageLog> = {}): UsageLog {
  const promptTokens = over.promptTokens ?? 0;
  const completionTokens = over.completionTokens ?? 0;
  return {
    id: over.id ?? "l",
    apiKeyId: over.apiKeyId ?? "k1",
    userId: over.userId ?? "u1",
    providerId: over.providerId ?? "p1",
    model: over.model ?? "m1",
    upstreamModel: over.upstreamModel ?? "m1",
    promptTokens,
    completionTokens,
    totalTokens: over.totalTokens ?? promptTokens + completionTokens,
    creditsUsed: over.creditsUsed ?? 0,
    status: over.status ?? "success",
    errorMessage: over.errorMessage ?? null,
    billingMode: over.billingMode,
    createdAt: over.createdAt ?? "2026-09-21T00:00:00.000Z",
  };
}

describe("summarize", () => {
  it("sums successful requests and ignores failures", () => {
    const logs = [
      log({ promptTokens: 10, completionTokens: 5, creditsUsed: 7 }),
      log({ promptTokens: 1, completionTokens: 1, creditsUsed: 2 }),
      log({ status: "error", promptTokens: 999, creditsUsed: 999 }),
    ];
    expect(summarize(logs)).toEqual({
      requests: 2,
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 17,
      creditsUsed: 9,
    });
  });

  it("respects an inclusive lower / exclusive upper bound", () => {
    const logs = [
      log({ createdAt: "2026-09-19T23:59:59.000Z" }),
      log({ createdAt: "2026-09-20T00:00:00.000Z" }),
      log({ createdAt: "2026-09-21T00:00:00.000Z" }),
    ];
    const from = "2026-09-20T00:00:00.000Z";
    const to = "2026-09-21T00:00:00.000Z";
    expect(summarize(logs, from, to).requests).toBe(1);
  });
});

describe("bucketOf / series (timezone)", () => {
  it("buckets by local day at a +08:00 offset", () => {
    expect(bucketOf("2026-09-21T15:59:00.000Z", "day", 480)).toBe("2026-09-21");
    expect(bucketOf("2026-09-21T16:00:00.000Z", "day", 480)).toBe("2026-09-22");
  });

  it("buckets by local hour at a +08:00 offset", () => {
    expect(bucketOf("2026-09-21T16:30:00.000Z", "hour", 480)).toBe("2026-09-22T00");
  });

  it("aggregates logs into ascending day points", () => {
    const points = series(
      [
        log({ createdAt: "2026-09-22T01:00:00.000Z", totalTokens: 30, creditsUsed: 3 }),
        log({ createdAt: "2026-09-21T01:00:00.000Z", totalTokens: 10, creditsUsed: 1 }),
        log({ createdAt: "2026-09-22T02:00:00.000Z", totalTokens: 20, creditsUsed: 2 }),
      ],
      "day",
      480,
    );
    expect(points.map((p) => p.bucket)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(points[1]).toMatchObject({ requests: 2, totalTokens: 50, creditsUsed: 5 });
  });
});

describe("group", () => {
  it("groups by model, biggest spender first", () => {
    const rows = group(
      [
        log({ model: "a", creditsUsed: 1 }),
        log({ model: "b", creditsUsed: 9 }),
        log({ model: "b", creditsUsed: 1, totalTokens: 5 }),
      ],
      "model",
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ requests: 2, creditsUsed: 10, totalTokens: 5 });
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-09-27T05:00:00.000Z"); // 13:00 at +08:00
  const tz = 480;

  it("7d spans the last seven local days, exclusive of tomorrow", () => {
    expect(resolveRange({ key: "7d", tzOffsetMinutes: tz, now })).toEqual({
      key: "7d",
      fromIso: "2026-09-20T16:00:00.000Z",
      toIso: "2026-09-27T16:00:00.000Z",
      grain: "day",
    });
  });

  it("today is a 24-bucket hour range", () => {
    const r = resolveRange({ key: "today", tzOffsetMinutes: tz, now });
    expect(r).toEqual({
      key: "today",
      fromIso: "2026-09-26T16:00:00.000Z",
      toIso: "2026-09-27T16:00:00.000Z",
      grain: "hour",
    });
    expect(enumerateBuckets(r, tz)).toHaveLength(24);
  });

  it("all has no bounds", () => {
    expect(resolveRange({ key: "all", tzOffsetMinutes: tz, now })).toEqual({
      key: "all",
      grain: "day",
    });
  });

  it("custom single day uses the hour grain", () => {
    const r = resolveRange({
      key: "custom",
      from: "2026-09-01",
      to: "2026-09-01",
      tzOffsetMinutes: tz,
    });
    expect(r.grain).toBe("hour");
    expect(enumerateBuckets(r, tz)).toHaveLength(24);
  });

  it("custom multi-day uses the day grain", () => {
    const r = resolveRange({
      key: "custom",
      from: "2026-08-01",
      to: "2026-08-30",
      tzOffsetMinutes: tz,
    });
    expect(r.grain).toBe("day");
    expect(enumerateBuckets(r, tz)).toHaveLength(30);
  });

  it("unknown key with no dates falls back to the default range", () => {
    expect(resolveRange({ key: "nonsense", tzOffsetMinutes: tz, now }).key).toBe("7d");
    expect(resolveRange({ tzOffsetMinutes: tz, now }).key).toBe("7d");
  });
});

describe("fillSeries", () => {
  it("inserts zero buckets for missing days", () => {
    const range = resolveRange({
      key: "custom",
      from: "2026-09-01",
      to: "2026-09-03",
      tzOffsetMinutes: 480,
    });
    const filled = fillSeries(
      [
        {
          bucket: "2026-09-02",
          requests: 1,
          promptTokens: 3,
          completionTokens: 1,
          totalTokens: 4,
          creditsUsed: 2,
        },
      ],
      range,
      480,
    );
    expect(filled.map((p) => p.bucket)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    expect(filled[0].creditsUsed).toBe(0);
    expect(filled[1].creditsUsed).toBe(2);
  });
});
