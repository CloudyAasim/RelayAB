"use client";

/**
 * src/app/(admin)/admin/providers/form/ProviderForm.tsx
 *
 * The provider form, rendered once.
 *
 * Both modals used to spell this out in full — the same fields, in two orders,
 * with two different field sets. That is what let the edit modal hide the API
 * key in advanced mode and what left `headers` editable only at creation. The
 * order below is the one both use now; the two remaining differences are slots
 * rather than copies.
 *
 * Slots, not forks:
 *  - `aboveFields` — the create-only template picker, which edits the same
 *    values through `form.patch`.
 *  - `models*` — how the model list is refreshed and labelled, which is the one
 *    thing that genuinely differs (create fetches with the typed-in key, edit
 *    fetches with the stored one).
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { ProviderModeSwitch } from "@/app/(admin)/admin/providers/ProviderModeSwitch";
import {
  ProviderInterfacesField,
  judgeTextSpec,
} from "@/app/(admin)/admin/providers/ProviderInterfacesField";
import { ProviderModelsEditor } from "@/app/(admin)/admin/providers/ProviderModelsEditor";
import type { ProviderModelRow } from "@/app/(admin)/admin/providers/model-rows";
import type { ProviderForm } from "./use-provider-form";

export function ProviderForm({
  form,
  aboveFields,
  modelsActions,
  modelsHint,
  newRowDefaults,
  apiKeyPlaceholder,
  baseUrlRequired = true,
  apiKeyRequired = true,
}: {
  form: ProviderForm;
  /** Inserted before the provider's own fields (the template picker). */
  aboveFields?: ReactNode;
  modelsActions?: ReactNode;
  modelsHint?: ReactNode;
  newRowDefaults?: { contextLength: number; maxOutputTokens: number };
  apiKeyPlaceholder?: string;
  /** Edit never demands them: a stored key stays valid when the field is blank. */
  baseUrlRequired?: boolean;
  apiKeyRequired?: boolean;
}) {
  const t = useT();
  const { values, patch, setFaces, setModelRows, setTextSpecs, mode, setMode, specVerdict } = form;

  return (
    <>
      <ProviderModeSwitch mode={mode} onChange={setMode} interfaceCount={values.textSpecs.length} />

      {/*
        One block for "which interfaces answer" and "what happens to their
        parameters". These were a pair of checkboxes and a sibling list over
        the same three interfaces, which is how the OpenAI side could be
        switched off while the list still offered to add /v1/responses. The
        rules now live inside the face that gates them, so that state is not
        expressible.
      */}
      <ProviderInterfacesField
        value={values.faces}
        onChange={setFaces}
        textSpecs={values.textSpecs}
        onTextSpecsChange={setTextSpecs}
        showRules={mode === "advanced"}
      />

      {aboveFields}

      <div className="grid grid-cols-2 gap-4">
        <Input
          label={t("admin.providers.create.name")}
          value={values.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t("admin.providers.create.namePlaceholder")}
          required
        />

        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {t("admin.providers.table.kind")}
          </label>
          <select
            value={values.kind}
            onChange={(e) => patch({ kind: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="custom-openai">custom-openai</option>
            <option value="azure">azure</option>
          </select>
        </div>
      </div>

      <Input
        label={t("admin.providers.create.baseUrl")}
        value={values.baseUrl}
        onChange={(e) => patch({ baseUrl: e.target.value })}
        placeholder="https://api.openai.com/v1"
        required={baseUrlRequired}
      />

      <Input
        label={
          apiKeyRequired
            ? t("admin.providers.create.apiKey")
            : `${t("admin.providers.create.apiKey")} (${t("admin.providers.edit.leaveBlank")})`
        }
        type="password"
        value={values.apiKey}
        onChange={(e) => patch({ apiKey: e.target.value })}
        placeholder={apiKeyPlaceholder ?? "sk-..."}
        required={apiKeyRequired}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label={t("admin.providers.create.priority")}
          type="number"
          value={values.priority}
          onChange={(e) => patch({ priority: e.target.value })}
        />

        <label className="flex items-center gap-2 pt-6 text-sm">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="rounded w-4 h-4"
          />
          {t("admin.providers.create.enabled")}
        </label>
      </div>

      {/*
        Headers were create-only. A request header set at creation could not be
        changed afterwards by any UI, because the edit modal had no field for it
        and did not send the key. Both forms now carry it.
      */}
      <div>
        <label className="block text-sm font-medium mb-1.5">
          {t("admin.providers.create.headers")}
        </label>
        <textarea
          value={values.headers}
          onChange={(e) => patch({ headers: e.target.value })}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          placeholder="api-version: 2024-08-01-preview"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t("admin.providers.create.headersHint")}</p>
      </div>

      <ProviderModelsEditor
        rows={values.modelRows as ProviderModelRow[]}
        onChange={setModelRows}
        newRowDefaults={newRowDefaults}
        actions={modelsActions}
        hint={modelsHint ?? t("admin.providers.syncHint")}
      />

      {!specVerdict.ok && mode !== "advanced" && (
        <p className="text-sm text-destructive">{specVerdict.errors[0]}</p>
      )}
    </>
  );
}
