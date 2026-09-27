"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

const PRESETS = ["today", "7d", "30d", "90d", "all"] as const;

interface Props {
  active: string;
  from?: string;
  to?: string;
  /** Query params to preserve when switching range (e.g. an admin user filter). */
  keep?: Record<string, string | undefined>;
}

/**
 * Date-range control for the usage screens. Server components read the range
 * from `searchParams`; this only rewrites the URL, so refreshing or sharing a
 * link reproduces exactly the same report.
 */
export function UsageRangePicker({ active, from, to, keep = {} }: Props) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [fromValue, setFromValue] = useState(from ?? "");
  const [toValue, setToValue] = useState(to ?? "");

  function navigate(params: Record<string, string | undefined>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...keep, ...params })) {
      if (value) query.set(key, value);
    }
    const qs = query.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={active === preset ? "default" : "outline"}
            onClick={() => navigate({ range: preset, from: undefined, to: undefined })}
          >
            {t(`usage.range.${preset}`)}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("usage.range.from")}
          <input
            type="date"
            value={fromValue}
            onChange={(event) => setFromValue(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("usage.range.to")}
          <input
            type="date"
            value={toValue}
            onChange={(event) => setToValue(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant={active === "custom" ? "default" : "secondary"}
          onClick={() =>
            navigate({
              range: "custom",
              from: fromValue || undefined,
              to: toValue || undefined,
            })
          }
        >
          {t("usage.range.apply")}
        </Button>
      </div>
    </div>
  );
}
