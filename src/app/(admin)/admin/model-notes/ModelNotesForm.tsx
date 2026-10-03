"use client";

/**
 * src/app/(admin)/admin/model-notes/ModelNotesForm.tsx
 *
 * What each model is called in the documentation, and the sentence about it.
 *
 * Its own page, at the same level as the system settings rather than inside
 * them. It is a list over every model the deployment serves — fifteen rows on
 * this one, more on a bigger relay — and it is edited on its own schedule. It
 * has no business sharing a page, let alone a save button, with the site's
 * support contact.
 *
 * The *facts* are not editable here and cannot be: which models exist, their
 * context window, their price, their upstream. Those are read live from the
 * provider table on every request, so a deployment cannot publish a number the
 * gateway would contradict. What is editable is the prose around them.
 */
import { useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";
import { useSettingsSave } from "@/components/admin/useSettingsSave";

export interface DocSettingsModel {
  id: string;
  kind: "chat" | "media";
  displayName: string;
}

export interface ModelNoteInput {
  displayName?: string;
  note?: string;
  tags?: string[];
  hidden?: boolean;
}

/**
 * The request body for this form, and nothing else.
 *
 * Empty values are stripped rather than sent as empty strings, so a field the
 * operator cleared becomes unset instead of a stored blank that renders as an
 * empty row in the catalogue.
 */
export function modelNotesPayload(
  notes: Record<string, ModelNoteInput>,
): { modelNotes: Record<string, ModelNoteInput> } {
  const cleaned: Record<string, ModelNoteInput> = {};
  for (const [id, n] of Object.entries(notes)) {
    const out: ModelNoteInput = {};
    if (n.displayName?.trim()) out.displayName = n.displayName.trim();
    if (n.note?.trim()) out.note = n.note.trim();
    if (n.tags?.length) out.tags = n.tags;
    if (n.hidden) out.hidden = true;
    if (Object.keys(out).length > 0) cleaned[id] = out;
  }
  return { modelNotes: cleaned };
}

export function ModelNotesForm({
  initial,
  models,
}: {
  initial: Record<string, ModelNoteInput>;
  models: readonly DocSettingsModel[];
}) {
  const t = useT();
  const { save, busy, message } = useSettingsSave();
  const [notes, setNotes] = useState<Record<string, ModelNoteInput>>(initial ?? {});
  const [query, setQuery] = useState("");

  const patch = (id: string, next: ModelNoteInput) =>
    setNotes((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => models.filter((m) => !q || m.id.toLowerCase().includes(q)),
    [models, q],
  );

  /** How many models carry a note, so the count means something to the operator. */
  const annotated = models.filter((m) => {
    const n = notes[m.id];
    return Boolean(n?.displayName?.trim() || n?.note?.trim() || n?.tags?.length || n?.hidden);
  }).length;

  return (
    <Card>
      <CardHeader
        title={t("admin.docsSettings.modelsTitle")}
        description={t("admin.docsSettings.modelsDesc")}
      />

      <div className="space-y-3">
        <Input
          label={t("admin.docsSettings.filter")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("admin.docsSettings.modelsCount", { n: visible.length })}
          {annotated > 0 && (
            <span className="ml-2">
              {t("admin.modelNotes.annotated", { n: annotated })}
            </span>
          )}
        </p>

        {visible.map((m) => {
          const n = notes[m.id] ?? {};
          return (
            <div key={`${m.kind}:${m.id}`} className="rounded-md border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{m.id}</code>
                <Badge tone={m.kind === "media" ? "purple" : "neutral"}>{m.kind}</Badge>
                {m.displayName && m.displayName !== m.id && (
                  <span className="text-xs text-muted-foreground">{m.displayName}</span>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  label={t("admin.docsSettings.displayName")}
                  value={n.displayName ?? ""}
                  onChange={(e) => patch(m.id, { displayName: e.target.value })}
                />
                <Input
                  label={t("admin.docsSettings.tags")}
                  hint={t("admin.docsSettings.tagsHint")}
                  value={(n.tags ?? []).join(", ")}
                  onChange={(e) =>
                    patch(m.id, {
                      tags: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
              <div className="mt-2 space-y-1.5">
                <label htmlFor={`note-${m.id}`} className="block text-sm font-medium text-foreground">
                  {t("admin.docsSettings.note")}
                </label>
                <textarea
                  id={`note-${m.id}`}
                  rows={2}
                  value={n.note ?? ""}
                  onChange={(e) => patch(m.id, { note: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={n.hidden === true}
                  onChange={(e) => patch(m.id, { hidden: e.target.checked })}
                />
                {t("admin.docsSettings.hidden")}
              </label>
            </div>
          );
        })}

        {visible.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("admin.modelNotes.noMatch")}</p>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => save(modelNotesPayload(notes))} disabled={busy}>
          {busy ? t("admin.docsSettings.saving") : t("admin.docsSettings.save")}
        </Button>
        {message && (
          <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </Card>
  );
}
