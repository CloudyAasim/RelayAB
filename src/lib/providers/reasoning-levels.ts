/**
 * A reasoning level is a value the model accepts. It is not the name of a field
 * in the error that told you so.
 *
 * Nine models on one deployment carried `["http_code", "request_id", "low",
 * "medium", "high", "xhigh", "max"]` — the first two read straight out of a
 * vendor's error envelope by a parser that scanned for identifiers and found an
 * object's keys. That parser is gone; the data is not, and the write path has
 * no reason to accept those names again.
 *
 * A closed list rather than a shape test, on purpose. A heuristic that decides
 * "this looks like a field" would eventually reject a level a vendor really does
 * call something odd. These specific names are not levels under any spelling
 * anybody has ever published, and a filter that says so cannot be wrong.
 *
 * Applied on the way **in** only. A stored value is read back as it is, because
 * refusing to parse a row over one bad field would take a provider offline to
 * complain about a label.
 */
const ENVELOPE_NAMES = new Set([
  "code",
  "http_code",
  "status",
  "status_code",
  "request_id",
  "trace_id",
  "id",
  "type",
  "message",
  "msg",
  "detail",
  "error",
  "error_code",
  "errors",
  "error_msg",
  "param",
  "parameter",
  "field",
  "reason",
]);

/**
 * Keep the levels that can be levels, in the order they were written.
 *
 * Order matters — a vendor lists them from quietest to loudest — and blank
 * entries are dropped rather than becoming an empty level.
 */
export function sanitizeLevelList(input: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    if (ENVELOPE_NAMES.has(name.toLowerCase())) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
