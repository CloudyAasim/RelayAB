/**
 * tests/unit/provider-routes-render.test.ts
 *
 * The interface-routing table, rendered rather than read.
 *
 * Every other guard for this editor matches source text, and source text cannot
 * tell you what is *on the page*. So this renders the component and counts the
 * rows and the options — a guard that cannot be wrong about a rendering is
 * worth more than one that can only be wrong about a string.
 *
 * `renderToStaticMarkup` is enough and needs no browser: the table's state
 * comes from props and it has none of its own.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { DICTS } from "@/lib/i18n/dict";

const { ProviderSurfaceRoutes } = await import(
  "@/app/(admin)/admin/providers/ProviderSurfaceRoutes"
);
const { I18nProvider } = await import("@/components/i18n/I18nProvider");
const { emptyRoutes } = await import("@/lib/protocol/surface-routes");

type RoutesProps = Parameters<typeof ProviderSurfaceRoutes>[0];

function render(routes = emptyRoutes(), overrides: Partial<RoutesProps> = {}): string {
  const table = h(ProviderSurfaceRoutes, {
    routes,
    onChange: () => {},
    anthropicBaseUrl: "",
    onAnthropicBaseUrlChange: () => {},
    ...overrides,
  });
  return renderToStaticMarkup(h(I18nProvider, { initialLocale: "zh-CN", children: table }));
}

/** The `<select>` elements on the page, in order. */
function selects(html: string): string[] {
  return html.match(/<select[\s\S]*?<\/select>/g) ?? [];
}

/** The options of one `<select>`. */
function options(html: string): string[] {
  return (html.match(/<option[^>]*>[^<]*<\/option>/g) ?? []).map(
    (tag) => tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</")),
  );
}

describe("the interface-routing table", () => {
  it("shows one row per surface the gateway serves", () => {
    const html = render();
    for (const path of [
      "/v1/chat/completions",
      "/v1/responses",
      "/anthropic/v1/messages",
      "/v1beta/models/{model}:generateContent",
    ]) {
      expect(html, `${path} has no row`).toContain(path);
    }
    // Four surfaces, four rows — and the pickers that go with them.
    expect(selects(html)).toHaveLength(4);
  });

  it("offers the three answers on every row", () => {
    const html = render();
    for (const select of selects(html)) {
      const labels = options(select);
      expect(labels).toContain("不支持");
      expect(labels).toContain("原样透传");
      expect(labels).toContain("路由到");
    }
  });

  it("asks where a row is routed, only when it is routed somewhere", () => {
    // A row that is passed through or not answered has nothing to ask about;
    // the picker appears only for a route.
    const plain = render();
    expect(selects(plain)).toHaveLength(4);

    const routed = render({
      ...emptyRoutes(),
      "openai-chat": { kind: "route", dialect: "responses" },
    });
    // Four rows, plus the dialect picker on the routed one.
    expect(selects(routed)).toHaveLength(5);
    // The dialect picker is the one that offers dialects — and it offers them
    // by their labels, which the dictionary owns.
    const dict = DICTS["zh-CN"];
    const wanted = [
      dict["admin.providers.format.chat"],
      dict["admin.providers.format.responses"],
      dict["admin.providers.format.anthropic"],
      dict["admin.providers.format.gemini"],
    ];
    const picker = selects(routed).find((select) =>
      wanted.every((label) => select.includes(label)),
    );
    expect(picker, "the dialect picker is not on the page").toBeTruthy();
    expect(options(picker!).sort()).toEqual([...wanted].sort());
  });

  it("and asks for the Anthropic address only when that surface is native", () => {
    // The one case where the request goes to the vendor's own `/v1/messages`
    // rather than being rewritten — so it is the only case where the address
    // differs from the API address above it.
    const notNative = render();
    expect(notNative).not.toContain("Anthropic 基址");

    const native = render({
      ...emptyRoutes(),
      "anthropic-messages": { kind: "passthrough" },
    });
    expect(native).toContain("Anthropic 基址");
  });
});
