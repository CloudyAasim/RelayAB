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
  type ProviderFormValues,
  type ProviderPayloadOptions,
  type ProviderRecord,
} from "@/lib/admin/provider-payload";
import { rowsFromProvider, type ProviderModelRow } from "@/app/(admin)/admin/providers/model-rows";
import type { ProviderFacesValue } from "@/app/(admin)/admin/providers/ProviderFacesField";
import { validateTextSpecs, activeModeOf } from "@/lib/protocol/text-specs";

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
    activeMode: "simple",
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
    // The stored choice, resolved by the same function the engine uses. A row
    // with no choice and a rule on it opens in advanced, which is what it has
    // been doing — the editor does not get a second opinion.
    activeMode: activeModeOf(provider),
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
  /**
   * The mode is read off `values`, not held beside it.
   *
   * It used to be a second `useState` that the payload never read — so moving
   * the switch changed nothing about what was saved, and the only honest reading
   * of the old screen was "this is a view mode". It is now a value: loaded from
   * the row, sent on save, resolved by the same `activeModeOf` the engine uses.
   * There is a `setMode` here still, because two call sites change it, but it
   * writes to `values` and there is nothing left for it to fall out of sync
   * with.
   *
   * A second `initialMode` parameter went with it. Nothing passed it, and a
   * parameter that sets a mode the row also sets is a third thing to keep
   * right — the exact shape of the drift this file exists to prevent.
   */
  const mode = values.activeMode;
  const setMode = useCallback(
    (next: "simple" | "advanced") => setValues((prev) => ({ ...prev, activeMode: next })),
    [],
  );

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
    // The mode resets with everything else — it is one of the values, and
    // `emptyFormValues` already says simple.
    setValues(next);
  }, []);

  const load = useCallback((provider: ProviderRecord) => {
    setValues(formValuesFromProvider(provider));
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
