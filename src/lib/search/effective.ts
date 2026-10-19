/**
 * src/lib/search/effective.ts
 *
 * What one stored provider row actually says.
 *
 * A row has three possible shapes, and they are read differently on purpose:
 *
 *   1. **A row with a spec.** The spec is the whole truth: it says which
 *      endpoint, which parameters, how the answer is read. The row's address
 *      overrides the spec's own default, because the row is what the operator
 *      edits.
 *
 *   2. **A row without a spec** — one written before the protocol existed. Its
 *      `kind` selects a built-in template, and its address is read the way the
 *      old code read it: for Tavily and Brave the stored address was the
 *      *whole endpoint*, for SearXNG it was the *service root* with `/search`
 *      appended. That difference is exactly what the protocol removes going
 *      forward, and keeping it here is what keeps every working deployment
 *      working.
 *
 *   3. **A row whose kind names no template and which has no spec.** There is
 *      nothing to say about it, and it is skipped rather than guessed at.
 *
 * The point of reading the old rows the old way is that this change must not
 * move a single request. A search that works today has to keep working
 * tomorrow, byte for byte, until somebody edits the row on purpose.
 */
import { parseSearchSpec, type SearchSpec } from "./spec";
import { searchTemplateByKind, searchTemplateById } from "./templates";
import { specDrift, type SpecDrift } from "./drift";

export interface SearchProviderLike {
  kind: string;
  baseUrl: string;
  /** The row's own spec, when it has one. */
  spec?: SearchSpec | null;
}

export interface EffectiveSearchConfig {
  /** The spec that describes the request. */
  spec: SearchSpec;
  /** The service root the spec's path is appended to. */
  baseUrl: string;
  /**
   * The address the operator chose, when they chose one.
   *
   * Null when the vendor's own default is in use. The difference matters for
   * what the panel shows: an operator's address (a self-hosted instance's
   * internal hostname, a proxy) is worth showing an administrator, and a
   * vendor's public default is not.
   */
  operatorAddress: string | null;
  /** The template this came from, when there is one. */
  templateId: string | null;
  /** How the stored copy compares to that template. */
  drift: SpecDrift;
  /**
   * True when the row predates the protocol and is being read the old way.
   *
   * Worth knowing because it explains why an address means something different
   * for this row than for a new one.
   */
  legacy: boolean;
}

/**
 * The effective configuration of one row, or null when the row cannot speak.
 *
 * Null means "this row cannot produce a request": no address to talk to, or a
 * kind that names no template. The caller skips it, which is what the resolver
 * does with an unusable row — an unusable row is skipped, not a reason for
 * every search to fail.
 */
export function effectiveSearchConfig(row: SearchProviderLike): EffectiveSearchConfig | null {
  if (row.spec) {
    const parsed = parseSearchSpec(row.spec);
    if (!parsed.ok) return null;
    const own = row.baseUrl.trim();
    const baseUrl = own || parsed.spec.baseUrl?.trim() || "";
    if (!baseUrl) return null;
    return {
      spec: parsed.spec,
      baseUrl,
      // A row with a spec named its own address, so it is the operator's.
      operatorAddress: own || parsed.spec.baseUrl?.trim() || null,
      templateId: parsed.spec.vendor ?? null,
      drift: specDrift(parsed.spec),
      legacy: false,
    };
  }

  const template = searchTemplateByKind(row.kind) ?? searchTemplateById(row.kind);
  if (!template) return null;

  const stored = row.baseUrl.trim();
  let baseUrl: string;
  let spec: SearchSpec;

  if (!stored) {
    // No address of its own: the template's default, and its path.
    baseUrl = template.spec.baseUrl?.trim() ?? "";
    spec = template.spec;
    if (!baseUrl) return null;
  } else if (template.legacyAddressIncludesPath) {
    // The old code used this address as the whole endpoint. So does this.
    baseUrl = stored;
    spec = { ...template.spec, transport: { ...template.spec.transport, path: "" } };
  } else {
    // The old code appended `/search` to this address. So does this.
    baseUrl = stored;
    spec = template.spec;
  }

  return {
    spec,
    baseUrl,
    operatorAddress: stored || null,
    templateId: template.id,
    drift: specDrift(spec),
    legacy: true,
  };
}

/**
 * The address a request actually goes to, for the panel and for a test.
 *
 * Shown to an operator so that "which URL does this row talk to" is a thing
 * they can read rather than a thing they have to infer from a protocol.
 */
export function effectiveEndpoint(config: EffectiveSearchConfig): string {
  const path = config.spec.transport.path;
  if (!path) return config.baseUrl;
  return `${config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
