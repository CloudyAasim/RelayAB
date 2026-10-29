"use client";

/**
 * src/app/(admin)/admin/providers/ProviderSurfaceRoutes.tsx
 *
 * How each client surface reaches this provider.
 *
 * The row is the unit. A provider row used to answer "which protocol am I" in
 * five columns and the answer was per **face** — two of them — while the
 * clients have four **surfaces**. So a vendor that publishes both
 * `/v1/chat/completions` and `/v1/responses` could not be asked to serve one
 * natively and the other by translation; the row had one dialect for both.
 *
 * Here each surface says one of three things:
 *
 *   - **不支持** — this provider does not answer it. Blank means the same.
 *   - **原样透传** — the request goes out in the shape it arrived in.
 *   - **路由到…** — the gateway rewrites it into that dialect's shape, on the
 *     way out and back.
 *
 * The three options are the whole decision, and the row says it in one place.
 */
import { useT } from "@/components/i18n/I18nProvider";
import { Input } from "@/components/ui/Input";
import { SURFACES } from "@/lib/protocol/text-specs";
import {
  ownDialectOf,
  type Dialect,
  type SurfaceId,
  type SurfaceRoute,
  type SurfaceRoutes,
} from "@/lib/protocol/surface-routes";

/** The dialects a vendor's own API can speak, in the order the picker shows them. */
const DIALECTS: readonly Dialect[] = ["chat", "responses", "anthropic", "gemini"];

export function ProviderSurfaceRoutes({
  routes,
  onChange,
  anthropicBaseUrl,
  onAnthropicBaseUrlChange,
  className,
}: {
  routes: SurfaceRoutes;
  onChange: (next: SurfaceRoutes) => void;
  /** The vendor's own `/v1/messages` address, when the Anthropic surface is native. */
  anthropicBaseUrl?: string;
  onAnthropicBaseUrlChange?: (next: string) => void;
  className?: string;
}) {
  const t = useT();

  const set = (surface: SurfaceId, route: SurfaceRoute): void => {
    onChange({ ...routes, [surface]: route });
  };

  const dialectLabel = (dialect: Dialect): string =>
    t(
      dialect === "chat"
        ? "admin.providers.format.chat"
        : dialect === "responses"
          ? "admin.providers.format.responses"
          : dialect === "anthropic"
            ? "admin.providers.format.anthropic"
            : "admin.providers.format.gemini",
    );

  return (
    <div className={className}>
      <p className="mb-1 text-sm font-medium">{t("admin.providers.routes.title")}</p>
      <p className="mb-3 text-xs text-muted-foreground">{t("admin.providers.routes.hint")}</p>

      <div className="space-y-2">
        {SURFACES.map((surface) => {
          const route = routes[surface.id];
          const own = ownDialectOf(surface.id);
          return (
            <div
              key={surface.id}
              className="rounded-md border border-border px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs text-muted-foreground">
                  {surface.clientPath}
                </code>
                <select
                  aria-label={`${surface.clientPath} — ${t("admin.providers.routes.title")}`}
                  value={route.kind === "route" ? "route" : route.kind}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === "unsupported") set(surface.id, { kind: "unsupported" });
                    else if (value === "passthrough") set(surface.id, { kind: "passthrough" });
                    else {
                      /**
                       * A route to the surface's **own** dialect is the same
                       * request as passing it through, so the picker starts on
                       * that one — the reader is not asked to tell a no-op
                       * translation from the absence of one.
                       */
                      set(surface.id, { kind: "route", dialect: own });
                    }
                  }}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="unsupported">{t("admin.providers.routes.unsupported")}</option>
                  <option value="passthrough">{t("admin.providers.routes.passthrough")}</option>
                  <option value="route">{t("admin.providers.routes.route")}</option>
                </select>

                {route.kind === "route" && (
                  <select
                    aria-label={`${surface.clientPath} — ${t("admin.providers.routes.route")}`}
                    value={route.dialect}
                    onChange={(e) =>
                      set(surface.id, { kind: "route", dialect: e.target.value as Dialect })
                    }
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    {DIALECTS.map((dialect) => (
                      <option key={dialect} value={dialect}>
                        {dialectLabel(dialect)}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/*
                The vendor's own Anthropic endpoint, asked for only when the
                Anthropic surface is answered natively — that is the one case
                where the request goes to `/v1/messages` rather than being
                rewritten, so that is the only case where the address differs
                from the API address above it.
              */}
              {surface.id === "anthropic-messages" &&
                route.kind === "passthrough" &&
                onAnthropicBaseUrlChange && (
                  <div className="mt-2 pl-1">
                    <Input
                      label={t("admin.providers.routes.anthropicBaseUrl")}
                      value={anthropicBaseUrl ?? ""}
                      onChange={(e) => onAnthropicBaseUrlChange(e.target.value)}
                      placeholder="https://api.agnes-ai.cn"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("admin.providers.routes.anthropicBaseUrlHint")}
                    </p>
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The upstream, declared on its own.
 *
 * Advanced mode: the vendor's own interfaces are stated here, and each surface
 * finds its way through them — served natively where the vendor speaks that
 * dialect, and rewritten where it does not. That is the whole of "只要支持这
 * 四种协议的其中一种就可以正常连接": one declaration, and every surface is
 * answered.
 */
export function ProviderUpstreamDialects({
  dialects,
  onChange,
  className,
}: {
  dialects: readonly Dialect[];
  onChange: (next: Dialect[]) => void;
  className?: string;
}) {
  const t = useT();

  const dialectLabel = (dialect: Dialect): string =>
    t(
      dialect === "chat"
        ? "admin.providers.format.chat"
        : dialect === "responses"
          ? "admin.providers.format.responses"
          : dialect === "anthropic"
            ? "admin.providers.format.anthropic"
            : "admin.providers.format.gemini",
    );

  return (
    <div className={className}>
      <p className="mb-1 text-sm font-medium">{t("admin.providers.routes.upstream.title")}</p>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("admin.providers.routes.upstream.hint")}
      </p>
      <div className="flex flex-wrap gap-2">
        {DIALECTS.map((dialect) => {
          const on = dialects.includes(dialect);
          return (
            <button
              key={dialect}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? dialects.filter((d) => d !== dialect) : [...dialects, dialect])
              }
              className={
                on
                  ? "rounded-full border-2 border-primary bg-primary/5 px-3 py-1 text-xs font-medium text-foreground"
                  : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-muted-foreground/40"
              }
            >
              {dialectLabel(dialect)}
            </button>
          );
        })}
      </div>
      {dialects.length === 0 && (
        <p className="mt-2 text-xs text-warning-foreground dark:text-warning">
          {t("admin.providers.routes.upstream.none")}
        </p>
      )}
    </div>
  );
}
