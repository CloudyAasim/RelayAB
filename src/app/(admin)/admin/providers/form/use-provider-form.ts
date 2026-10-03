"use client";

/**
 * src/app/(admin)/admin/providers/form/use-provider-form.ts
 *
 * The state behind both provider forms.
 *
 * The create modal and the edit modal used to declare the same ten pieces of
 * state, run the same `validateTextSpecs` guard, and hand-roll the same payload.
 * They are one form; this hook is that form, and the two modals are the request
 * they send and the chrome around them.
 */
import { useCallback, useState } from "react";
import {
  buildProviderPayload,
  facesFromProvider,
  headersToText,
  modeForProvider,
  type ProviderFormValues,
  type ProviderPayloadOptions,
  type ProviderRecord,
} from "@/lib/admin/provider-payload";
import { rowsFromProvider, type ProviderModelRow } from "@/app/(admin)/admin/providers/model-rows";
import type { ProviderFacesValue } from "@/app/(admin)/admin/providers/ProviderFacesField";
import { validateTextSpecs } from "@/lib/protocol/text-specs";

const EMPTY_MODEL_ROWS: ProviderModelRow[] = [];

/** The state a new provider starts from. */
export function emptyFormValues(): ProviderFormValues {
  return {
    name: "",
    kind: "openai",
    baseUrl: "",
    apiKey: "",
    priority: "1",
    enabled: true,
    headers: "",
    faces: {
      openaiEnabled: true,
      upstreamFormat: "responses",
      anthropicEnabled: false,
      anthropicBaseUrl: "",
    },
    modelRows: EMPTY_MODEL_ROWS,
    textSpecs: [],
  };
}

export function formValuesFromProvider(provider: ProviderRecord): ProviderFormValues {
  return {
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    apiKey: "",
    priority: String(provider.priority ?? "1"),
    enabled: provider.enabled,
    headers: headersToText(provider.headers),
    faces: facesFromProvider(provider),
    modelRows: rowsFromProvider(provider.modelMapping, provider.modelConfigs),
    textSpecs: provider.textSpecs ?? [],
  };
}

export function useProviderForm(
  // Lazy, because the edit modal stays mounted while closed and re-reading a
  // row's model table on every render of the page behind it is work nobody
  // asked for.
  initial: ProviderFormValues | (() => ProviderFormValues) = emptyFormValues,
) {
  const [values, setValues] = useState<ProviderFormValues>(() =>
    typeof initial === "function" ? initial() : initial,
  );
  const [mode, setMode] = useState<"simple" | "advanced">(() => {
    const start = typeof initial === "function" ? initial() : initial;
    return start.textSpecs.length ? "advanced" : "simple";
  });

  /** Patch any subset. A new provider object each time, so no key is missed. */
  const patch = useCallback((next: Partial<ProviderFormValues>) => {
    setValues((prev) => ({ ...prev, ...next }));
  }, []);

  const setFaces = useCallback(
    (faces: ProviderFacesValue) => setValues((prev) => ({ ...prev, faces })),
    [],
  );
  // Updater form, so a caller can merge into what is on screen without having
  // to own the previous value.
  const setModelRows = useCallback(
    (next: ProviderModelRow[] | ((prev: ProviderModelRow[]) => ProviderModelRow[])) =>
      setValues((prev) => ({
        ...prev,
        modelRows: typeof next === "function" ? next(prev.modelRows) : next,
      })),
    [],
  );
  const setTextSpecs = useCallback(
    (next: string[] | ((prev: string[]) => string[])) =>
      setValues((prev) => ({
        ...prev,
        textSpecs: typeof next === "function" ? next(prev.textSpecs) : next,
      })),
    [],
  );

  const specVerdict = validateTextSpecs(values.textSpecs);

  /** The protocols a spec document is already written for, for the warnings. */
  const configuredProtocols = values.textSpecs.map((raw) => {
    try {
      return (JSON.parse(raw) as { protocol?: string }).protocol ?? "";
    } catch {
      return "";
    }
  });

  const reset = useCallback((next: ProviderFormValues = emptyFormValues()) => {
    setValues(next);
    setMode(next.textSpecs.length ? "advanced" : "simple");
  }, []);

  const load = useCallback((provider: ProviderRecord) => {
    const next = formValuesFromProvider(provider);
    setValues(next);
    setMode(modeForProvider(provider));
  }, []);

  /**
   * The one body both modals send. The differences between creating and
   * editing are named options, so neither call site re-derives the field set.
   */
  const buildPayload = useCallback(
    (options: ProviderPayloadOptions = {}) => buildProviderPayload(values, options),
    [values],
  );

  return {
    values,
    patch,
    setFaces,
    setModelRows,
    setTextSpecs,
    mode,
    setMode,
    specVerdict,
    configuredProtocols,
    reset,
    load,
    buildPayload,
  };
}

export type ProviderForm = ReturnType<typeof useProviderForm>;
