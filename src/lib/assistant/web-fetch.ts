/**
 * src/lib/assistant/web-fetch.ts
 *
 * Fetch a public web page on the assistant's behalf.
 *
 * The assistant runs on the user's own upstream and has no way to read a
 * document the user can see. Being able to read one is genuinely worth having
 * — a vendor's API reference is exactly the thing it needs and cannot invent,
 * and "image-01 supports image-to-image, go by the official docs" is
 * unanswerable without it.
 *
 * "Fetch this URL" issued by a language model is also the textbook shape of a
 * server-side request forgery, so the checks below are the feature's real
 * content, not boilerplate. A relay that is publicly reachable and lets a
 * caller name a URL is a proxy into whatever the host can see: its cloud
 * metadata endpoint, its own database, whatever it has on localhost.
 *
 * What is refused:
 *   - any scheme other than http/https (file:, data:, gopher:, ftp:)
 *   - credentials embedded in the URL
 *   - a host that is, or resolves to, a private or otherwise unroutable
 *     address — checked against the *resolved* addresses, because "localhost"
 *     and "127.0.0.1.nip.io" are the same request
 *   - a redirect that lands somewhere the first hop would have been refused
 *   - a response larger than the cap, or of a type that is not text
 *
 * The redirect rule is the one most often missed. Following `Location` with
 * the platform's own redirect handling re-resolves nothing and re-checks
 * nothing, so a public host that answers `302 Location: http://169.254.169.254/`
 * walks straight past every check above.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { htmlToMarkdown } from "./web-markdown";

/** Enough of a documentation page to answer from, and not a memory problem. */
export const MAX_FETCH_BYTES = 200_000;

/** A page that takes this long to start answering is not a page. */
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Under this much visible text, an HTML page is treated as "the body did not
 * render" rather than as a short page.
 *
 * Single-page documentation sites answer 200 with a shell: navigation, a
 * cookie banner, and an empty `<div id="root">` that the browser fills in. The
 * extracted text is a few hundred characters and reads like a page whose
 * content is missing, because that is exactly what it is. Above this
 * threshold the page answered for itself and probing would only spend
 * requests.
 */
export const DOC_TEXT_MIN_CHARS = 600;

/** A probe is a guess; it does not deserve the full page timeout. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * How many hops a URL may take before it is treated as a maze.
 *
 * Three was one too few for ordinary sites. `https://www.agnes-ai.cn/doc`
 * — a documentation page the assistant is likely to be asked to read — takes
 * four: it 302s to `http://…/en/docs/`, on to the current section, and on
 * again to `/en/docs/overview`. Measured, not guessed. Every extra hop is
 * re-checked from the top by `checkUrl` and `resolvePublicAddresses`, so the
 * ceiling is about patience rather than safety.
 */
const MAX_REDIRECTS = 5;

/** What the model is told when something is refused, and why. */
export class WebFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "bad_url"
      | "blocked_address"
      | "too_large"
      | "bad_type"
      | "unreachable"
      | "not_found",
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Expand an IPv6 address to its eight groups, so it can be compared by value.
 *
 * `::1` and `0:0:0:0:0:0:0:1` are the same address written two ways, and
 * checking the short spelling only is how a loopback request gets through a
 * guard that looks like it is handling loopback. A trailing IPv4 part
 * (`::ffff:1.2.3.4`) is folded into the last two groups, which is also how it
 * compares.
 */
function expandIpv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;

  let body = ip;
  // A zone index (`fe80::1%eth0`) is not part of the address.
  body = body.split("%")[0];

  const tail = body.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const parts = tail.split("").length ? tail.split(".").map(Number) : [];
    const high = ((parts[0] << 8) | parts[1]) >>> 0;
    const low = ((parts[2] << 8) | parts[3]) >>> 0;
    const hex = (n: number) => ((n >> 8) & 0xff).toString(16) + (n & 0xff).toString(16);
    body = body.slice(0, body.length - tail.length) + `${hex(high)}:${hex(low)}`;
  }

  const [head, rest, extra] = body.split("::");
  if (extra !== undefined) return null; // more than one `::`
  const headGroups = head ? head.split(":") : [];
  const tailGroups = rest ? rest.split(":") : [];
  if (headGroups.length + tailGroups.length > 8) return null;
  const middle = new Array(8 - headGroups.length - tailGroups.length).fill("0");
  return [...headGroups, ...middle, ...tailGroups].map((g) => parseInt(g || "0", 16));
}

/**
 * Is this address one a request must never reach?
 *
 * Written out rather than derived from a table so the reason for each entry is
 * visible, and so a reviewer can see what is *not* here. The list is the
 * unroutable and private space, plus the ranges that are public on paper and
 * private in practice.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  // An IPv4 address in disguise: `::ffff:127.0.0.1` is a loopback request, and
  // `64:ff9b::/96` is NAT64, which reaches one.
  const embedded = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) return isPrivateAddress(embedded);

  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return true; // 0.0.0.0/8 — "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // TEST-NET-2
    if (a === 203 && b === 0) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }

  const v6 = expandIpv6(ip);
  if (!v6) return true; // unparseable: guessing is the failure mode
  const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) {
    return true; // :: and ::1, in either spelling
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local, 10 bits not 16
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // 64:ff9b::/96 NAT64
  // IPv4-mapped, written long-hand rather than as `::ffff:1.2.3.4`.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateAddress(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  return false;
}

/** A host that is written as a literal address, checked before any lookup. */
function literalAddress(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return isIP(bare) ? bare : null;
}

/**
 * Does this host point somewhere a request must not go?
 *
 * The literal case first, so `127.0.0.1` is refused without a DNS round trip,
 * and the resolved case after, because a name can point anywhere.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePublicAddresses(hostname);
}

/**
 * The addresses a hostname currently resolves to, all of them public.
 *
 * Returns the set so a caller can check it again afterwards. That check is the
 * only defence left against DNS rebinding that does not require owning the
 * socket: the guard above resolves once and `fetch` resolves again, so a name
 * served with a zero TTL answers `93.184.216.34` to the first question and
 * `127.0.0.1` to the second, milliseconds apart. Nothing in between binds the
 * connection to the address that was checked.
 *
 * Re-reading after the response arrives cannot undo the request, but it can
 * refuse to hand the body over — and the body is what matters here, because
 * the answer is what reaches the model and the reader. A GET to a metadata
 * endpoint that is then discarded does not put a credential in a transcript.
 */
async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const literal = literalAddress(hostname);
  if (literal) {
    if (isPrivateAddress(literal)) {
      throw new WebFetchError(`不访问内网地址：${literal}`, "blocked_address");
    }
    return [literal];
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new WebFetchError(`解析不了这个域名：${hostname}`, "bad_url");
  }
  if (addresses.length === 0) {
    throw new WebFetchError(`解析不了这个域名：${hostname}`, "bad_url");
  }
  // Every answer, not the first: a host with one public and one private address
  // is a host that will hand you whichever you let it pick.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new WebFetchError(`不访问指向内网的域名：${hostname}`, "blocked_address");
    }
  }
  return addresses.map((a) => a.address).sort();
}

/** Resolve, and answer null instead of throwing. For the after-the-fact check. */
async function tryResolvePublicAddresses(hostname: string): Promise<string[] | null> {
  try {
    return await resolvePublicAddresses(hostname);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

/**
 * A documentation page, as text.
 *
 * Not a parser — a stripper. `<script>` and `<style>` go first, because their
 * contents are text that looks like content and is not; then the remaining
 * markup, then the entities that would otherwise arrive as `&amp;`.
 *
 * Block-level tags become newlines so the output is not one run-on line, which
 * is most of what makes raw HTML useless to a model.
 */
/**
 * The page's own title, when it has one.
 *
 * Read out of the document head, because a page without a name is a page a
 * reader has to describe from its contents. A page whose title is written in
 * a script (or in several languages) simply has no title here.
 */
function htmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return "";
  return htmlToText(match[1]).trim().slice(0, 200);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/?(p|div|br|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|pre|blockquote|table)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * A documentation entry discovered next to a page that did not render.
 *
 * Kept as structured data rather than prose inside `text`, because the model
 * has to act on it: each entry is a URL it can hand straight back to
 * `fetch_page`. A note in the middle of a wall of text is one more thing to
 * notice while doing something else.
 */
export interface DiscoveredDoc {
  url: string;
  kind: "markdown" | "llms" | "openapi";
  bytes: number;
  /** What this document is, and what to do with it. */
  note: string;
  /** First part of the content, enough to judge relevance. */
  preview?: string;
  /** Endpoint paths, for an OpenAPI description that parsed. */
  paths?: string[];
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
  /**
   * The page as Markdown, when it was an HTML page.
   *
   * The same content, with its structure: a heading is still a heading, a link
   * is still a link, a list is still a list. The other search APIs hand back
   * Markdown, and the difference is what a reader can do with it — a
   * documentation page flattened into sentences is a documentation page whose
   * headings are gone.
   *
   * Absent for a page that was not HTML: a Markdown document fetched from
   * `.md` is already Markdown, and the text carries it unchanged.
   */
  markdown?: string;
  /**
   * The page's own title, when it has one.
   *
   * Read out of the document head, because a page without a name is a page a
   * reader has to describe from its contents. Empty when the page has no
   * title or is not HTML.
   */
  title?: string;
  /**
   * Set when `text` came from a different document than the requested page.
   *
   * Today that is the page's own Markdown source, tried because the rendered
   * page carried no body (a documentation SPA). The caller is told rather than
   * left to assume the URL it asked for contains what it is reading.
   */
  source?: "markdown";
  /** Other documents found on the same site that are worth reading next. */
  discovered?: DiscoveredDoc[];
  /**
   * Whether any hop left HTTPS for plain HTTP.
   *
   * Recorded rather than refused, because refusing breaks real sites for no
   * gain: `https://www.agnes-ai.cn/doc` — a documentation page the assistant
   * is likely to be asked to read — answers 302 with an `http://` location of
   * its own making, then 301s straight back. Refusing the first hop would have
   * undone the redirect ceiling that makes the page reachable at all.
   *
   * So the hop is taken and the reader is told. What is actually at risk is
   * worth being precise about: nothing secret is sent — this is a GET for a
   * public page, and the request carries no credential — so the exposure is an
   * intermediary rewriting the body, which matters because that body is what
   * the model will reason from. Saying so is something the model can act on;
   * a silent downgrade is not.
   */
  downgraded?: boolean;
}

/** Types worth reading. Anything else is a file, and a file is not a page. */
function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type === "application/json" || type.endsWith("+json")) return true;
  if (type === "application/xml" || type.endsWith("+xml")) return true;
  // A lot of documentation is served as these despite being pages.
  return ["application/xhtml+xml", "application/x-www-form-urlencoded"].includes(type);
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError(`不是一个合法的网址：${raw}`, "bad_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(`只支持 http/https 网址，收到的是 ${url.protocol}`, "bad_url");
  }
  // `http://user:pass@host` is a way of putting a secret in a log line.
  if (url.username || url.password) {
    throw new WebFetchError("网址里不能带用户名或密码", "bad_url");
  }
  if (!url.hostname) {
    throw new WebFetchError("网址里没有主机名", "bad_url");
  }
  return url;
}

/**
 * Read at most `cap` bytes and say whether there were more.
 *
 * A stream is read in chunks and abandoned rather than buffered whole: a page
 * that is 2 GB is refused by size, but one that is 2 GB *and* slow should not
 * be allowed to finish first.
 */
async function readCapped(
  res: Response,
  cap: number,
  signal: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      /**
       * Raced against the deadline, not merely governed by one.
       *
       * `AbortSignal.timeout` was passed to `fetch`, which covers the headers
       * and the connection — so a server that answered with headers and then
       * went quiet held this loop open indefinitely. The signal was not
       * carried this far, so `FETCH_TIMEOUT_MS` was not enforced on the body at
       * all, and the tool call sat there with nothing arriving.
       *
       * `reader.read()` does not observe the signal on its own. Raced against
       * it, the read returns when the deadline fires and the body is released.
       */
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: Uint8Array }>((resolve) => {
          if (signal.aborted) {
            resolve({ done: true });
            return;
          }
          signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
        }),
      ]);
      if (chunk.done) break;
      const value = chunk.value!;
    // Slice to what is left of the budget rather than taking the whole chunk:
    // a chunk is whatever the transport felt like sending, and the guarantee
    // is the cap, not the cap plus a chunk.
    const room = cap - bytes;
    if (room <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const take = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += take.byteLength;
      out += decoder.decode(take, { stream: true });
      if (bytes >= cap) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    // The signal fired, or the loop returned: either way the stream must not
    // stay open behind a call that has already decided it is finished.
    void reader.cancel().catch(() => {});
  }
  if (signal.aborted) {
    throw new WebFetchError(
      `读取响应体超时（${Math.round(timeoutMs / 1000)} 秒），已放弃这次抓取。`,
      "unreachable",
    );
  }
  return { text: out, bytes, truncated };
}

/**
 * Follow a URL, checking every hop.
 *
 * `redirect: "manual"` is the point: the platform's own redirect handling would
 * happily walk from a public host to `169.254.169.254` without anything here
 * being consulted again.
 */
export async function fetchPage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  opts: { discover?: boolean; timeoutMs?: number } = {},
): Promise<WebFetchResult> {
  let url = checkUrl(rawUrl.trim());
  let redirects = 0;
  /** Whether a hop left HTTPS for plain HTTP. See `WebFetchResult`. */
  let downgraded = false;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  for (;;) {
    const checkedAddresses = await resolvePublicAddresses(url.hostname);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.5",
          "user-agent": "RelayAB-Assistant/1.0",
        },
      });
    } catch (err) {
      throw new WebFetchError(
        `取不到这个网址：${err instanceof Error ? err.message : String(err)}`,
        "unreachable",
      );
    }

    /**
     * Does the name still resolve somewhere public?
     *
     * The check above and the resolution `fetch` performed are two separate
     * questions asked of the same authority, and nothing ties the answer to the
     * connection that was actually opened. A hostname served with a zero TTL
     * answers them differently, which is how a name that passed the guard ends
     * up connected to a private address.
     *
     * The condition is "the second answer is still public", **not** "the
     * second answer is identical". Set equality was the first version and it
     * refused a real site: `docs.bigmodel.cn` answers from a CDN whose A
     * records rotate between two public pools, so two lookups milliseconds
     * apart legitimately disagree. That is not rebinding — rebinding is a
     * public answer followed by a private one, and `resolvePublicAddresses`
     * already refuses the second. Comparing the sets bought nothing against
     * the attack and cost every round-robin host.
     *
     * This cannot prevent the request — it has already been made — but it can
     * stop the response, and the response is the part that reaches the model
     * and the reader. Discarded rather than returned empty, so a rebind reads
     * as the blocked address it is rather than as a site that happened to be
     * empty.
     */
    const afterAddresses = await tryResolvePublicAddresses(url.hostname);
    if (afterAddresses === null) {
      throw new WebFetchError(
        `这个域名在校验之后换了指向（${checkedAddresses.join(", ")} → ` +
          `解析失败或指向内网），已丢弃这次响应。`,
        "blocked_address",
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new WebFetchError(`重定向没有给出目标地址（HTTP ${res.status}）`, "unreachable");
      }
      if (++redirects > MAX_REDIRECTS) {
        throw new WebFetchError(`重定向超过 ${MAX_REDIRECTS} 次`, "unreachable");
      }
      // Resolved against the current URL, then checked from the top: the next
      // hop's host goes through `resolvePublicAddresses` like the first one did.
      const next = checkUrl(new URL(location, url).toString());
      // Noted, not refused — see `WebFetchResult.downgraded` for why refusing
      // would cost a reachable documentation page and buy nothing here.
      if (url.protocol === "https:" && next.protocol === "http:") downgraded = true;
      url = next;
      continue;
    }

    if (res.status === 404 || res.status === 410) {
      throw new WebFetchError(`这个网址没有内容（HTTP ${res.status}）`, "not_found");
    }
    if (!res.ok) {
      throw new WebFetchError(`对方返回了 HTTP ${res.status}`, "unreachable");
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !isTextual(contentType)) {
      throw new WebFetchError(
        `这个地址返回的是 ${contentType.split(";")[0]}，不是可以阅读的网页`,
        "bad_type",
      );
    }

    const { text, bytes, truncated } = await readCapped(
      res,
      MAX_FETCH_BYTES,
      AbortSignal.timeout(timeoutMs),
      timeoutMs,
    );
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(text);
    const body = isHtml ? htmlToText(text) : text;
    const title = isHtml ? htmlTitle(text) : "";
    const markdown = isHtml ? htmlToMarkdown(text) : "";

    /**
     * The warning a reader has to see before the content, in both spellings.
     *
     * A hop that left HTTPS is not a detail: the body that follows is
     * something a third party could have written, and the reader of this
     * result is a model that will quote it as fact.
     */
    const warning = downgraded
      ? "【注意：这个地址在跳转过程中从 HTTPS 降级到了 HTTP，正文未经加密传输，内容可能被中间人改写。以下内容请谨慎采信。】\n\n"
      : "";

    const page: WebFetchResult = {
      url: rawUrl,
      finalUrl: url.toString(),
      status: res.status,
      contentType,
      bytes,
      truncated,
      ...(title ? { title } : {}),
      ...(markdown ? { markdown: `${warning}${markdown}` } : {}),
      // Prefixed into the text rather than left as a field: the reader of this
      // result is the model, and a flag in a JSON envelope is one more thing to
      // notice while doing something else. A sentence at the top of the content
      // is read as part of the content.
      text: `${warning}${body}`,
      downgraded,
    };

    /*
     * A documentation page whose body did not render is the case this was
     * built for; a page with no body at all is the obvious half of it.
     *
     * The less obvious half is a page that *does* have text — navigation,
     * breadcrumbs, a table of contents — while the actual reference table is
     * filled in client-side. `docs.bigmodel.cn` extracted 7,945 characters of
     * chrome and not one request field, which is above any sensible
     * "empty" threshold and yet exactly the failure being fixed here. So a
     * documentation-shaped URL is probed for its Markdown source even when it
     * looks non-empty: one extra request, and the real page when it exists.
     * Everything else is only probed when the body really is too short.
     */
    const sparse = body.length < DOC_TEXT_MIN_CHARS;
    const docsLike = looksLikeDocumentation(url);
    if (opts.discover === false || !isHtml || (!sparse && !docsLike)) {
      return page;
    }
    return discoverDocs(page, fetchImpl, timeoutMs, sparse, docsLike);
  }
}

/**
 * Is this URL shaped like documentation?
 *
 * Used to decide whether to look for a Markdown source even when the page
 * returned plenty of text. Deliberately generous: a false positive costs one
 * extra request, while a false negative leaves the model reading navigation.
 */
function looksLikeDocumentation(url: URL): boolean {
  if (/^(docs?|wiki|developer|developers|platform|api)\./i.test(url.hostname)) return true;
  return /\/(docs?|api-reference|api|reference|guide|manual|wiki|developers?)(\/|$)/i.test(url.pathname);
}

/**
 * What a documentation site usually serves next to a page that did not render.
 *
 * The three candidates were not guessed from a blog post; each one answered
 * for a site the assistant was actually asked about:
 *
 *  - `<page>.md` — Mintlify (docs.bigmodel.cn, wiki.agnes-ai.cn) serves the
 *    Markdown source at the same path with `.md` appended. This is the single
 *    highest-value probe: it is the *actual* page, not an index of it.
 *  - `/llms.txt` — the emerging convention for an LLM-readable index. It
 *    names every documentation page, which is exactly what a model that
 *    guessed one URL needs.
 *  - `/openapi.json` — the machine-readable API description. For a vendor
 *    whose rendered reference is a JavaScript app, this is the only place the
 *    request and response fields exist in text at all.
 *
 * Everything here is best-effort. A candidate that 404s, answers HTML, or
 * times out is dropped; it must never turn a readable page into an error. That
 * is also why the probes are capped at a shorter timeout — they are a guess,
 * and a guess may not spend the caller's whole budget.
 */
async function discoverDocs(
  page: WebFetchResult,
  fetchImpl: typeof fetch,
  pageTimeoutMs: number,
  sparse: boolean,
  docsLike: boolean,
): Promise<WebFetchResult> {
  const base = new URL(page.finalUrl);
  base.hash = "";
  base.search = "";
  const pathname = base.pathname.replace(/\/+$/, "");

  interface Candidate {
    kind: DiscoveredDoc["kind"];
    url: string;
  }
  const candidates: Candidate[] = [];

  if (pathname && !/\.(md|txt|json)$/i.test(pathname)) {
    candidates.push({ kind: "markdown", url: new URL(`${pathname}.md`, base.origin).toString() });
  }
  // A page that rendered its own body has no need for an index or a schema
  // dump; the Markdown source is the only alternative worth asking for.
  if (sparse) {
    if (!/\/llms\.txt$/i.test(pathname)) {
      candidates.push({ kind: "llms", url: new URL("/llms.txt", base.origin).toString() });
    }
    candidates.push({ kind: "openapi", url: new URL("/openapi.json", base.origin).toString() });
  }

  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const found = await fetchPage(candidate.url, fetchImpl, {
          discover: false,
          // Never longer than the page itself: a probe that outlives the call
          // it is helping has stopped helping.
          timeoutMs: Math.min(PROBE_TIMEOUT_MS, pageTimeoutMs),
        });
        return { candidate, found };
      } catch {
        return null;
      }
    }),
  );

  const discovered: DiscoveredDoc[] = [];
  let markdownText: { text: string; url: string; bytes: number; truncated: boolean } | null = null;

  for (const entry of settled) {
    if (!entry) continue;
    const { candidate, found } = entry;
    // A server that answers every unknown path with its HTML shell would
    // otherwise turn every probe into a "document".
    if (/html/i.test(found.contentType) || /^\s*<(?:!doctype|html)/i.test(found.text)) continue;
    if (!found.text.trim()) continue;

    if (candidate.kind === "markdown") {
      /**
       * Length is a weak test, and on the site this was built for it failed by
       * 86 characters: the extracted shell carried 7,945 characters of
       * navigation while the real Markdown source was 8,031. The Markdown was
       * the correct document and the comparison said no.
       *
       * So a documentation-shaped URL prefers its own Markdown source whenever
       * that source exists and says something. For other sites — where a
       * `.md` sibling could be an unrelated README — the longer-body rule
       * still applies.
       */
      const worthReplacing = docsLike
        ? found.text.trim().length >= 40
        : found.text.length >= 200 && found.text.length > page.text.length;
      if (worthReplacing) {
        markdownText = {
          text: found.text,
          url: found.finalUrl,
          bytes: found.bytes,
          truncated: found.truncated,
        };
        discovered.push({
          url: found.finalUrl,
          kind: "markdown",
          bytes: found.bytes,
          note: "这是同一页的 Markdown 原文，已用它替代抓取到的正文。",
        });
      }
      continue;
    }

    if (candidate.kind === "llms") {
      discovered.push({
        url: found.finalUrl,
        kind: "llms",
        bytes: found.bytes,
        note:
          "这是该站点的文档索引（llms.txt），通常列出全部文档页。" +
          "下面的预览里找与问题相关的条目，再用 fetch_page 打开那一页。",
        preview: found.text.slice(0, 1500),
      });
      continue;
    }

    // OpenAPI: a list of endpoints is worth more than the first few hundred
    // characters of a JSON document, and it is the part a model can act on.
    let paths: string[] | undefined;
    try {
      const parsed = JSON.parse(found.text) as { paths?: Record<string, unknown> };
      if (parsed.paths && typeof parsed.paths === "object") {
        paths = Object.keys(parsed.paths).slice(0, 60);
      }
    } catch {
      // Truncated or not JSON: keep it as a preview instead.
    }
    discovered.push({
      url: found.finalUrl,
      kind: "openapi",
      bytes: found.bytes,
      note:
        paths && paths.length > 0
          ? `这是该站点的 OpenAPI 描述，共列出 ${paths.length} 个端点。` +
            "需要哪个端点就 fetch_page 这个地址，再看 requestBody / responses。"
          : "这是该站点的 OpenAPI 描述文件（可能已截断）。可以直接 fetch_page 它来查字段。",
      ...(paths && paths.length > 0 ? { paths } : { preview: found.text.slice(0, 800) }),
    });
  }

  if (markdownText) {
    return {
      ...page,
      source: "markdown",
      contentType: "text/markdown",
      bytes: markdownText.bytes,
      truncated: markdownText.truncated,
      // The Markdown source *is* Markdown, so it is also the Markdown form of
      // the page: no conversion, and nothing lost.
      markdown: markdownText.text,
      text:
        `【已自动改用该页的 Markdown 原文：${markdownText.url}` +
        `（抓取到的页面正文 ${page.text.length} 字符${sparse ? "，过少" : "，主要是导航"}）】` +
        `\n\n${markdownText.text}`,
      ...(discovered.length > 0 ? { discovered } : {}),
    };
  }

  return discovered.length > 0 ? { ...page, discovered } : page;
}
