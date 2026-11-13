/**
 * src/lib/protocol/limits.ts
 *
 * The numbers that bound a request, in one place and in the order they apply.
 *
 * RelayAB is a relay, not a client for one vendor: the upstreams change, their
 * limits change, and the host changes. What must not change is the *ordering*
 * between the layers, and that ordering used to be re-typed as a literal in
 * every layer — 300000 in the spec validator, 240000 in the media route, 600s in
 * nginx, 30s in the `$fetch` wrapper — with the numbers drifting apart. On
 * 2026-11-13 that produced two symptoms in one week: a spec allowed 300s was
 * aborted by its own route at 240s, and the document quoted a "serverless
 * ceiling" that had not existed since the move to Dokku.
 *
 * So the values live here and the *relationships* are what the guard pins
 * (`tests/unit/request-limits.test.ts`):
 *
 *     spec timeout  ≤  route abort  ≤  host allowance
 *
 * Raise the host and only `HOST_REQUEST_CEILING_MS` moves; the others derive
 * from it. Nothing in this file knows about a vendor.
 */

/**
 * What the reverse proxy will wait for.
 *
 * `deploy/nginx.conf` sets `proxy_read_timeout 600s`. A request that outlives it
 * is killed by nginx, not by us — and the client gets a connection error instead
 * of the error envelope this app builds.
 */
export const HOST_REQUEST_CEILING_MS = 600_000;

/**
 * What the application allows itself, measured from the first byte of work.
 *
 * Under the host's allowance, so a slow request fails *here* — with a readable
 * error — instead of being cut off by the proxy. The route passes this as its
 * `AbortSignal` timeout.
 */
export const REQUEST_BUDGET_MS = 580_000;

/**
 * The most a spec may declare in `limits.timeoutMs`.
 *
 * Below the request budget on purpose: the spec's own deadline should fire
 * first (it can say something specific about the vendor), leaving the route's
 * abort as the backstop rather than the thing that reports the failure.
 */
export const MAX_SPEC_TIMEOUT_MS = 570_000;

/** What a spec means when it declares no `limits.timeoutMs`. */
export const DEFAULT_SPEC_TIMEOUT_MS = 240_000;

/**
 * Upload ceilings, per file.
 *
 * Audio is larger than image because a transcription of a real recording is
 * routinely minutes long; the numbers are vendor-documented and used by both the
 * public routes and the assistant's media test.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
