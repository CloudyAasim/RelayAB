/**
 * src/lib/proxy/types.ts
 *
 * The shapes every proxy face and every dialect speaks in.
 *
 * Nothing here does any work: these are the request shapes, the result
 * shape and the stream-usage row, shared so that no two modules can drift
 * on what a proxy answer looks like.
 */

import type { Provider } from "../db/types";
import type { CacheBuckets } from "../quota/rates";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProxyResult {
  ok: boolean;
  status: number;
  /** Either an OpenAI ChatCompletion (or SSE stream) or a RelayAB error. */
  data?: unknown;
  /**
   * Set when the upstream body should be piped straight through to the client
   * instead of being buffered and re-serialized (used for SSE streaming).
   */
  body?: ReadableStream<Uint8Array>;
  /** Content-Type to use together with `body`. */
  contentType?: string;
  /**
   * Present whenever `ok` is false. It is optional rather than required because
   * `ok` is a plain boolean, so the type cannot tie the two together — a
   * discriminated union would, but it makes every test that pokes at a result
   * narrow first, which cost more than the guarantee is worth here. Readers
   * narrow it themselves; `respond.ts` is the one that has to.
   */
  error?: { code: string; message: string };
}

export interface ProxyDeps {
  fetchImpl?: typeof fetch;
  /** Override the upstream URL (for tests). */
  upstreamUrlFor?: (provider: Provider) => string;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface ChatCompletionRequest {
  model: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  [k: string]: unknown;
}

export interface ResponseAPIRequest {
  model: string;
  input?: string | Array<{ type: string; content?: string; audio?: unknown }>;
  tools?: unknown[];
  stream?: boolean;
  [k: string]: unknown;
}

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * The upstream's prompt-cache buckets, in this gateway's spelling.
   *
   * Carried alongside the counts rather than folded into them: the counts are
   * what quota modes are derived from, and adding the cache to them would
   * inflate a token total that has to stay comparable with every older row.
   */
  cache: CacheBuckets;
}
