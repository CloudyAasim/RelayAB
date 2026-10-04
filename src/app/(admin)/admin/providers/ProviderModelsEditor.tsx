"use client";

/**
 * src/app/(admin)/admin/providers/ProviderModelsEditor.tsx
 *
 * Model-row editor shared by the provider create form and the edit modal.
 *
 * The two used to be separate tables that drifted apart: the edit modal could
 * only set the upstream→client mapping (no context window, output cap or credit
 * cost), and it keyed each row by the **client model id** — the field the user
 * types into. React keys are identity, so changing that key unmounted and
 * remounted the row on every keystroke: focus was lost, the caret jumped, and
 * IME composition broke.
 *
 * **One cell per model, not one column per field.** This was a table with a
 * column per value — eight of them once the two cache prices arrived, which is
 * more than the edit modal has to give. It scrolled sideways, and a price you
 * have to scroll to find is a price nobody sets. So a model is a block: the two
 * ids on the first line, the six numbers on the second, each carrying its own
 * label, wrapping rather than overflowing. Which is also why there is no header
 * row: a header earns its place by naming columns, and there are no columns.
 *
 * Row state lives in `./model-rows` (plain data, unit-tested); this file only
 * renders it. Note `key={row.id}` below — never key by an editable value.
 */
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import {
  duplicateClientIds,
  newModelRow,
  type ProviderModelRow,
} from "./model-rows";

export function ProviderModelsEditor({
  rows,
  onChange,
  actions,
  hint,
  newRowDefaults,
  className,
}: {
  rows: ProviderModelRow[];
  onChange: (rows: ProviderModelRow[]) => void;
  /** Extra controls for the header row (e.g. the create form's auto-fetch). */
  actions?: React.ReactNode;
  hint?: React.ReactNode;
  /** Defaults for rows added via the "+" button (e.g. template context size). */
  newRowDefaults?: Partial<Omit<ProviderModelRow, "id">>;
  className?: string;
}) {
  const t = useT();
  const duplicates = duplicateClientIds(rows);

  const update = (index: number, patch: Partial<ProviderModelRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const remove = (index: number): void => {
    onChange(rows.filter((_, i) => i !== index));
  };

  const cell = "rounded border bg-transparent px-1 py-0.5";
  const box = "w-20";

  /**
   * One labelled number. The label is inside the control rather than above it,
   * which is what lets the row wrap without the numbers losing their names.
   */
  const numberField = (
    index: number,
    label: string,
    key_: "contextLength" | "maxOutputTokens" | "inputCost" | "outputCost",
  ) => (
    <label key={key_} className="flex items-center gap-1">
      <span className="whitespace-nowrap text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        value={rows[index][key_]}
        onChange={(e) => update(index, { [key_]: Number(e.target.value) })}
        className={`${box} ${cell}`}
      />
    </label>
  );

  /**
   * The cache prices, which is why this is a second function rather than a
   * third entry in the list above: blank and zero are different answers here.
   * `Number("")` is 0, and 0 means "this cache is free", so a box nobody
   * touched would quietly reprice every cached request to nothing.
   */
  const cacheField = (
    index: number,
    label: string,
    key_: "cachedInputCost" | "cacheWriteCost",
  ) => (
    <label key={key_} className="flex items-center gap-1">
      <span className="whitespace-nowrap text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        value={rows[index][key_] ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          update(index, { [key_]: raw === "" ? undefined : Number(raw) });
        }}
        placeholder={t("admin.providers.create.cachedInputCostSame")}
        title={t("admin.providers.models.cacheCostHint")}
        className={`${box} ${cell}`}
      />
    </label>
  );

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="block text-sm font-medium">
          {t("admin.providers.create.models")}
        </label>
        <div className="flex gap-2">
          {actions}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange([...rows, newModelRow(newRowDefaults)])}
          >
            + {t("admin.providers.create.addRow")}
          </Button>
        </div>
      </div>
      {hint && <p className="mb-2 text-xs text-muted-foreground">{hint}</p>}

      <div className="max-h-96 overflow-y-auto rounded-md border">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("admin.providers.create.noMappings")}
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((row, index) => {
              const duplicated = duplicates.includes(row.clientId.trim());
              return (
                // Keyed by the row's own id, NOT by `row.clientId`: the client
                // model id is editable, so keying by it would remount this row
                // on every keystroke and drop focus.
                <li key={row.id} className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.clientId}
                      onChange={(e) => update(index, { clientId: e.target.value })}
                      placeholder="gpt-4o"
                      className={`min-w-0 flex-1 font-mono ${cell} ${
                        duplicated ? "border-destructive" : ""
                      }`}
                    />
                    <span className="text-[10px] text-muted-foreground">→</span>
                    <input
                      type="text"
                      value={row.upstreamId}
                      onChange={(e) => update(index, { upstreamId: e.target.value })}
                      placeholder="gpt-4o-2024-08-06"
                      className={`min-w-0 flex-1 font-mono ${cell}`}
                    />
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="shrink-0 px-1 text-muted-foreground hover:text-destructive"
                      title={t("common.delete")}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Wraps, so a narrow modal gets a taller row rather than a
                      price column that has scrolled out of sight. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-1">
                    {numberField(index, t("admin.providers.create.contextLength"), "contextLength")}
                    {numberField(index, t("admin.providers.create.maxOutput"), "maxOutputTokens")}
                    {numberField(index, t("admin.providers.create.inputCost"), "inputCost")}
                    {numberField(index, t("admin.providers.create.outputCost"), "outputCost")}
                    {cacheField(index, t("admin.providers.create.cachedInputCost"), "cachedInputCost")}
                    {cacheField(index, t("admin.providers.create.cacheWriteCost"), "cacheWriteCost")}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {duplicates.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {t("admin.providers.models.duplicate", { ids: duplicates.join(", ") })}
        </p>
      )}
    </div>
  );
}
