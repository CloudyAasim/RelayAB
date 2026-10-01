"use client";

/**
 * src/app/(admin)/admin/settings/DocsSettingsForm.tsx
 *
 * What the operator writes, as opposed to what the gateway knows.
 *
 * The editor lists the models that actually exist, taken from the live
 * catalogue, and lets the operator give each one a display name, a note, tags
 * and a "hidden" switch. It cannot set a context window or a price, and that
 * omission is deliberate: those are read live from the provider table, so an
 * operator can never publish a number the gateway would contradict.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";

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

interface Props {
  initial: {
    siteName?: string;
    siteDescription?: string;
    announcement?: string;
    supportContact?: string;
    modelNotes?: Record<string, ModelNoteInput>;
  };
  models: DocSettingsModel[];
}

export function DocsSettingsForm({ initial, models }: Props) {
  const t = useT();
  const router = useRouter();
  const [siteName, setSiteName] = useState(initial.siteName ?? "");
  const [siteDescription, setSiteDescription] = useState(initial.siteDescription ?? "");
  const [announcement, setAnnouncement] = useState(initial.announcement ?? "");
  const [supportContact, setSupportContact] = useState(initial.supportContact ?? "");
  const [notes, setNotes] = useState<Record<string, ModelNoteInput>>(initial.modelNotes ?? {});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const patch = (id: string, next: ModelNoteInput) =>
    setNotes((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));

  const visible = models.filter(
    (m) => !query.trim() || m.id.toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      // Strip empty values so a cleared field is an unset field rather than a
      // stored empty string, which would render as a blank line in the docs.
      const cleaned: Record<string, ModelNoteInput> = {};
      for (const [id, n] of Object.entries(notes)) {
        const out: ModelNoteInput = {};
        if (n.displayName?.trim()) out.displayName = n.displayName.trim();
        if (n.note?.trim()) out.note = n.note.trim();
        if (n.tags?.length) out.tags = n.tags;
        if (n.hidden) out.hidden = true;
        if (Object.keys(out).length > 0) cleaned[id] = out;
      }
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteName,
          siteDescription,
          announcement,
          supportContact,
          modelNotes: cleaned,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (json?.ok) {
        setMessage({ ok: true, text: t("admin.docsSettings.saved") });
        router.refresh();
      } else {
        setMessage({ ok: false, text: json?.error?.message ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t("admin.docsSettings.siteTitle")}
          description={t("admin.docsSettings.siteDesc")}
        />
        <div className="space-y-4">
          <Input
            label={t("admin.docsSettings.siteName")}
            hint={t("admin.docsSettings.siteNameHint")}
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
          />
          <Input
            label={t("admin.docsSettings.siteDescription")}
            value={siteDescription}
            onChange={(e) => setSiteDescription(e.target.value)}
          />
          <div className="space-y-1.5">
            <label htmlFor="docs-announcement" className="block text-sm font-medium text-foreground">
              {t("admin.docsSettings.announcement")}
            </label>
            <textarea
              id="docs-announcement"
              rows={4}
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <Input
            label={t("admin.docsSettings.supportContact")}
            hint={t("admin.docsSettings.supportContactHint")}
            value={supportContact}
            onChange={(e) => setSupportContact(e.target.value)}
          />
        </div>
      </Card>

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
                  <label
                    htmlFor={`note-${m.id}`}
                    className="block text-sm font-medium text-foreground"
                  >
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
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? t("admin.docsSettings.saving") : t("admin.docsSettings.save")}
        </Button>
        {message && (
          <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
