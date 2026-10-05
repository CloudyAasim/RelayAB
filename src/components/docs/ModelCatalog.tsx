"use client";

/**
 * src/app/(user)/dashboard/docs/ModelCatalog.tsx
 *
 * The live model list on the user-facing docs page.
 *
 * Client-side because it needs to be searchable: a deployment with fifteen
 * models is already past the point where scrolling works, and the one thing a
 * user came to this page for is finding the right model id to paste into a
 * request. The filter runs on data already fetched once — the catalogue
 * itself is server-rendered and read live, so nothing here can show a model
 * that the gateway would not actually serve.
 */
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { thinkingShape, type ThinkingShape } from "@/lib/docs/thinking";
import type { CatalogModel } from "@/lib/docs/catalog";

interface Props {
  models: CatalogModel[];
  providers: Array<{ name: string; enabled: boolean; modelCount: number }>;
  site: { name: string; description: string; announcement: string; supportContact: string };
  publicUrl: string;
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * One half of a token rate, in the units it is stored in.
 *
 * The stored number *is* credits per 1M tokens, so it is printed as-is. Dividing
 * by a million again — the token-count formatter's idiom, which is right for a
 * count and wrong for a rate — turned a configured 250 into "0.0003 / 1M".
 *
 * 0 means "not priced", which is a different fact from "free" and is rendered
 * as a dash. A free *cache* is the exception and is printed as 0, because that
 * one really is an answer.
 */
function cost(n: number | null, dash = "—"): string {
  if (n === null || n === 0) return dash;
  return String(n);
}

/**
 * The words for each shape, spelled as literals on purpose.
 *
 * `scripts/gen-docs-index.cjs` scans this file for `t("…")` and nothing else,
 * so a shape chosen by a lookup table would put strings on the page that the
 * assistant's index of the docs never learns exist — the one reader of this page
 * who is supposed to be able to explain it. The decision itself lives in
 * `src/lib/docs/thinking.ts` where it can be tested by running it.
 */
function reasoningText(
  m: CatalogModel,
  shape: ThinkingShape,
  t: (key: string) => string,
): string {
  if (shape === "levels") return m.reasoningLevels.join(" / ");
  if (shape === "switchOnly") return t("docs.catalog.reasoningSwitchOnly");
  if (shape === "alwaysOn") return t("docs.catalog.reasoningAlwaysOn");
  return t("docs.catalog.reasoningNone");
}

export function ModelCatalog({ models, providers, site, publicUrl }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "chat" | "media">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (kind !== "all" && m.kind !== kind) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        (m.note ?? "").toLowerCase().includes(q) ||
        (m.capability ?? "").toLowerCase().includes(q) ||
        m.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [models, query, kind]);

  const chatCount = models.filter((m) => m.kind === "chat").length;
  const mediaCount = models.length - chatCount;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold text-foreground">{site.name}</h2>
        {site.description && <p className="mt-1 text-sm text-muted-foreground">{site.description}</p>}

        {site.announcement && (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
            {site.announcement.split("\n").map((line, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </div>
        )}

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("docs.catalog.baseUrl")}</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{publicUrl}/v1</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("docs.catalog.chatModels")}</dt>
            <dd className="mt-0.5 font-medium">{chatCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("docs.catalog.mediaModels")}</dt>
            <dd className="mt-0.5 font-medium">{mediaCount}</dd>
          </div>
        </dl>

        {site.supportContact && (
          <p className="mt-3 text-sm text-muted-foreground">
            {t("docs.catalog.support")}: {site.supportContact}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label={t("docs.catalog.search")}
            placeholder={t("docs.catalog.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("docs.catalog.filter")}>
          {(["all", "chat", "media"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`h-9 rounded-md border px-3 text-sm transition-colors ${
                kind === k
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent"
              }`}
            >
              {k === "all" ? t("docs.catalog.all") : k === "chat" ? t("docs.catalog.chat") : t("docs.catalog.media")}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("docs.catalog.count", { n: filtered.length })}</p>

      {/*
        Two tables, not one table with a filter chip.

        The columns are not the same for the two kinds, and pretending they are
        is what made the old single table half dashes: a media row showed "—"
        for a context window that does not exist, and a chat row had nowhere to
        put the capability that distinguishes one image model from another.
      */}
      {(["chat", "media"] as const).map((group) => {
        const rows = filtered.filter((m) => m.kind === group);
        if (rows.length === 0) return null;
        const isChat = group === "chat";
        return (
          <section key={group} className="space-y-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {isChat ? t("docs.catalog.groupChat") : t("docs.catalog.groupMedia")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {isChat ? t("docs.catalog.groupChatDesc") : t("docs.catalog.groupMediaDesc")}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t("docs.catalog.model")}</th>
                    <th className="py-2 pr-3 font-medium">{t("docs.catalog.providerOf")}</th>
                    {isChat ? (
                      <>
                        <th className="py-2 pr-3 font-medium">{t("docs.catalog.context")}</th>
                        <th className="py-2 pr-3 font-medium">{t("docs.catalog.maxOutput")}</th>
                      </>
                    ) : (
                      <>
                        <th className="py-2 pr-3 font-medium">{t("docs.catalog.kind")}</th>
                        <th className="py-2 pr-3 font-medium">{t("docs.catalog.endpoint")}</th>
                      </>
                    )}
                    {isChat ? (
                      <>
                        <th className="py-2 pr-3 font-medium">
                          {t("docs.catalog.rateIn")}
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {t("docs.catalog.perMillion")}
                          </span>
                        </th>
                        <th className="py-2 pr-3 font-medium">
                          {t("docs.catalog.rateOut")}
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {t("docs.catalog.perMillion")}
                          </span>
                        </th>
                        <th className="py-2 pr-3 font-medium">
                          {t("docs.catalog.rateCachedRead")}
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {t("docs.catalog.perMillion")}
                          </span>
                        </th>
                        <th className="py-2 pr-3 font-medium">
                          {t("docs.catalog.rateCachedWrite")}
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {t("docs.catalog.perMillion")}
                          </span>
                        </th>
                      </>
                    ) : (
                      <th className="py-2 pr-3 font-medium">
                        {t("docs.catalog.pricePerItem")}
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          {t("docs.catalog.perItem")}
                        </span>
                      </th>
                    )}
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <ModelRows key={`${m.kind}:${m.id}`} model={m} isChat={isChat} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {filtered.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("docs.catalog.empty")}
        </p>
      )}

      <ProviderList providers={providers} />
    </div>
  );
}

/**
 * One model, and the configuration behind it.
 *
 * The detail row is the point. The spec's own `metadata` — which sizes it
 * accepts, which modes, how many reference images — was being loaded on every
 * request and rendered nowhere, so the page answered "which model should I
 * use" with a name and three numbers.
 */
function ModelRows({ model: m, isChat }: { model: CatalogModel; isChat: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const meta = m.meta ?? {};
  const modes = Array.isArray(meta.modes) ? (meta.modes as unknown[]).map(String) : [];
  const sizes = Array.isArray(meta.sizes) ? (meta.sizes as unknown[]).map(String) : [];
  const maxRef = typeof meta.max_reference_images === "number" ? meta.max_reference_images : null;
  // Everything the spec's metadata carries that is not one of the three
  // rendered above. An operator put it there; a reader should be able to see it.
  const rest = Object.entries(meta).filter(
    ([k]) => !["modes", "sizes", "max_reference_images", "edit_mode"].includes(k),
  );

  return (
    <>
      <tr className="border-b border-border/60 align-top">
        <td className="py-2 pr-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="font-mono text-xs">{m.id}</code>
            {m.upstreamId && m.upstreamId !== m.id && (
              <span className="text-[11px] text-muted-foreground">← {m.upstreamId}</span>
            )}
            {!isChat && m.capability && <Badge tone="purple">{m.capability}</Badge>}
            {m.faces.map((f) => (
              <Badge key={f} tone="neutral">
                {f}
              </Badge>
            ))}
            {m.tags.map((tag) => (
              <Badge key={tag} tone="info">
                {tag}
              </Badge>
            ))}
          </div>
          {m.displayName !== m.id && (
            <p className="mt-0.5 text-xs text-muted-foreground">{m.displayName}</p>
          )}
          {m.note && (
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">{m.note}</p>
          )}
        </td>
        <td className="py-2 pr-3 text-xs">
          <span className="font-medium text-foreground">{m.source.name}</span>
          {m.source.baseUrl && (
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {m.source.baseUrl}
            </p>
          )}
          {m.source.priority !== null && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("docs.catalog.priority")}: {m.source.priority}
            </p>
          )}
        </td>
        {isChat ? (
          <>
            <td className="py-2 pr-3 text-xs">{fmt(m.contextLength)}</td>
            <td className="py-2 pr-3 text-xs">{fmt(m.maxOutputTokens)}</td>
          </>
        ) : (
          <>
            <td className="py-2 pr-3 text-xs">{m.capability ?? "—"}</td>
            <td className="py-2 pr-3 font-mono text-[11px]">{m.source.endpoint ?? "—"}</td>
          </>
        )}
        {isChat ? (
          <>
            <td className="py-2 pr-3 text-xs">{cost(m.inputCost)}</td>
            <td className="py-2 pr-3 text-xs">{cost(m.outputCost)}</td>
            <td className="py-2 pr-3 text-xs">
              {/* Not through `cost()`'s zero rule: 0 here means the cache is
                  free, which is an answer and not an absence. */}
              {m.cachedInputCost === null ? cost(null) : cost(m.cachedInputCost)}
            </td>
            <td className="py-2 pr-3 text-xs">
              {/* A hardcoded dash here would be a column that can never answer.
                  Both cache cells read the configured rate, and both treat an
                  unset rate as the input price — so the dash means "no separate
                  price", not "no data". 0 stays 0: a free cache is an answer. */}
              {m.cacheWriteCost === null ? cost(null) : cost(m.cacheWriteCost)}
            </td>
          </>
        ) : (
          <td className="py-2 pr-3 text-xs">
            {/*
                No division. `pricePerItem` is whole 积分 per item — the same
                number the operator typed in the panel, and the one the media
                billing path multiplies by 1000 on the way into storage.
                Dividing here published 100 积分/张 as 0.100 积分.
              */}
            {m.inputCost !== null ? `${m.inputCost} 积分` : cost(null)}
          </td>
        )}
        <td className="py-2 text-right">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("docs.catalog.detail")} {open ? "▾" : "▸"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td colSpan={isChat ? 9 : 6} className="px-3 py-2">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <Detail label={t("docs.catalog.base")} value={m.source.baseUrl ?? "—"} mono />
              <Detail
                label={t("docs.catalog.format")}
                value={m.source.upstreamFormat ?? "—"}
                mono
              />
              <Detail label={t("docs.catalog.endpoint")} value={m.source.endpoint ?? "—"} mono />
              <Detail label={t("docs.catalog.upstream")} value={m.upstreamId ?? "—"} mono />
              <Detail label={t("docs.catalog.context")} value={fmt(m.contextLength)} />
              <Detail label={t("docs.catalog.maxOutput")} value={fmt(m.maxOutputTokens)} />
              {/*
                  Stated, not inferred — and stated honestly. A model with no
                  gear-shifted levels shows which of the three reasons applies,
                  rather than an empty cell that reads like a rendering failure
                  and never a default list, which would be a claim about the
                  model that nobody on this page can check.
                */}
              <Detail
                label={t("docs.catalog.reasoningLevels")}
                value={reasoningText(m, thinkingShape(m), t)}
                mono
              />
              {/*
                  The other axis, and it fails on its own: a model can have
                  levels and still be impossible to switch off. Rendered only
                  when declared, so it says nothing about models nobody has
                  described — the row above is where "unknown" belongs.
                */}
              {m.thinkingSwitchSupported !== null && (
                <Detail
                  label={t("docs.catalog.thinkingSwitch")}
                  value={
                    m.thinkingSwitchSupported
                      ? t("docs.catalog.thinkingSwitchYes")
                      : t("docs.catalog.thinkingSwitchNo")
                  }
                />
              )}
              {m.source.priority !== null && (
                <Detail label={t("docs.catalog.priority")} value={String(m.source.priority)} />
              )}
              {modes.length > 0 && (
                <Detail label={t("docs.catalog.modes")} value={modes.join(" / ")} />
              )}
              {maxRef !== null && (
                <Detail label={t("docs.catalog.maxReference")} value={String(maxRef)} />
              )}
              {sizes.length > 0 && (
                <Detail label={t("docs.catalog.sizes")} value={sizes.join("  ")} mono />
              )}
              {rest.map(([k, v]) => (
                <Detail
                  key={k}
                  label={k}
                  value={typeof v === "object" ? JSON.stringify(v) : String(v)}
                />
              ))}
            </dl>
            {modes.length === 0 && sizes.length === 0 && rest.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t("docs.catalog.detailEmpty")}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/**
 * The providers, split by what they serve.
 *
 * "MiniMax" appears in both lists in most deployments, which is the whole
 * reason a single undifferentiated list of names was not enough.
 */
function ProviderList({
  providers,
}: {
  providers: Array<{ name: string; enabled: boolean; modelCount: number; kind?: "chat" | "media" }>;
}) {
  const t = useT();
  const groups: Array<{ kind: "chat" | "media"; rows: typeof providers }> = [
    { kind: "chat", rows: providers.filter((p) => p.kind !== "media") },
    { kind: "media", rows: providers.filter((p) => p.kind === "media") },
  ];

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground">{t("docs.catalog.providerGroup")}</h3>
      {groups.map((g) => {
        if (g.rows.length === 0) return null;
        return (
          <div key={g.kind} className="mt-3 first:mt-2">
            <p className="text-xs text-muted-foreground">
              {g.kind === "chat" ? t("docs.catalog.groupChat") : t("docs.catalog.groupMedia")}
            </p>
            <ul className="mt-1.5 space-y-1.5 text-sm text-muted-foreground">
              {g.rows.map((p) => (
                <li key={`${g.kind}:${p.name}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{p.name}</span>
                  <Badge tone={p.enabled ? "success" : "slate"}>
                    {p.enabled ? t("docs.catalog.enabled") : t("docs.catalog.disabled")}
                  </Badge>
                  <span className="text-xs">{t("docs.catalog.modelCount", { n: p.modelCount })}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
