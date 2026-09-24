"use client";

/**
 * Model-row editor shared by the provider create form and the edit modal.
 *
 * The two used to be separate tables that drifted apart: the edit modal could
 * only set the upstream→client mapping (no context window, output cap or credit
 * cost), and it keyed each row by the **client model id** — the field the user
 * types into. React keys are identity, so changing that key unmounted and
 * remounted the row on every keystroke: focus was lost, the caret jumped, and
 * IME composition broke.
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

  const columns = [
    t("admin.providers.create.clientModel"),
    t("admin.providers.create.upstreamModel"),
    t("admin.providers.create.contextLength"),
    t("admin.providers.create.maxOutput"),
    t("admin.providers.create.inputCost"),
    t("admin.providers.create.outputCost"),
  ];

  const cell = "rounded border bg-transparent px-1 py-0.5";

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

      <div className="max-h-72 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {columns.map((label) => (
                <th key={label} className="px-2 py-1.5 text-left font-medium">
                  {label}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                  {t("admin.providers.create.noMappings")}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const duplicated = duplicates.includes(row.clientId.trim());
                return (
                  // Keyed by the row's own id, NOT by `row.clientId`: the client
                  // model id is editable, so keying by it would remount this row
                  // on every keystroke and drop focus.
                  <tr key={row.id}>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        value={row.clientId}
                        onChange={(e) => update(index, { clientId: e.target.value })}
                        placeholder="gpt-4o"
                        className={`w-full font-mono ${cell} ${
                          duplicated ? "border-destructive" : ""
                        }`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        value={row.upstreamId}
                        onChange={(e) => update(index, { upstreamId: e.target.value })}
                        placeholder="gpt-4o-2024-08-06"
                        className={`w-full font-mono ${cell}`}
                      />
                    </td>
                    {(
                      [
                        ["contextLength", "w-24", undefined],
                        ["maxOutputTokens", "w-24", undefined],
                        ["inputCost", "w-20", undefined],
                        ["outputCost", "w-20", undefined],
                      ] as const
                    ).map(([field, width, placeholder]) => (
                      <td key={field} className="px-1 py-1">
                        <input
                          type="number"
                          value={row[field]}
                          onChange={(e) => update(index, { [field]: Number(e.target.value) })}
                          placeholder={placeholder ?? undefined}
                          className={`${width} ${cell}`}
                        />
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="text-muted-foreground hover:text-destructive"
                        title={t("common.delete")}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
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
