"use client";

/**
 * src/app/(admin)/admin/model-notes/ModelConfigForm.tsx
 *
 * Every model the deployment serves, one collapsible row each, and the whole
 * section collapsible too.
 *
 * **Why collapsible.** Fifteen rows of eleven fields is two hundred controls on
 * one screen, and the operator's actual question is usually "what does this one
 * model do" — so a row is a summary line until it is asked for. The count of
 * annotated rows is on the header, which is the other question ("what have I
 * already written").
 *
 * **What a row edits.** Both halves, because they describe the same model: the
 * gateway configuration that decides how it behaves on the OpenAI-compatible
 * surface, and the prose the documentation shows. Media rows show their gateway
 * fields as read-only facts, because a media model is driven by its spec — see
 * `lib/admin/model-config.ts`.
 */
import { useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/components/i18n/I18nProvider";
import { sanitizeLevelList } from "@/lib/providers/reasoning-levels";
import {
  modelConfigPayload,
  rowProblem,
  rowSummary,
  type ModelConfigRow,
} from "@/lib/admin/model-config";

const num = (v: string, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A price that is allowed to be blank.
 *
 * `num("")` answers 0, which for the cache prices means "this cache is free" —
 * so a field nobody touched would quietly reprice every cached request. Blank is
 * a value here: it means "charge the input price", which is the default a model
 * configured before caching existed must keep.
 */
const optionalNum = (v: string): number | undefined => {
  const raw = v.trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A comma- or space-separated list of level names, in the order written.
 *
 * Not lowercased and not validated against anything: the level a vendor calls
 * `xhigh` or `THINK_HIGH` is the level it calls that, and the value goes on the
 * wire exactly as typed. Only the separators and the duplicates go, so the list
 * reads the same on the way back.
 */
function parseLevelList(raw: string): string[] {
  return sanitizeLevelList(raw.split(/[,，\s]+/));
}

export function ModelConfigForm({ rows }: { rows: ModelConfigRow[] }) {
  const t = useT();
  const [list, setList] = useState<ModelConfigRow[]>(rows);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sectionOpen, setSectionOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const update = (index: number, next: Partial<ModelConfigRow>) =>
    setList((prev) => prev.map((r, i) => (i === index ? { ...r, ...next } : r)));

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const problemsAt = new Map<string, string>();
  list.forEach((r) => {
    const p = rowProblem(r);
    if (p) {
      problemsAt.set(
        r.store === "media" ? `m:${r.providerId}:${r.clientId}` : `p:${r.providerId}:${r.clientId}`,
        p,
      );
    }
  });
  const ok = problemsAt.size === 0;

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      list
        .map((row, index) => ({ row, index }))
        .filter(
          ({ row }) =>
            !q ||
            row.clientId.toLowerCase().includes(q) ||
            row.providerName.toLowerCase().includes(q) ||
            (row.capability ?? "").toLowerCase().includes(q) ||
            row.displayName.toLowerCase().includes(q),
        ),
    [list, q],
  );

  const annotated = list.filter(
    (r) =>
      r.note.trim() ||
      r.tags.trim() ||
      r.hidden ||
      (r.displayName.trim() && r.displayName.trim() !== r.clientId),
  ).length;
  const disabled = list.filter((r) => !r.enabled).length;

  /**
   * Its own endpoint, not the settings one.
   *
   * A model row writes to the *provider* record — the context window, the
   * prices, whether the gateway routes to it at all — as well as to the
   * documentation note. That is a different resource with a different failure
   * mode, and sending it to `/api/admin/settings` would be a lie about where the
   * data goes.
   */
  async function save() {
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelConfigPayload(list)),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (json?.ok) setMessage({ text: t("common.success"), ok: true });
      else setMessage({ text: json?.error?.message ?? `HTTP ${res.status}`, ok: false });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t("admin.modelConfig.title")}
        description={t("admin.modelConfig.desc")}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSectionOpen((v) => !v)}
            aria-expanded={sectionOpen}
          >
            {sectionOpen ? t("admin.modelConfig.collapse") : t("admin.modelConfig.expand")}
          </Button>
        }
      />

      {!sectionOpen ? (
        <p className="text-sm text-muted-foreground">
          {t("admin.modelConfig.summary", {
            total: list.length,
            annotated,
            disabled,
          })}
        </p>
      ) : (
        <>
          <div className="space-y-3">
            <Input
              label={t("admin.docsSettings.filter")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("admin.modelConfig.summary", { total: list.length, annotated, disabled })}
            </p>

            {visible.map(({ row, index }) => {
              const key =
                row.store === "media"
                  ? `m:${row.providerId}:${row.clientId}`
                  : `p:${row.providerId}:${row.clientId}`;
              const isOpen = open.has(key);
              const problem = problemsAt.get(key);

              return (
                <div
                  key={key}
                  className={`rounded-md border ${problem ? "border-destructive/50" : "border-border"}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    <span className="text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
                    <code className="font-mono text-xs">{row.clientId}</code>
                    <Badge tone={row.kind === "media" ? "purple" : "neutral"}>{row.kind}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {rowSummary(row)}
                    </span>
                    {!row.enabled && (
                      <span className="shrink-0 text-[10px] text-destructive">
                        {t("admin.modelConfig.off")}
                      </span>
                    )}
                  </button>

                  {isOpen && (
                    <div className="space-y-3 border-t border-border px-3 py-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          label={t("admin.docsSettings.displayName")}
                          value={row.displayName}
                          onChange={(e) => update(index, { displayName: e.target.value })}
                        />
                        <div>
                          <label className="block text-sm font-medium text-foreground">
                            {t("admin.providers.create.clientModel")}
                          </label>
                          <div className="mt-1 flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm text-muted-foreground">
                            {row.clientId}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("admin.modelConfig.clientIdHint")}
                          </p>
                        </div>
                      </div>

                      {row.gatewayEditable ? (
                        <>
                          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <Input
                              label={t("admin.providers.create.upstreamModel")}
                              value={row.upstreamId}
                              onChange={(e) => update(index, { upstreamId: e.target.value })}
                            />
                            <Input
                              type="number"
                              label={t("admin.providers.create.contextLength")}
                              value={String(row.contextLength)}
                              onChange={(e) =>
                                update(index, { contextLength: num(e.target.value, row.contextLength) })
                              }
                            />
                            <Input
                              type="number"
                              label={t("admin.providers.create.maxOutput")}
                              value={String(row.maxOutputTokens)}
                              onChange={(e) =>
                                update(index, {
                                  maxOutputTokens: num(e.target.value, row.maxOutputTokens),
                                })
                              }
                            />
                            {/*
                              The thinking levels, declared here like the window
                              and the cap beside it.

                              They used to be reachable only by scraping a
                              vendor's model list, which means they were
                              unreachable for every vendor that does not publish
                              them — and most do not. So the answer to "which
                              levels does this model take" was whatever this
                              system guessed, for the models that matter most.

                              Comma separated, because that is how a vendor's
                              documentation writes them, and the wire value is
                              passed through exactly as typed.
                            */}
                            <Input
                              label={t("admin.providers.create.reasoningLevels")}
                              hint={t("admin.providers.create.reasoningLevelsHint")}
                              placeholder="minimal, low, medium, high"
                              value={(row.reasoningLevels ?? []).join(", ")}
                              onChange={(e) =>
                                update(index, {
                                  reasoningLevels: parseLevelList(e.target.value),
                                })
                              }
                            />
                            {/*
                              The declaration, and the reason it is a checkbox
                              rather than more empty state.

                              Leaving the levels blank is ambiguous: it reads the
                              same for "nobody has written them down yet" and for
                              "this model has none, the vendor ignores the
                              parameter" — which is a fact about a real model
                              here, and the one that must switch the assistant's
                              control off. Only somebody who has read the vendor's
                              documentation can tell the two apart, so the box
                              asks them to. Left ticked by default, because a model
                              nobody has checked must keep a working control.
                            */}
                            <label className="flex items-start gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={row.reasoningEffortSupported !== false}
                                onChange={(e) =>
                                  update(index, {
                                    reasoningEffortSupported: e.target.checked,
                                  })
                                }
                              />
                              <span>
                                {t("admin.providers.create.reasoningEffortSupported")}
                              </span>
                            </label>
                            <Input
                              type="number"
                              label={t("admin.providers.create.inputCost")}
                              value={String(row.inputCost)}
                              onChange={(e) =>
                                update(index, { inputCost: num(e.target.value, row.inputCost) })
                              }
                            />
                            <Input
                              type="number"
                              label={t("admin.providers.create.outputCost")}
                              value={String(row.outputCost)}
                              onChange={(e) =>
                                update(index, { outputCost: num(e.target.value, row.outputCost) })
                              }
                            />
                            {/*
                              Blank-capable, unlike the four above. `num("")`
                              would answer 0, and here 0 means "this cache is
                              free" — so a field the operator never touched
                              would silently reprice every cached request.
                              Blank has to stay blank.
                            */}
                            <Input
                              type="number"
                              label={t("admin.providers.create.cachedInputCost")}
                              hint={t("admin.providers.create.cachedInputCostSame")}
                              value={row.cachedInputCost === undefined ? "" : String(row.cachedInputCost)}
                              onChange={(e) =>
                                update(index, {
                                  cachedInputCost: optionalNum(e.target.value),
                                })
                              }
                            />
                            <Input
                              type="number"
                              label={t("admin.providers.create.cacheWriteCost")}
                              hint={t("admin.providers.create.cachedInputCostSame")}
                              value={row.cacheWriteCost === undefined ? "" : String(row.cacheWriteCost)}
                              onChange={(e) =>
                                update(index, { cacheWriteCost: optionalNum(e.target.value) })
                              }
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("admin.providers.models.cacheCostHint")}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("admin.modelConfig.factsHint")}
                          </p>
                        </>
                      ) : (
                        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                          {t("admin.modelConfig.mediaReadonly", {
                            capability: row.capability ?? "—",
                            endpoint: row.endpoint ?? "—",
                            price: String(row.pricePerItem ?? 0),
                          })}
                        </div>
                      )}

                      <div>
                        <label htmlFor={`mc-note-${key}`} className="block text-sm font-medium text-foreground">
                          {t("admin.docsSettings.note")}
                        </label>
                        <textarea
                          id={`mc-note-${key}`}
                          rows={2}
                          value={row.note}
                          onChange={(e) => update(index, { note: e.target.value })}
                          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        />
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          label={t("admin.docsSettings.tags")}
                          hint={t("admin.docsSettings.tagsHint")}
                          value={row.tags}
                          onChange={(e) => update(index, { tags: e.target.value })}
                        />
                        <div className="flex flex-col justify-end gap-2 pb-1">
                          <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              disabled={!row.gatewayEditable}
                              onChange={(e) => update(index, { enabled: e.target.checked })}
                            />
                            {t("admin.modelConfig.gatewayEnabled")}
                          </label>
                          <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={row.hidden}
                              onChange={(e) => update(index, { hidden: e.target.checked })}
                            />
                            {t("admin.docsSettings.hidden")}
                          </label>
                        </div>
                      </div>

                      {problem && <p className="text-xs text-destructive">{problem}</p>}
                    </div>
                  )}
                </div>
              );
            })}

            {visible.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("admin.modelNotes.noMatch")}</p>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={save} disabled={busy || !ok}>
              {t("admin.docsSettings.save")}
            </Button>
            {!ok && (
              <span className="text-sm text-destructive">{t("admin.modelConfig.fixFirst")}</span>
            )}
            {ok && message && (
              <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

