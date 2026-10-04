"use client";

/**
 * src/app/(admin)/admin/providers/ModelPickerModal.tsx
 *
 * "Fetch models" asked, then answered for you.
 *
 * Both call sites — the create form and the edit modal — took everything the
 * upstream returned and appended it. A vendor with sixty models put sixty rows
 * into the form, sixty times over on a second fetch, and the only way back was
 * to delete them one at a time. Fetching a list and materialising it are two
 * different decisions, and only the first one was ever asked.
 *
 * So this is the second one: a list of what the vendor serves, with what it said
 * about each, and a button that adds the ticked ones. Everything is ticked to
 * begin with, because "fetch" usually means "I want these" — and unticking is
 * one click, where adding sixty rows and then removing them is sixty.
 *
 * Already-configured models are shown and disabled rather than hidden: a row
 * that silently is not in the list is a row somebody will fetch again, and again.
 */
import { useMemo, useState } from "react";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import type { ModelEntryFacts } from "@/lib/providers/upstream";

export interface PickedEntry {
  id: string;
  contextLength?: number;
  maxOutputTokens?: number;
  reasoningLevels?: string[];
}

export function ModelPickerModal({
  open,
  entries,
  /** Ids already in the form, by either name. */
  existing,
  onClose,
  onConfirm,
}: {
  open: boolean;
  entries: PickedEntry[];
  existing: readonly string[];
  onClose: () => void;
  onConfirm: (chosen: PickedEntry[]) => void;
}) {
  const t = useT();
  const [ticked, setTicked] = useState<Record<string, boolean>>({});

  const already = useMemo(() => new Set(existing), [existing]);
  /** A first look ticks the new ones; a re-open does not silently grow. */
  const effective = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const e of entries) out[e.id] = ticked[e.id] ?? !already.has(e.id);
    return out;
  }, [entries, ticked, already]);

  const chosen = entries.filter((e) => effective[e.id]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("admin.providers.pickFetched")}
      description={t("admin.providers.pickFetchedDesc", { n: entries.length })}
      wide
    >
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {entries.map((e) => {
          const done = already.has(e.id);
          return (
            <label
              key={e.id}
              className={`flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-sm ${
                done
                  ? "cursor-default border-border/60 bg-muted/30"
                  : "cursor-pointer border-border hover:bg-muted/50"
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={done ? false : Boolean(effective[e.id])}
                disabled={done}
                onChange={(ev) => setTicked((prev) => ({ ...prev, [e.id]: ev.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs">{e.id}</span>
                {done ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {t("admin.providers.alreadyAdded")}
                  </span>
                ) : (
                  (e.contextLength || e.maxOutputTokens || e.reasoningLevels?.length) && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {e.contextLength ? `${t("admin.providers.contextLabel")}: ${e.contextLength}` : null}
                      {e.maxOutputTokens ? ` · ${t("admin.providers.outputLabel")}: ${e.maxOutputTokens}` : null}
                      {e.reasoningLevels?.length
                        ? ` · ${t("admin.providers.levelsLabel")}: ${e.reasoningLevels.join(" / ")}`
                        : null}
                    </span>
                  )
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setTicked(Object.fromEntries(entries.filter((e) => !already.has(e.id)).map((e) => [e.id, true])))
          }
        >
          {t("admin.providers.selectAllFetched")}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={chosen.length === 0} onClick={() => onConfirm(chosen)}>
            {t("admin.providers.addSelected", { n: chosen.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
