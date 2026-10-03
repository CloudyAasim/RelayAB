"use client";

/**
 * src/app/(admin)/admin/providers/ProviderModeSwitch.tsx
 *
 * Two modes, as cards, because a pill does not say which one you are in.
 *
 * The complaint that produced this was that you could not tell which mode was
 * open. The previous version was a two-segment pill whose pressed state was a
 * background tint, which is not a thing anybody reads.
 *
 * The mode is **additive**: both fill in the same fields, and advanced adds the
 * per-interface parameter rules. It is not a choice between two different
 * forms — that spelling, where the branch wrapped the whole form, is what once
 * hid the API key in advanced mode.
 */
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

export function ProviderModeSwitch({
  mode,
  onChange,
  interfaceCount,
}: {
  mode: "simple" | "advanced";
  onChange: (mode: "simple" | "advanced") => void;
  /** How many interfaces have a rule written, for the advanced card. */
  interfaceCount: number;
}) {
  const t = useT();
  const card = (id: "simple" | "advanced", title: string, body: string, badge: string | null) => {
    const on = mode === id;
    return (
      <button
        type="button"
        onClick={() => onChange(id)}
        aria-pressed={on}
        className={
          on
            ? "flex-1 rounded-lg border-2 border-primary bg-primary/5 p-3 text-left"
            : "flex-1 rounded-lg border-2 border-border p-3 text-left hover:border-muted-foreground/40"
        }
      >
        <div className="flex items-center gap-2">
          <span
            className={
              on
                ? "flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground"
                : "flex h-4 w-4 items-center justify-center rounded-full border border-border"
            }
            aria-hidden
          >
            {on ? "●" : ""}
          </span>
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge && (
            <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 pl-6 text-xs text-muted-foreground">{body}</p>
      </button>
    );
  };

  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">{t("admin.textSpec.modeHint")}</p>
      <div className="flex gap-2">
        {card(
          "simple",
          t("admin.textSpec.mode.simple"),
          t("admin.textSpec.mode.simpleBody"),
          mode === "simple" ? t("admin.textSpec.mode.current") : null,
        )}
        {card(
          "advanced",
          t("admin.textSpec.mode.advanced"),
          t("admin.textSpec.mode.advancedBody"),
          mode === "advanced"
            ? t("admin.textSpec.mode.current")
            : interfaceCount > 0
              ? t("admin.textSpec.mode.configured", { n: interfaceCount })
              : null,
        )}
      </div>
    </div>
  );
}
