/**
 * Card padding contract.
 *
 * Regression guard: the v121 shadcn migration dropped the Card's default
 * `p-4 sm:p-6`, which left the content of ~40 `<Card>` call sites flush
 * against the border. These tests pin the behaviour down in both directions
 * so a future refactor can't silently reintroduce that.
 *
 * Written with createElement rather than JSX because the vitest `include`
 * pattern only picks up `*.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeaderNew,
  CardTitle,
} from "@/components/ui/Card";

function classesOf(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  const html = renderToStaticMarkup(element);
  return html.match(/class="([^"]*)"/)?.[1] ?? "";
}

describe("Card: content is inset by default", () => {
  it("applies the responsive default padding", () => {
    const cls = classesOf(h(Card, null, "content"));
    expect(cls).toContain("p-4");
    expect(cls).toContain("sm:p-6");
  });

  it("keeps caller classes alongside the default padding", () => {
    const cls = classesOf(h(Card, { className: "mt-6" }, "content"));
    expect(cls).toContain("mt-6");
    expect(cls).toContain("p-4");
    expect(cls).toContain("sm:p-6");
  });

  it("lets callers opt out when they pad themselves", () => {
    const cls = classesOf(h(Card, { padded: false }, "content"));
    expect(cls).not.toMatch(/(^|\s)p-4(\s|$)/);
    expect(cls).not.toContain("sm:p-6");
  });

  it("lets a caller override the padding entirely", () => {
    const cls = classesOf(h(Card, { className: "p-8" }, "content"));
    expect(cls).toContain("p-8");
    expect(cls).not.toMatch(/(^|\s)p-4(\s|$)/);
  });
});

describe("Card: compound parts carry their own padding", () => {
  it("CardHeaderNew pads all four sides", () => {
    const cls = classesOf(h(CardHeaderNew, null, h(CardTitle, null, "Title")));
    expect(cls).toContain("p-4");
    expect(cls).toContain("sm:p-6");
  });

  it("CardContent continues the header's padding without the top gap", () => {
    const cls = classesOf(h(CardContent, null, "body"));
    expect(cls).toContain("p-4");
    expect(cls).toContain("sm:p-6");
    expect(cls).toContain("pt-0");
    expect(cls).toContain("sm:pt-0");
  });

  it("CardFooter matches CardContent", () => {
    const cls = classesOf(h(CardFooter, null, "footer"));
    expect(cls).toContain("p-4");
    expect(cls).toContain("pt-0");
  });

  it("renders the compound API without double padding when opted out", () => {
    const html = renderToStaticMarkup(
      h(
        Card,
        { padded: false },
        h(CardHeaderNew, null, h(CardTitle, null, "Title"), h(CardDescription, null, "Desc")),
        h(CardContent, null, "body"),
      ),
    );
    // Card itself contributes no padding; the two compound parts do.
    const cardClasses = html.match(/class="([^"]*)"/)?.[1] ?? "";
    expect(cardClasses).not.toContain("p-4");
    expect(html.match(/p-4/g)?.length).toBe(2);
  });
});
