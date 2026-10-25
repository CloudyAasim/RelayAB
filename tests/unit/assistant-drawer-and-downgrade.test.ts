/**
 * tests/unit/assistant-drawer-and-downgrade.test.ts
 *
 * Two things that were decided in one place and are decided in another.
 *
 * **The reason an approval was refused used to live inside the drawer.**
 *
 * Radix's `SheetContent` renders through a portal with `<Presence>`, so closing
 * the drawer unmounts everything inside it. Two fixes ago the failure banner was
 * moved above the empty-state early return, so it survived the *queue*
 * emptying — which is the case that motivated the move, and the only one that
 * was checked. Unmounting is the other way this panel stops being on screen,
 * and it is the easier one to trigger: read the banner, go back to the
 * conversation, come back, and the reason is gone with nowhere to look for it.
 * The panel reads pending rows only, so the row the server wrote the reason
 * into is not in this list at all.
 *
 * **A hop from HTTPS to HTTP was neither taken nor reported.**
 *
 * `checkUrl` allows both schemes and `assertPublicHost` only looks at the host,
 * so a redirect down to plain HTTP passed through silently. Refusing it is not
 * the fix: `https://www.agnes-ai.cn/doc` answers 302 with an `http://` location
 * of its own making and then 301s straight back — measured — so refusing the
 * first hop would have undone the redirect ceiling that makes the page
 * reachable at all. Nothing secret is sent on this path (it is a GET for a
 * public page carrying no credential), so what is at risk is an intermediary
 * rewriting a body the model will reason from. That is worth saying out loud,
 * and worth nothing to hide.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string): string => readFileSync(join(__dirname, "..", "..", rel), "utf8");
const CHAT = read("src/app/(user)/dashboard/assistant/AssistantChat.tsx");
const PENDING = read("src/app/(user)/dashboard/assistant/PendingActions.tsx");
const WEBFETCH = read("src/lib/assistant/web-fetch.ts");

describe("a refused approval outlives the drawer being closed", () => {
  it("the reason is not state inside the panel", () => {
    // `useState` for the error would put it back inside the portal, and the
    // portal is unmounted on close. The context below is what replaces it.
    expect(PENDING).toMatch(/const \[error, setError\] = usePendingError\(\)/);
    expect(PENDING, "the reason is still local state, so it dies with the sheet").not.toMatch(
      /useState<string \| null>\(null\);\s*\n\s*\/\*[\s\S]{0,200}?失败|const \[error, setError\] = useState/,
    );
  });

  it("and the panel reaches it through a provider the drawer is inside", () => {
    expect(PENDING).toMatch(/export function PendingErrorProvider\(/);
    expect(PENDING).toMatch(/createContext<PendingErrorState>/);
  });

  it("which something above the drawer owns", () => {
    // Held in `AssistantChat`, and the `Sheet` is a child of the provider — so
    // the state sits outside the thing that unmounts.
    expect(CHAT).toMatch(/const \[pendingDecisionError, setPendingDecisionError\] = useState/);
    const provider = CHAT.indexOf("<PendingErrorProvider");
    const sheet = CHAT.indexOf("<Sheet ", provider);
    expect(provider, "the provider is not around the sheet").toBeGreaterThan(-1);
    expect(sheet, "no sheet inside the provider").toBeGreaterThan(provider);
    expect(CHAT).toMatch(/<\/Sheet>\s*<\/PendingErrorProvider>/);
  });

  it("while the key draft deliberately does not", () => {
    // The opposite decision, on purpose: a secret an administrator abandons by
    // closing the drawer should not outlive the thing it was for.
    expect(PENDING).toMatch(/const \[keys, setKeys\] = useState/);
  });
});

describe("a hop down to plain HTTP is reported rather than ignored", () => {
  it("is noticed on the redirect that does it", () => {
    expect(WEBFETCH).toMatch(
      /url\.protocol === "https:" && next\.protocol === "http:"\) downgraded = true/,
    );
  });

  it("reaches the reader, because the reader is the model", () => {
    expect(WEBFETCH).toMatch(/downgraded\?: boolean/);
    expect(WEBFETCH).toMatch(/未经加密传输/);
    // A flag in a JSON envelope is one more thing to notice while doing
    // something else; a sentence at the top of the body is read as the body.
    expect(WEBFETCH).toMatch(/【注意：这个地址在跳转过程中从 HTTPS 降级到了 HTTP/);
    expect(WEBFETCH).toMatch(/\$\{body\}`/);
  });

  it("and a page that never downgrades is untouched", () => {
    // The body is put together from a warning and the text now, so that the
    // plain form and the Markdown form carry the same warning — a reader who
    // gets the Markdown must not be the one who does not learn the page was
    // tampered with. The warning is empty when nothing downgraded, so the
    // page reads exactly as it did before.
    expect(WEBFETCH).toMatch(/const warning = downgraded/);
    expect(WEBFETCH).toMatch(/text: `\$\{warning\}\$\{body\}`,/);
    expect(WEBFETCH).toMatch(/: "";/);
  });

  it("without costing a reachable documentation page", () => {
    // The reason it is a warning and not a refusal: measured against the site
    // the assistant is most often asked to read, which answers 302 with an
    // `http://` location of its own making and then 301s straight back.
    // Scoped to the redirect branch — the rebind guard below it legitimately
    // throws, and has its own tests.
    const branch = WEBFETCH.slice(
      WEBFETCH.indexOf('next.protocol === "http:"'),
      WEBFETCH.indexOf("continue;", WEBFETCH.indexOf('next.protocol === "http:"')),
    );
    expect(branch, "the downgrade hop throws instead of being noted").not.toMatch(
      /throw new WebFetchError/,
    );
  });
});
