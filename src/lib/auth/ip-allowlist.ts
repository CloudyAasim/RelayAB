/**
 * src/lib/auth/ip-allowlist.ts
 *
 * Which client addresses may use a given API key.
 *
 * A key is a bearer token: whoever holds it can spend the owner's credits.
 * That is fine when the key never leaves one machine, and it is not fine when
 * the key is pasted into a website, a CI file, or a chat window. An allowlist
 * of client addresses is the cheapest way to make a stolen key useless
 * somewhere else, and it is the same idea New API calls `allow_ips`.
 *
 * ## What a rule may be
 *
 *   `203.0.113.7`      exactly that address
 *   `203.0.113.0/24`   a network (IPv4 only)
 *   `::1`              an IPv6 address, exactly
 *
 * IPv6 networks (`::/0`-style prefixes) are **not** supported and are
 * rejected when a rule is saved, rather than silently matching nothing. A
 * rule that looks like it works and does not is the worst outcome available:
 * the operator believes the key is locked down, and it is not.
 *
 * An empty allowlist means "no restriction" — the same shape as an empty
 * model whitelist elsewhere in this codebase.
 */

/**
 * The client's address, as far as the platform in front of us knows it.
 *
 * `x-forwarded-for` is trusted only as far as that platform: a client can
 * forge the header. What it buys is the real address in the common case,
 * where a proxy sets it correctly and appends to it. A forged value can let
 * somebody past the allowlist, which is why the allowlist is a second lock
 * on a key rather than the only one.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    // The left-most entry is the original client; the rest are proxies.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return "";
}

/**
 * Split a stored allowlist into rules.
 *
 * Stored as one string so it lives in a TEXT column like every other
 * configured value in this database. Commas, semicolons and newlines all
 * separate, because people paste these three ways.
 */
export function parseIpAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Check a rule for a shape this module can honour.
 *
 * Returns the reason a rule is unusable, or null when it is fine.
 */
export function ipRuleProblem(rule: string): string | null {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return "rule is empty";
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return parseIpv4(trimmed) !== null || parseIpv6(trimmed) !== null
      ? null
      : "not an IP address";
  }
  const address = trimmed.slice(0, slash);
  const prefix = trimmed.slice(slash + 1);
  if (parseIpv4(address) === null) {
    // An IPv6 prefix is refused rather than ignored: see the file header.
    return parseIpv6(address) !== null
      ? "IPv6 networks are not supported — use exact addresses"
      : "not an IP address";
  }
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    return "prefix must be between 0 and 32";
  }
  return null;
}

/**
 * Whether a client address may use a key with this allowlist.
 *
 * An empty allowlist allows everything. A non-empty one allows an address
 * that matches any rule — exactly, or inside an IPv4 network.
 */
export function ipAllowed(clientIp: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  const address = normalizeIp(clientIp);
  if (!address) return false;
  return allowList.some((rule) => ruleMatches(address, rule.trim()));
}

/** Whether one address matches one rule. */
function ruleMatches(address: string, rule: string): boolean {
  if (rule.length === 0) return false;
  const slash = rule.indexOf("/");
  if (slash === -1) return address === normalizeIp(rule);

  const network = rule.slice(0, slash);
  const bits = Number(rule.slice(slash + 1));
  const client = parseIpv4(address);
  const net = parseIpv4(network);
  if (client === null || net === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((client & mask) >>> 0) === ((net & mask) >>> 0);
}

/**
 * Put an address in the one form this module compares.
 *
 * An IPv4 address wrapped in IPv6 (`::ffff:203.0.113.7`, which is what a
 * socket on a v6 stack hands you for a v4 peer) is unwrapped, so a rule
 * written as plain IPv4 matches the address as the proxy reported it.
 */
export function normalizeIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "";
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(trimmed);
  if (mapped) {
    const parsed = parseIpv4(mapped[1]);
    return parsed === null ? "" : mapped[1];
  }
  if (parseIpv4(trimmed) !== null) return trimmed;
  if (parseIpv6(trimmed) !== null) return trimmed;
  return "";
}

/** Parse a dotted-quad into a 32-bit integer, or null. */
function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Whether a string is a plausible IPv6 address.
 *
 * Not a full parser — it only has to answer "is this a rule we can compare
 * exactly", and the comparison is a string comparison of the normalised
 * form. Rejecting a malformed address here is what keeps it out of the
 * comparison as a rule that could never match.
 */
function parseIpv6(value: string): string | null {
  if (!value.includes(":")) return null;
  if (!/^[0-9a-f:.]+$/.test(value)) return null;
  // A double colon may appear at most once.
  if (value.indexOf("::") !== value.lastIndexOf("::")) return null;
  return value;
}
