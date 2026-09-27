"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { TIMEZONE_OPTIONS } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import type { Timezone } from "@/lib/db/types";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";

export function TimezoneForm({ initialTimezone }: { initialTimezone: Timezone }) {
  const t = useT();
  const router = useRouter();
  const [timezone, setTimezone] = useState<Timezone>(initialTimezone);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const unchanged = timezone === initialTimezone;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          apiErrorMessage(t, data.error?.code, data.error?.message) ||
            t("settings.timezone.errorGeneric"),
        );
        return;
      }
      setSuccess(true);
      // Re-render the server components so the usage pages pick up the offset.
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.timezone.errorGeneric"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {TIMEZONE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-sm transition-colors",
              timezone === option.value
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name="timezone"
              value={option.value}
              checked={timezone === option.value}
              onChange={() => {
                setTimezone(option.value);
                setSuccess(false);
              }}
              className="h-4 w-4 border-input text-primary focus:ring-ring"
            />
            <span>{t(option.labelKey)}</span>
          </label>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.timezone.success")}</span>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="submit" loading={submitting} disabled={unchanged}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
