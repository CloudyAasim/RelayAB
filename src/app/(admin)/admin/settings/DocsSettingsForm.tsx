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
import { validatePage, NOTES_SECTION, type DocPage } from "@/lib/docs/custom";
import { userDocSections } from "@/lib/docs/sections";

/** The editable shape of a page, before it is trimmed on the way to the API. */
type DocPageInput = Partial<DocPage>;

/** The fields a page row is edited by; the rest of `DocPage` is not editable here. */
const pageFields = (p: DocPageInput): DocPage => ({
  id: p.id ?? "",
  title: p.title ?? "",
  body: p.body ?? "",
  ...(p.section && p.section !== NOTES_SECTION ? { section: p.section } : {}),
  ...(p.hidden ? { hidden: true } : {}),
  ...(p.order === undefined ? {} : { order: p.order }),
});

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
    publicCatalog?: boolean;
    modelNotes?: Record<string, ModelNoteInput>;
    docPages?: DocPageInput[];
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
  const [publicCatalog, setPublicCatalog] = useState(initial.publicCatalog ?? false);
  const [notes, setNotes] = useState<Record<string, ModelNoteInput>>(initial.modelNotes ?? {});
  const [pages, setPages] = useState<DocPageInput[]>(initial.docPages ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");

  const patch = (id: string, next: ModelNoteInput) =>
    setNotes((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));

  /**
   * A page's id is editable while it is a draft and fixed once it is published.
   *
   * The id is the anchor readers link to, so silently changing it would break
   * every link somebody ever shared. Drafts have no readers yet, which is why
   * that is the moment it is safe.
   */
  const patchPage = (index: number, next: Partial<DocPageInput>) =>
    setPages((prev) => prev.map((p, i) => (i === index ? { ...p, ...next } : p)));

  const addPage = () =>
    setPages((prev) => [
      ...prev,
      { id: "", title: "", body: "", hidden: true, order: prev.length },
    ]);

  const removePage = (index: number) =>
    setPages((prev) => prev.filter((_, i) => i !== index));

  const movePage = (index: number, delta: number) =>
    setPages((prev) => {
      const next = [...prev];
      const to = index + delta;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to], next[index]];
      return next.map((p, i) => ({ ...p, order: i }));
    });

  /** Local, so an unusable page is refused here rather than by a round trip. */
  const pageProblem = (p: DocPageInput, index: number): string | null => {
    const reason = validatePage(pageFields(p));
    if (reason) return reason;
    const clash = pages.some(
      (other, i) => i !== index && (other.id ?? "").trim() === (p.id ?? "").trim(),
    );
    return clash ? t("admin.docsSettings.pageDuplicate") : null;
  };

  const pageProblems = pages.map((p, i) => pageProblem(p, i));
  const pagesOk = pageProblems.every((p) => p === null);

  // Built from the document's own outline rather than a second list written
  // here, so a chapter that is renamed in the docs is renamed in this dropdown
  // too, and a chapter that does not exist cannot be offered.
  const sectionChoices = userDocSections(t).filter((s) => s.id !== NOTES_SECTION);

  const visible = models.filter(
    (m) => !query.trim() || m.id.toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function save() {
    // A page that cannot be published is not silently dropped on the way past.
    if (!pagesOk) {
      setMessage({ ok: false, text: t("admin.docsSettings.pageFixFirst") });
      return;
    }
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
          publicCatalog,
          modelNotes: cleaned,
          docPages: pages
            .map((p, i) => {
              const f = pageFields(p);
              return {
                id: f.id.trim(),
                title: f.title.trim(),
                body: f.body,
                ...(f.section ? { section: f.section } : {}),
                ...(f.hidden ? { hidden: true } : {}),
                order: f.order ?? i,
              };
            })
            // A page with no id is a row someone started and abandoned. Keeping
            // it would put an unlinkable entry in the outline.
            .filter((p) => p.id && p.title),
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
      {/*
        The operator's own chapter, first in the editor.

        First because it is the thing most likely to be being changed, and
        because the fields below it — site name, announcement, model notes —
        are set once and then left alone.
      */}
      <Card>
        <CardHeader
          title={t("admin.docsSettings.pagesTitle")}
          description={t("admin.docsSettings.pagesDesc")}
        />

        {pages.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("admin.docsSettings.pagesEmpty")}</p>
        )}

        <div className="space-y-4">
          {pages.map((p, i) => {
            const problem = pageProblems[i];
            return (
              <div
                key={i}
                className={`space-y-3 rounded-lg border p-3 ${
                  problem ? "border-destructive/50" : "border-border"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-40 flex-1">
                    <label
                      htmlFor={`page-id-${i}`}
                      className="block text-xs font-medium text-foreground"
                    >
                      {t("admin.docsSettings.pageId")}
                    </label>
                    <input
                      id={`page-id-${i}`}
                      value={p.id ?? ""}
                      readOnly={!p.hidden}
                      onChange={(e) => patchPage(i, { id: e.target.value })}
                      placeholder="rate-limits"
                      className={`mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm ${
                        p.hidden ? "" : "opacity-70"
                      }`}
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <label
                      htmlFor={`page-title-${i}`}
                      className="block text-xs font-medium text-foreground"
                    >
                      {t("admin.docsSettings.pageTitle")}
                    </label>
                    <input
                      id={`page-title-${i}`}
                      value={p.title ?? ""}
                      onChange={(e) => patchPage(i, { title: e.target.value })}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-1.5 pb-0.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => movePage(i, -1)}
                      disabled={i === 0}
                      aria-label={t("admin.docsSettings.pageUp")}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => movePage(i, 1)}
                      disabled={i === pages.length - 1}
                      aria-label={t("admin.docsSettings.pageDown")}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removePage(i)}
                      aria-label={t("admin.docsSettings.pageDelete")}
                    >
                      {t("admin.docsSettings.pageDelete")}
                    </Button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor={`page-section-${i}`}
                    className="block text-xs font-medium text-foreground"
                  >
                    {t("admin.docsSettings.pageSection")}
                  </label>
                  <select
                    id={`page-section-${i}`}
                    value={p.section ?? NOTES_SECTION}
                    onChange={(e) =>
                      patchPage(i, {
                        section: e.target.value === NOTES_SECTION ? "" : e.target.value,
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value={NOTES_SECTION}>{t("admin.docsSettings.pageSectionEnd")}</option>
                    {sectionChoices.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("admin.docsSettings.pageSectionHint")}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor={`page-body-${i}`}
                    className="block text-xs font-medium text-foreground"
                  >
                    {t("admin.docsSettings.pageBody")}
                  </label>
                  <textarea
                    id={`page-body-${i}`}
                    value={p.body ?? ""}
                    onChange={(e) => patchPage(i, { body: e.target.value })}
                    rows={10}
                    className="mt-1 w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={p.hidden ?? false}
                    onChange={(e) => patchPage(i, { hidden: e.target.checked })}
                  />
                  {t("admin.docsSettings.pageHidden")}
                </label>

                {problem && (
                  <p className="text-xs text-destructive">
                    {problem === t("admin.docsSettings.pageDuplicate")
                      ? problem
                      : t("admin.docsSettings.pageInvalidId")}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 space-y-2">
          <Button size="sm" variant="outline" onClick={addPage}>
            {t("admin.docsSettings.pageNew")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("admin.docsSettings.pagesHint")}</p>
        </div>
      </Card>

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
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={publicCatalog}
              onChange={(e) => setPublicCatalog(e.target.checked)}
            />
            <span>
              {t("admin.docsSettings.publicCatalog")}
              <span className="mt-0.5 block text-xs">{t("admin.docsSettings.publicCatalogHint")}</span>
            </span>
          </label>
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
