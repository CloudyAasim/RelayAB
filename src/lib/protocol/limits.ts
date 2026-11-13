/**
 * src/lib/protocol/limits.ts
 *
 * The time a request may take, and who gets to decide it.
 *
 * RelayAB is a relay for vendors it does not control. A vendor's own window is
 * the only fact in this file that is not ours: if H3 needs 600s for a 4K frame
 * and 1000s for the worst case, the relay must be able to wait 1000s. What it
 * must not do is invent a smaller number of its own and dress the resulting
 * failure up as "upstream timeout".
 *
 * There used to be four such numbers, each typed separately — 300000 in the spec
 * validator, 240000 in the media route, `maxDuration = 300` in five routes, and
 * 600s in nginx — and on 2026-11-13 they produced exactly that failure: a spec
 * allowed 300s was aborted at 240s, and the document quoted a serverless ceiling
 * the deployment had not had since 2026-10-01.
 *
 * The model now is one deadline with three guards around it:
 *
 *     the vendor's window  =  limits.timeoutMs  (the only real deadline)
 *     MAX_SPEC_TIMEOUT_MS  =  a sanity bound for typos (second vs millisecond)
 *     HOST_IDLE_TIMEOUT_MS =  what the proxy resets on activity, not a total
 *     CONNECT_TIMEOUT_MS   =  a dead host, not a slow one
 *
 * Nothing in this file knows about a vendor, a model, or a capability.
 */

/**
 * The most a spec may declare — a sanity check, not a platform limit.
 *
 * An earlier version of this constant documented "300000 is the serverless
 * ceiling". The deployment left serverless on 2026-10-01; the constant stayed,
 * the document repeated it, and two specs were saved against a limit that no
 * longer existed. A bound whose only job is to catch `600` meaning six hundred
 * *milliseconds* should be far away from any real vendor window, so that it can
 * never be mistaken for one.
 */
export const MAX_SPEC_TIMEOUT_MS = 3_500_000;

/** What a spec means when it declares no `limits.timeoutMs`. */
export const DEFAULT_SPEC_TIMEOUT_MS = 240_000;

/**
 * How long the reverse proxy waits for *activity*, not for the whole response.
 *
 * nginx's `proxy_read_timeout` is an idle timer: every byte the application
 * writes resets it. That is why a long generation can survive behind it as long
 * as something keeps arriving — see `lib/http/heartbeat.ts`. The number below is
 * the template's value (`deploy/nginx.conf`); the guard keeps the two in step.
 */
export const HOST_IDLE_TIMEOUT_MS = 3_600_000;

/**
 * How often a long media call writes a keep-alive byte.
 *
 * Well under any sane idle timeout, and cheap enough to be invisible: the bytes
 * are JSON-significant whitespace, so the body still parses as the same document
 * when the real answer finally arrives.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a media call may run before the response starts heartbeating.
 *
 * Below the shortest idle timeout worth supporting, so a proxy with a 30s window
 * is still kept alive; a fast call never pays for the streaming response and
 * keeps its real status code.
 */
export const HEARTBEAT_AFTER_MS = 20_000;

/** A socket that never connects is a dead host, not a slow generation. */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Upload ceilings, per file.
 *
 * Audio is larger than image because a transcription of a real recording is
 * routinely minutes long; the numbers are vendor-documented and used by both the
 * public routes and the assistant's media test.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
