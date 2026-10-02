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

/** Enough of a documentation page to answer from, and not a memory problem. */
export const MAX_FETCH_BYTES = 200_000;

/** A page that takes this long to start answering is not a page. */
export const FETCH_TIMEOUT_MS = 20_000;

const MAX_REDIRECTS = 3;

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
  const literal = literalAddress(hostname);
  if (literal) {
    if (isPrivateAddress(literal)) {
      throw new WebFetchError(`不访问内网地址：${literal}`, "blocked_address");
    }
    return;
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

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
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
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytes = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
): Promise<WebFetchResult> {
  let url = checkUrl(rawUrl.trim());
  let redirects = 0;

  for (;;) {
    await assertPublicHost(url.hostname);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new WebFetchError(`重定向没有给出目标地址（HTTP ${res.status}）`, "unreachable");
      }
      if (++redirects > MAX_REDIRECTS) {
        throw new WebFetchError(`重定向超过 ${MAX_REDIRECTS} 次`, "unreachable");
      }
      // Resolved against the current URL, then checked from the top: the next
      // hop's host goes through `assertPublicHost` like the first one did.
      url = checkUrl(new URL(location, url).toString());
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

    const { text, bytes, truncated } = await readCapped(res, MAX_FETCH_BYTES);
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(text);

    return {
      url: rawUrl,
      finalUrl: url.toString(),
      status: res.status,
      contentType,
      bytes,
      truncated,
      text: isHtml ? htmlToText(text) : text,
    };
  }
}
