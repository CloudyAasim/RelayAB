"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { useT } from "@/components/i18n/I18nProvider";
import type { ModelGroup, ModelGroupKind } from "@/lib/admin/model-groups";
import { groupAllowedModels } from "@/lib/admin/model-groups";
import { ChevronDown } from "lucide-react";

/**
 * The heading of one model group.
 *
 * Written as literal `t()` calls rather than a template string: the i18n guard
 * reads call sites, and a key it cannot see is a key nothing checks — a typo in
 * it would render as the raw key on the page and no test would say so.
 */
export function groupLabel(t: (key: string) => string, kind: ModelGroupKind): string {
  switch (kind) {
    case "chat":
      return t("models.summary.group.chat");
    case "embedding":
      return t("models.summary.group.embedding");
    case "rerank":
      return t("models.summary.group.rerank");
    case "moderation":
      return t("models.summary.group.moderation");
    case "image":
      return t("models.summary.group.image");
    case "video":
      return t("models.summary.group.video");
    case "tts":
      return t("models.summary.group.tts");
    case "stt":
      return t("models.summary.group.stt");
    case "translate":
      return t("models.summary.group.translate");
    case "music":
      return t("models.summary.group.music");
  }
}

/**
 * An account's allowed models, as a count with the names behind it.
 *
 * A deployment with a dozen text models and a few media ones gives an account a
 * list that wraps over three lines wherever it is printed in full — stretching
 * the admin row it sits in and pushing the account's keys below the fold on the
 * dashboard. Callers get the count; the names live in a menu, grouped by kind —
 * the same grouping the picker uses, so the two never disagree about what a
 * model is.
 *
 * Shared by the admin users table and the account's own dashboard. `align` is
 * the caller's, because each of those sits in a different column and the menu
 * must open inward rather than off the edge of a phone.
 */
export function AllowedModelsSummary({
  allowedModels,
  groups,
  align = "end",
}: {
  allowedModels: string[];
  groups: ModelGroup[];
  align?: "start" | "center" | "end";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // "Every model" is stored as an empty array, so the summary has to say so.
  if (allowedModels.length === 0) {
    return <span className="font-normal">{t("models.summary.allModels")}</span>;
  }

  // The kinds this account actually has, and the models the catalogue no
  // longer knows about but the account can still call.
  const { groups: used, others: orphans } = groupAllowedModels(allowedModels, groups);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("models.summary.count", { count: allowedModels.length })}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="max-h-80 w-72 overflow-y-auto p-2">
        {used.map((group) => (
          <section key={group.kind} className="space-y-1 py-1">
            <h4 className="px-1 text-xs font-medium text-muted-foreground">
              {groupLabel(t, group.kind)}
              <span className="ml-1.5 font-normal text-muted-foreground/70">
                {group.models.length}
              </span>
            </h4>
            <ul className="space-y-1">
              {group.models.map((model) => (
                <li key={model} className="truncate px-1 font-mono text-xs text-foreground">
                  {model}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {orphans.length > 0 && (
          <section className="space-y-1 py-1">
            <h4 className="px-1 text-xs font-medium text-muted-foreground">
              {t("models.summary.other")}
            </h4>
            <ul className="space-y-1">
              {orphans.map((model) => (
                <li key={model} className="truncate px-1 font-mono text-xs text-foreground">
                  {model}
                </li>
              ))}
            </ul>
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}
