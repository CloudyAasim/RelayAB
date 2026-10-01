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

function cost(n: number | null): string {
  // Credits are stored in 0.001-credit units; 0 means "not priced", which is
  // different from "free" and should not be rendered as a price.
  if (n === null || n === 0) return "—";
  return `${(n / 1_000_000).toFixed(4)} / 1M`;
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t("docs.catalog.model")}</th>
              <th className="py-2 pr-3 font-medium">{t("docs.catalog.provider")}</th>
              <th className="py-2 pr-3 font-medium">{t("docs.catalog.context")}</th>
              <th className="py-2 pr-3 font-medium">{t("docs.catalog.maxOutput")}</th>
              <th className="py-2 pr-3 font-medium">{t("docs.catalog.price")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={`${m.kind}:${m.id}`} className="border-b border-border/60 align-top">
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-xs">{m.id}</code>
                    {m.kind === "media" && m.capability && (
                      <Badge tone="purple">{m.capability}</Badge>
                    )}
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
                <td className="py-2 pr-3 text-xs text-muted-foreground">{m.provider}</td>
                <td className="py-2 pr-3 text-xs">{m.kind === "media" ? "—" : fmt(m.contextLength)}</td>
                <td className="py-2 pr-3 text-xs">{m.kind === "media" ? "—" : fmt(m.maxOutputTokens)}</td>
                <td className="py-2 pr-3 text-xs">
                  {m.kind === "media" ? (m.inputCost ? cost(m.inputCost) : "—") : cost(m.inputCost)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  {t("docs.catalog.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-foreground">{t("docs.catalog.providers")}</h3>
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {providers.map((p) => (
            <li key={p.name} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{p.name}</span>
              <Badge tone={p.enabled ? "success" : "slate"}>
                {p.enabled ? t("docs.catalog.enabled") : t("docs.catalog.disabled")}
              </Badge>
              <span className="text-xs">
                {t("docs.catalog.modelCount", { n: p.modelCount })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
