"use client";

/**
 * src/app/(admin)/admin/settings/DocsPagesForm.tsx
 *
 * The operator's own documentation pages.
 *
 * Its own form and its own save. It used to share one button with the site copy
 * and the per-model notes, so editing a page and saving also rewrote every
 * other field in the form from whatever the form was holding — including fields
 * a half-finished edit had left blank.
 */
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { validatePage, type DocPage } from "@/lib/docs/custom";
import { useSettingsSave } from "@/components/admin/useSettingsSave";

/** The editable shape of a page, before it is trimmed on the way to the API. */
type DocPageInput = Partial<DocPage>;

/** What the settings page reads out of the stored settings for this form. */
export interface DocsPageValues {
  docPages: readonly DocPageInput[];
}

/**
 * The fields a page row is edited by; the rest of `DocPage` is not editable here.
 *
 * There is deliberately no chapter field. A version of this let each page name
 * a built-in chapter to be filed under, which scattered the operator's prose
 * through the document and made "where did I put the rate limit" a question
 * with no answer. All of it is one chapter now.
 */
const pageFields = (p: DocPageInput): DocPage => ({
  id: p.id ?? "",
  title: p.title ?? "",
  body: p.body ?? "",
  ...(p.hidden ? { hidden: true } : {}),
  ...(p.order === undefined ? {} : { order: p.order }),
});

/**
 * A row somebody opened and never filled in. */
function isBlank(p: DocPageInput): boolean {
  return !p.id?.trim() && !p.title?.trim() && !p.body?.trim();
}

/**
 * Whether this row's id is fixed.
 *
 * Fixed once the page has an id, because the id is the anchor readers link to
 * and changing it would break every link anybody ever shared. A row with no id
 * yet has no readers, which is the only moment it is safe to name.
 *
 * This was keyed on the hidden flag, negated — read-only unless hidden. That
 * flag means "not shown to readers" everywhere else (`docs/custom.ts`,
 * `docs/catalog.ts`), and `addPage` creates a published row without it, so
 * every new page came up with a read-only id box. The id could not be typed,
 * `docsPagesPayload` drops rows with no id, and the page saved and vanished:
 * zero pages, no error, and a save button that looked like it had worked.
 */
function idLocked(p: DocPageInput): boolean {
  return Boolean(p.id?.trim());
}

/** The request body for this form, and nothing else. */
export function docsPagesPayload(pages: readonly DocPageInput[]): { docPages: unknown[] } {
  return {
    docPages: pages
      .map((p, i) => {
        const f = pageFields(p);
        return {
          id: f.id.trim(),
          title: f.title.trim(),
          body: f.body,
          ...(f.hidden ? { hidden: true } : {}),
          order: f.order ?? i,
        };
      })
      // A row nobody filled in is not published as an unlinkable entry. See
      // `isBlank`: these are dropped silently rather than blocking the save,
      // because a blocked save looks exactly like a broken one.
      .filter((p) => p.id && p.title),
  };
}

export function DocsPagesForm({ initial }: { initial: readonly DocPageInput[] }) {
  const t = useT();
  const { save, busy, message } = useSettingsSave();
  const [pages, setPages] = useState<DocPageInput[]>([...initial]);

  /**
   * A page's id is editable until it has one, and fixed from then on.
   *
   * The id is the anchor readers link to, so silently changing it would break
   * every link somebody ever shared. A row with no id has no readers yet,
   * which is why that is the moment it is safe to name.
   */
  const patchPage = (index: number, next: Partial<DocPageInput>) =>
    setPages((prev) => prev.map((p, i) => (i === index ? { ...p, ...next } : p)));

  const addPage = () =>
    setPages((prev) => [
      ...prev,
      // Published, not a draft. The previous default was `hidden: true`, on the
      // theory that a half-written page should not be published — but the
      // checkbox is small, the label is a line of small text, and the result was
      // a page that saved correctly and was then invisible, which reads as "it
      // disappeared" rather than "it is a draft". Drafting is now something you
      // switch on deliberately.
      { id: "", title: "", body: "", order: prev.length },
    ]);

  const removePage = (index: number) =>
    setPages((prev) => prev.filter((_, i) => i !== index));

  const movePage = (index: number, delta: number) =>
    setPages((prev) => {
      const next = [...prev];
      const to = index + delta;
      if (to < 0 || to >= next.length) return prev;
      [next[index], next[to]] = [next[to], next[index]];
      // Renumber the whole list. The server sorts on the stored order, so a
      // swap that does not renumber is not a move.
      return next.map((p, i) => ({ ...p, order: i }));
    });

  /**
   * Local, so an unusable page is refused here rather than by a round trip.
   *
   * A row nobody typed into is not a problem to report. `addPage` opens one, and
   * someone who adds three pages and fills in one has left two blanks; blocking
   * the whole save on those made every other page unsaveable, with the offending
   * row scrolled off the top of a long list and the only symptom a save button
   * that appears to do nothing. A blank is dropped on the way out; a row with
   * *something* in it and something *wrong* is still refused, because that one is
   * somebody's work.
   */
  const pageProblem = (p: DocPageInput, index: number): string | null => {
    if (isBlank(p)) return null;
    const reason = validatePage(pageFields(p));
    if (reason) return reason;
    const clash = pages.some(
      (other, i) => i !== index && (other.id ?? "").trim() === (p.id ?? "").trim(),
    );
    return clash ? t("admin.docsSettings.pageDuplicate") : null;
  };

  const pageProblems = pages.map((p, i) => pageProblem(p, i));
  const pagesOk = pageProblems.every((p) => p === null);

  return (
    <Card>
      <CardHeader title={t("admin.docsSettings.pagesTitle")} description={t("admin.docsSettings.pagesDesc")} />

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
                  <label htmlFor={`page-id-${i}`} className="block text-xs font-medium text-foreground">
                    {t("admin.docsSettings.pageId")}
                  </label>
                  <input
                    id={`page-id-${i}`}
                    value={p.id ?? ""}
                    readOnly={idLocked(p)}
                    onChange={(e) => patchPage(i, { id: e.target.value })}
                    placeholder="rate-limits"
                    className={`mt-1 h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm ${
                      idLocked(p) ? "opacity-70" : ""
                    }`}
                  />
                </div>
                <div className="min-w-40 flex-1">
                  <label htmlFor={`page-title-${i}`} className="block text-xs font-medium text-foreground">
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
                <label htmlFor={`page-body-${i}`} className="block text-xs font-medium text-foreground">
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

      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={async () => {
            // A page that cannot be published is not silently dropped on the way
            // past. The reason is already rendered beside this button, so there
            // is nothing to send.
            if (!pagesOk) return;
            await save(docsPagesPayload(pages));
          }}
          disabled={busy}
        >
          {busy ? t("admin.docsSettings.saving") : t("admin.docsSettings.save")}
        </Button>
        {!pagesOk && (
          <span className="text-sm text-destructive">{t("admin.docsSettings.pageFixFirst")}</span>
        )}
        {pagesOk && message && (
          <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </Card>
  );
}
