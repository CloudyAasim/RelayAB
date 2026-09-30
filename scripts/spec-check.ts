/**
 * scripts/spec-check.ts — the judge.
 *
 * A spec is data, so the only trustworthy way to review one is to *run* it. This
 * script is the closed loop the protocol documentation cannot be:
 *
 *   pnpm spec-check <file.json>        # { models, specs } | [ …specs ] | { …spec }
 *
 * It does two halves:
 *
 *   PART 1  static — validation, the exact upstream request that would be sent,
 *           and a handful of heuristics that catch the mistakes which never
 *           fail at save time.
 *   PART 2  probes — each spec is executed against a *synthesized* upstream.
 *             The stub response is derived from the spec's own `response`
 *             mapping, so no fixtures are needed for a new vendor: happy path,
 *             vendor error, HTTP-status error, async convergence, async failure,
 *             encoding, empty result, n limit.
 *
 * Nothing here touches the network or needs an API key.
 *
 * Why it exists: every real incident with this protocol was a spec that saved
 * cleanly and failed on a live request (hex mis-declared, a poll path with the
 * segments swapped, `itemsB64` silently ignored, a required upstream field
 * never sent). Read the JSON, however carefully, and you cannot see those. You
 * can see them here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMediaSpec, validateMediaSpecs, type MediaSpec } from "../src/lib/media/spec";
import { applyMapping, buildMediaScope, executeMedia } from "../src/lib/media/engine";
import { encryptSecret } from "../src/lib/crypto/secrets";

/**
 * The engine encrypts/decrypts the provider key, so a probe needs a real
 * (throwaway) ciphertext. Load the repo's own env if present, and otherwise
 * invent a master key — the value never leaves this process, and the alternative
 * is a linter that refuses to run on a fresh clone.
 *
 * This must run before the first `encryptSecret()` call; the helper reads config
 * lazily, so a static import above is fine.
 */
function bootstrapCrypto(): void {
  for (const file of [".env.local", ".env"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
  if (!process.env.RELAY_AUTH) {
    process.env.RELAY_AUTH = "spec-check-probe-key-not-a-real-secret";
  }
}

bootstrapCrypto();

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);
const dim = (t: string) => paint("90", t);
const bold = (t: string) => paint("1", t);

export interface CheckResult {
  ok: boolean;
  passed: number;
  failed: number;
  lines: string[];
}

function line(mark: "pass" | "fail" | "warn" | "info", label: string, detail = ""): string {
  const icon =
    mark === "pass" ? green("  ✓") : mark === "fail" ? red("  ✗") : mark === "warn" ? yellow("  !") : dim("  ·");
  return `${icon} ${label}${detail ? dim(`  ${detail}`) : ""}`;
}

// ---------------------------------------------------------------------------
// Response-mapping introspection
//
// To synthesize an upstream payload we must first learn what the spec *reads*.
// `readPaths` walks a mapping tree and returns the payload paths it depends on,
// tracking the scope switches introduced by `$from` (array element scope) and
// `$file` / `$dataUrl` (input-side, ignored for responses).
// ---------------------------------------------------------------------------

export interface PathRead {
  /** Path in the upstream payload, `[*]` marking an array element scope. */
  path: string;
  /** The `kind` the surrounding item declares, when there is one. */
  kind?: string;
  /** The `encoding` the surrounding item declares, when there is one. */
  encoding?: string;
  /** The contract field this read feeds (`items`, `status`, …). */
  field?: string;
  /** The `$fetch` template waiting on this value, if any. */
  fetchUrl?: string;
  fetchPick?: string;
  /**
   * `$ifPresent` branch id. The branches of one `$ifPresent` are mutually
   * exclusive at runtime, so only the first is populated when synthesizing.
   */
  branch?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `$.a.b[0].c[*]` → `["a","b","[0]","c","[*]"]`.
 *
 * Array segments are kept as `[0]` / `[*]` so `setAtPath` can build the same
 * array shape the spec expects to read.
 */
function segments(path: string): string[] {
  const body = path.replace(/^\$\.?/, "");
  const out: string[] = [];
  for (const part of body.split(".")) {
    if (!part) continue;
    const match = /^([^[\]]*)([\s\S]*)$/.exec(part);
    if (!match) continue;
    if (match[1]) out.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+|\*)\]/g)) out.push(`[${index[1]}]`);
  }
  return out;
}

/** Concatenate a scope prefix with a relative path: `joinScope("a.b", "$.c")` → `a.b.c`. */
function joinScope(scope: string, path: string): string {
  const parts = segments(path);
  if (scope === "") return parts.join(".");
  return [...segments(scope), ...parts].join(".");
}

function addRead(reads: PathRead[], read: PathRead): void {
  if (read.path === "") return;
  const existing = reads.find(
    (r) => r.path === read.path && r.field === read.field && r.kind === read.kind,
  );
  if (existing) return;
  reads.push(read);
}

export function readPaths(
  node: unknown,
  scope = "",
  field?: string,
  kind?: string,
  encoding?: string,
  reads: PathRead[] = [],
): PathRead[] {
  if (node === null || node === undefined) return reads;

  if (typeof node === "string") {
    if (node === "$") addRead(reads, { path: scope, field, kind, encoding });
    else if (node.startsWith("$")) addRead(reads, { path: joinScope(scope, node), field, kind, encoding });
    else if (node.includes("{{")) {
      for (const match of node.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        addRead(reads, { path: joinScope(scope, `$.${match[1].trim()}`), field, kind, encoding });
      }
    }
    return reads;
  }
  if (typeof node === "number" || typeof node === "boolean") return reads;
  if (Array.isArray(node)) {
    // A literal array (e.g. `content: [{type:"text", text:"$.prompt"}]`) keeps
    // the same scope for its entries.
    node.forEach((entry) => readPaths(entry, scope, field, kind, encoding, reads));
    return reads;
  }
  if (!isRecord(node)) return reads;

  if ("$const" in node) return reads;
  if ("$eq" in node) {
    (Array.isArray(node.$eq) ? node.$eq : []).forEach((side) =>
      readPaths(side, scope, field, kind, encoding, reads),
    );
    return reads;
  }
  if ("$enum" in node && isRecord(node.$enum)) {
    if (typeof node.$enum.path === "string") {
      addRead(reads, { path: joinScope(scope, node.$enum.path), field, kind, encoding });
    }
    readPaths(node.$enum.default, scope, field, kind, encoding, reads);
    return reads;
  }
  if ("$mapSize" in node && isRecord(node.$mapSize)) {
    if (typeof node.$mapSize.path === "string") {
      addRead(reads, { path: joinScope(scope, node.$mapSize.path), field, kind, encoding });
    }
    return reads;
  }
  if ("$ifPresent" in node) {
    const branches = Array.isArray(node.$ifPresent) ? node.$ifPresent : [node.$ifPresent];
    branches.forEach((branch, branchIndex) => {
      if (!isRecord(branch)) return;
      for (const [probe, mapping] of Object.entries(branch)) {
        // The presence probe itself is how the branch is chosen, so it always
        // gets a value; the branch's own reads are tagged so synthesis can fill
        // exactly one branch (they are mutually exclusive at runtime).
        addRead(reads, { path: joinScope(scope, probe), field, kind, encoding, branch: branchIndex });
        readPaths(mapping, scope, field, kind, encoding, reads).forEach((read) => {
          read.branch = branchIndex;
        });
      }
    });
    return reads;
  }
  if ("$firstPresent" in node) {
    for (const candidate of Array.isArray(node.$firstPresent) ? node.$firstPresent : []) {
      readPaths(candidate, scope, field, kind, encoding, reads);
    }
    return reads;
  }
  if ("$toString" in node) return readPaths(node.$toString, scope, field, kind, encoding, reads);
  if ("$dataUrl" in node) return readPaths(node.$dataUrl, scope, field, kind, encoding, reads);
  if ("$file" in node && isRecord(node.$file)) {
    // The file itself comes from the request scope; recording it keeps the
    // "did you actually map an input?" heuristics honest for multipart specs.
    if (typeof node.$file.path === "string") {
      addRead(reads, { path: joinScope(scope, node.$file.path), field, kind, encoding });
    }
    return reads;
  }
  if ("$merge" in node) {
    for (const part of Array.isArray(node.$merge) ? node.$merge : [node.$merge]) {
      readPaths(part, scope, field, kind, encoding, reads);
    }
    return reads;
  }
  if ("$fetch" in node && isRecord(node.$fetch)) {
    if (typeof node.$fetch.path === "string") {
      addRead(reads, {
        path: joinScope(scope, node.$fetch.path),
        field,
        kind,
        encoding,
        fetchUrl: String(node.$fetch.url ?? ""),
        fetchPick: node.$fetch.pick ? String(node.$fetch.pick) : undefined,
      });
    }
    for (const match of String(node.$fetch.url ?? "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      addRead(reads, { path: joinScope(scope, `$.${match[1].trim()}`), field, kind, encoding });
    }
    return reads;
  }
  if ("$from" in node) {
    // The source is an array at `scope + $from`; each element becomes the scope
    // for `$to`.
    const source = joinScope(scope, String(node.$from));
    const inner = isRecord(node.$to) ? node.$to : "$";
    const itemKind = isRecord(inner) && typeof inner.kind === "string" ? inner.kind : undefined;
    const itemEncoding = isRecord(inner) && typeof inner.encoding === "string" ? inner.encoding : undefined;
    readPaths(inner, `${source}[*]`, field, itemKind, itemEncoding, reads);
    return reads;
  }

  // A plain object: contract keys are well known, everything else is literal.
  // A literal item (`{"kind": "url", "value": "$.a"}`) carries its own `kind`
  // /`encoding` for the child, which is what makes the heuristics able to see
  // "this item claims to be a url".
  const ownKind = typeof node.kind === "string" ? node.kind : kind;
  const ownEncoding = typeof node.encoding === "string" ? node.encoding : encoding;
  for (const [key, value] of Object.entries(node)) {
    readPaths(value, scope, key, ownKind, ownEncoding, reads);
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Payload synthesis
// ---------------------------------------------------------------------------

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = segments(path);
  let cursor: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part.startsWith("[")) {
      if (!Array.isArray(cursor)) return;
      const raw = part.slice(1, -1);
      const index = raw === "*" ? 0 : Number(raw);
      if (last) {
        cursor[index] = value;
        return;
      }
      if (cursor[index] === undefined) cursor[index] = {};
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null) return;
    const target = cursor as Record<string, unknown>;
    if (last) {
      target[part] = value;
      return;
    }
    // The next segment decides the container type: `[0]` means array, `k` means object.
    if (target[part] === undefined) target[part] = parts[i + 1]?.startsWith("[") ? [] : {};
    cursor = target[part];
  }
}

const SAMPLE_VALUES: Record<string, unknown> = {
  // Keys the vendor commonly uses for a produced artefact.
  image_urls: ["https://cdn.example.test/probe.png"],
  image_base64: ["QUJDRA=="],
  urls: ["https://cdn.example.test/probe.mp4"],
  url: "https://cdn.example.test/probe.png",
  video_url: "https://cdn.example.test/probe.mp4",
  download_url: "https://cdn.example.test/probe.mp4",
  audio: "49443304000000fffb90c4",
  b64_json: "QUJDRA==",
  text: "probe transcript",
  task_id: "probe-task-id",
  file_id: "205258526306433",
  id: "probe-id",
  trace_id: "probe-trace-id",
  status_code: 0,
  status_msg: "success",
  success_count: 1,
  message: "probe",
};

function sampleFor(read: PathRead, spec: MediaSpec): unknown {
  const leaf = read.path.split(".").pop() ?? "";
  if (read.field === "status") {
    const map = spec.async?.poll.statusMap;
    if (map) {
      const ok = Object.entries(map).find(([, target]) => target === "ok");
      if (ok) return ok[0];
    }
    return (spec.async?.poll.successValues ?? ["Success"])[0] ?? "Success";
  }
  if (read.field === "taskId") return "probe-task-id";
  if (read.field === "successCount") return 1;
  if (read.field === "text") return "probe transcript";
  if (read.field === "errorCode" || read.field === "errorMessage") return undefined;
  if (read.kind === "base64" && read.encoding === "hex") return "49443304000000fffb90c4";
  if (read.kind === "base64") return "QUJDRA==";
  if (read.kind === "text") return "probe text";
  if (read.kind === "url") return "https://cdn.example.test/probe.mp4";
  if (leaf in SAMPLE_VALUES) return SAMPLE_VALUES[leaf];
  return "probe";
}

/** Build an upstream payload that satisfies everything the spec's response reads. */
export function synthesizePayload(spec: MediaSpec): Record<string, unknown> {
  const reads = readPaths(spec.response);
  const root: Record<string, unknown> = {};
  // Only the first `$ifPresent` branch is populated: the others cannot be
  // present at the same time, so filling all of them would make the probe
  // succeed for the wrong reason.
  const seenBranches = new Set<number>();
  for (const read of reads) {
    if (read.branch !== undefined) {
      if (seenBranches.has(read.branch)) continue;
      seenBranches.add(read.branch);
    }
    const value = sampleFor(read, spec);
    if (value === undefined) continue;
    setAtPath(root, read.path, value);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Real vendor responses
//
// Everything above is circular: the payload is built from the spec's own claims,
// so a spec that points at a field the vendor never returns looks perfect. The
// fix is to let the caller supply what the vendor *actually* returns — a curl
// response pasted out of the docs, or a capture from a real call:
//
//   { "specs": [ … ], "fixtures": { "image.generate": { "data": { "image_urls": [ … ] } } } }
//
// Lookup order: `displayName` → client model name → `capability` → `"*"`.
// ---------------------------------------------------------------------------

export type Fixtures = Record<string, unknown>;

/** A fixture may be one body, or one body per async phase. */
interface PhasedFixture {
  submit?: unknown;
  poll?: unknown;
  /** True when the fixture declares the two phases separately. */
  phased: boolean;
}

function isPhased(value: unknown): value is PhasedFixture {
  return isRecord(value) && ("submit" in value || "poll" in value);
}

export function fixtureFor(
  spec: MediaSpec,
  fixtures: Fixtures | null,
): { key: string; body: PhasedFixture } | null {
  if (!fixtures) return null;
  const candidates = [
    spec.displayName,
    ...(spec.models ?? []),
    spec.capability,
    "*",
  ].filter((key): key is string => typeof key === "string" && key.length > 0);
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(fixtures, key)) continue;
    const value = fixtures[key];
    // An async spec gets a fresh `id` on submit and the artefact on poll, so a
    // single captured body can never satisfy both phases.
    if (isPhased(value)) return { key, body: value };
    if (spec.async) return { key, body: { submit: value, poll: value, phased: false } };
    return { key, body: { submit: value, poll: value, phased: false } };
  }
  return null;
}

/** Response keys that describe alternative shapes of one product. */
const ALTERNATIVE_ROOTS = new Set(["items", "itemsB64"]);

export interface PathMismatch {
  path: string;
  problem: string;
}

/** Resolve a path the way `getPath` would, but report *why* it came up short. */
function inspectPath(root: unknown, path: string): PathMismatch | null {
  const parts = segments(path);
  let cursor: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("[")) {
      if (!Array.isArray(cursor)) {
        return { path, problem: `期望数组，实际是 ${describe(cursor)}` };
      }
      const index = part.slice(1, -1) === "*" ? 0 : Number(part.slice(1, -1));
      if (cursor[index] === undefined) return { path, problem: "数组越界（上游返回了空数组）" };
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor)) {
      return { path, problem: `期望对象，实际是 ${describe(cursor)}` };
    }
    if (!(part in cursor)) {
      return {
        path,
        problem: `上游没有这个字段（同层的字段有：${Object.keys(cursor).slice(0, 6).join(", ") || "无"}）`,
      };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor === undefined || cursor === null) return { path, problem: "字段存在但值为空" };
  if (typeof cursor === "string" && cursor.length === 0) return { path, problem: "字段是空字符串" };
  return null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  if (typeof value === "object") return "对象";
  return `${typeof value}(${JSON.stringify(value)?.slice(0, 20) ?? ""})`;
}

/**
 * Compare a spec's declared response reads against real vendor responses.
 *
 * This is the only check in the file that can catch "the field I read does not
 * exist" — the Zhipu image spec read `data.url` while the vendor returns
 * `image_result[].url`, and every synthesized probe passed anyway.
 *
 * With two phases, a read is satisfied by whichever phase has it (the task id
 * only ever appears in the submit response, the artefact only in the poll one).
 */
export function diffAgainstFixture(
  spec: MediaSpec,
  body: PhasedFixture,
): { mismatches: PathMismatch[]; notes: PathMismatch[]; matched: number } {
  const reads = readPaths(spec.response);
  const owners = rootOwners(spec, reads);
  const seenBranches = new Set<number>();
  const problems: (PathMismatch & { root?: string })[] = [];
  let matched = 0;
  const phases: [string, unknown][] = [];
  if (body.submit !== undefined) phases.push(["submit", body.submit]);
  if (body.poll !== undefined) phases.push(["poll", body.poll]);
  if (phases.length === 0) phases.push(["响应", body.submit]);

  const failed = new Set<string>();
  for (const read of reads) {
    // A `$ifPresent` branch that is not taken is a legitimate miss, so only the
    // first branch is required to resolve.
    if (read.branch !== undefined) {
      if (seenBranches.has(read.branch)) continue;
      seenBranches.add(read.branch);
    }
    if (read.field === "errorCode" || read.field === "errorMessage") continue;

    const owner = owners.get(read.path);
    const phaseProblems = phases
      .map(([, value]) => inspectPath(value, read.path))
      .filter((problem): problem is PathMismatch => problem !== null);
    if (phaseProblems.length === phases.length && phases.length > 0) {
      const fieldHint = read.field ? `（映射到 ${read.field}）` : "";
      // Name the sibling fields from every phase: "which field *do* you mean?"
      // is the question the operator actually has, and with two phases the
      // answer may be in the one that was not quoted.
      const siblings = new Set<string>();
      for (const [, value] of phases) collectSiblings(value, read.path, siblings);
      const hint = siblings.size > 0 ? `；上游同层字段：${[...siblings].slice(0, 8).join(", ")}` : "";
      failed.add(read.path);
      problems.push({ path: read.path, problem: `${fieldHint}${phaseProblems[0].problem}${hint}`, root: owner });
    } else {
      matched += 1;
    }
  }

  // `items` and `itemsB64` are alternative shapes of the *same* product, so a
  // response captured in url format legitimately has no base64 array. Treat
  // them as one group: if any member resolved, the group's other members are
  // notes rather than failures. A group where nothing resolved is a genuine
  // problem — which is how the Zhipu `data.url` case gets caught.
  const groupOf = (root: string | undefined): string | undefined =>
    root !== undefined && ALTERNATIVE_ROOTS.has(root) ? "items" : root;
  const satisfiedGroups = new Set(
    reads
      .filter((r) => !failed.has(r.path))
      .map((r) => groupOf(owners.get(r.path)))
      .filter((group): group is string => !!group),
  );
  const mismatches: PathMismatch[] = [];
  const notes: PathMismatch[] = [];
  for (const problem of problems) {
    const group = groupOf(problem.root);
    if (group !== undefined && satisfiedGroups.has(group)) {
      notes.push({ path: problem.path, problem: "该形态未出现（属正常）" });
    } else {
      mismatches.push({ path: problem.path, problem: problem.problem });
    }
  }
  return { mismatches, notes, matched };
}

/**
 * Field names present alongside `path`, for the "did you mean…?" hint.
 *
 * Falls back to the payload's root keys when the path cannot be walked at all,
 * which is exactly the case the hint exists for: the path is wrong *because*
 * the field is missing, so the parent lookup fails too.
 */
function collectSiblings(root: unknown, path: string, out: Set<string>): void {
  const parts = segments(path);
  if (parts.length < 2) return;
  let cursor: unknown = root;
  let reached = true;
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith("[")) {
      if (!Array.isArray(cursor)) {
        reached = false;
        break;
      }
      const index = part.slice(1, -1) === "*" ? 0 : Number(part.slice(1, -1));
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor)) {
      reached = false;
      break;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (reached && isRecord(cursor)) {
    for (const key of Object.keys(cursor)) out.add(key);
    return;
  }
  if (isRecord(root)) for (const key of Object.keys(root)) out.add(key);
}

/**
 * Map every response read to the top-level response key that produced it.
 *
 * Threading the key through `readPaths` is fragile (`$from` and the transform
 * branches all re-enter the walker), so ownership is derived after the fact:
 * a path belongs to key K when re-reading `response[K]` produces it.
 */
function rootOwners(spec: MediaSpec, reads: PathRead[]): Map<string, string> {
  const owners = new Map<string, string>();
  const response = isRecord(spec.response) ? spec.response : {};
  for (const [key, value] of Object.entries(response)) {
    if (value === undefined || value === null) continue;
    for (const read of readPaths(value)) {
      if (!owners.has(read.path)) owners.set(read.path, key);
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// Representative client inputs
// ---------------------------------------------------------------------------

const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  "image.generate": { prompt: "a cat", n: 1, size: "1024x1024" },
  "image.edit": { prompt: "a cat", image: "data:image/png;base64,QUJDRA==", n: 1, size: "1024x1024" },
  "video.generate": { prompt: "a wave", n: 1, size: "1280x720" },
  "audio.tts": { input: "hello", voice: "English_Graceful_Lady", speed: 1, responseFormat: "mp3" },
  "audio.stt": { image: "data:audio/mpeg;base64,QUJDRA==", filename: "probe.mp3", language: "en" },
  "music.generate": { prompt: "lo-fi beats", lyrics: "la la la" },
};

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface Probe {
  name: string;
  docRef: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

function fakeProvider(): Parameters<typeof executeMedia>[0]["provider"] {
  return {
    id: "probe",
    name: "probe",
    baseUrl: "https://api.example.test",
    // A real ciphertext of a throwaway key: the engine decrypts it on every
    // call, so a fake blob would fail before the mapping is even reached.
    encryptedApiKey: encryptSecret("probe-key"),
    enabled: true,
    priority: 1,
    models: {},
    specs: [],
    createdAt: "",
    updatedAt: "",
  };
}

async function runSpec(
  spec: MediaSpec,
  input: Record<string, unknown>,
  upstream: (url: string, init: RequestInit) => Response,
): Promise<{ ok: boolean; detail: string; items: number; text?: string; status?: number; code?: string }> {
  const out = await executeMedia({
    spec,
    provider: fakeProvider(),
    input: buildMediaScope({ model: "probe-model", ...input }),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) =>
      upstream(String(url), init)) as unknown as typeof fetch,
  });
  if (out.ok) {
    const items = out.result.items.length;
    const text = out.result.text;
    return {
      ok: true,
      // `audio.stt` has no items by design; text *is* its product.
      detail: items > 0 ? `${items} item(s)` : text ? `text: ${JSON.stringify(text)}` : "0 item(s)",
      items,
      ...(text !== undefined ? { text } : {}),
    };
  }
  return { ok: false, detail: out.error.message, items: 0, status: out.error.status, code: out.error.code };
}

function probesFor(spec: MediaSpec, label: string, fixtures: Fixtures | null): Probe[] {
  const probes: Probe[] = [];
  const jsonMode = (spec.responseMode ?? "json") === "json";
  const sampleInput = SAMPLE_INPUT[spec.capability] ?? { prompt: "probe" };
  const payload = synthesizePayload(spec);
  const fixture = fixtureFor(spec, fixtures);

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /**
   * A stub upstream that answers the submit path, the poll path, and — crucially
   * — anything else, which is how a `$fetch` follow-up is recognised. Without
   * the third case a `$fetch` probe silently picks nothing and reports a
   * contract mismatch that has nothing to do with the spec.
   */
  const makeUpstream = (body: () => unknown, status = 200, phased?: PhasedFixture) => (url: string) => {
    const submitPath = spec.transport.path.split("?")[0].replace(/\{\{.*?\}\}/g, "");
    const pollPath = spec.async
      ? (spec.async.poll.path.split("?")[0].split("{{taskId}}")[0] ?? "")
      : "";
    const isKnownPath = url.includes(submitPath) || (pollPath !== "" && url.includes(pollPath));
    if (!isKnownPath) {
      return respond({ file: { download_url: "https://cdn.example.test/probe.mp4" } }, status);
    }
    if (phased) {
      const phase = url.includes(submitPath) && !url.includes(pollPath) ? "submit" : "poll";
      return respond(phased[phase] ?? body(), status);
    }
    return respond(body(), status);
  };

  if (jsonMode && spec.response) {
    probes.push({
      name: "happy path — 映射能产出产物",
      docRef: "§7",
      run: async () => {
        const out = await runSpec(spec, sampleInput, makeUpstream(() => payload));
        return {
          ok: out.ok && (out.items > 0 || typeof out.text === "string"),
          detail: out.ok ? out.detail : `${out.status} ${out.code} — ${out.detail}`,
        };
      },
    });
  }

  // The one probe that can be wrong in a way synthesis cannot reach: a real
  // vendor response checked against the spec's declared paths.
  if (jsonMode && spec.response && fixture) {
    probes.push({
      name: `真实上游响应对账（fixtures["${fixture.key}"]）`,
      docRef: "§0.7",
      run: async () => {
        const { mismatches, notes, matched } = diffAgainstFixture(spec, fixture.body);
        const suffix = notes.length > 0 ? `（${notes.length} 个备用形态未出现，属正常）` : "";
        if (mismatches.length > 0) {
          const detail = mismatches
            .map((m) => `${m.path}：${m.problem}`)
            .join("；")
            .slice(0, 300);
          return { ok: false, detail: `${matched} 个路径对得上，但 ${detail}${suffix}` };
        }
        return { ok: true, detail: `${matched} 个读取路径全部命中${suffix}` };
      },
    });

    probes.push({
      name: "真实响应喂进引擎能产出产物",
      docRef: "§0.7",
      run: async () => {
        const out = await runSpec(spec, sampleInput, makeUpstream(() => payload, 200, fixture.body));
        return {
          ok: out.ok && (out.items > 0 || typeof out.text === "string"),
          detail: out.ok ? out.detail : `${out.status} ${out.code} — ${out.detail}`,
        };
      },
    });
  }

  if (spec.async) {
    const poll = spec.async.poll;
    const states = poll.statusMap
      ? Object.entries(poll.statusMap)
      : (poll.successValues ?? []).map((v) => [v, "ok"] as [string, string]);
    const waitValue = poll.statusMap
      ? Object.entries(poll.statusMap).find(([, t]) => t === "wait")?.[0]
      : undefined;
    const okValue = states.find(([, t]) => t === "ok")?.[0];
    const failValue = states.find(([, t]) => t === "fail")?.[0];

    const writeStatus = (value: string) => {
      const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      for (const read of readPaths(spec.response)) {
        if (read.field === "status") setAtPath(next, read.path, value);
      }
      return next;
    };

    if (okValue) {
      probes.push({
        name: `async — 终态 "${okValue}" 能收敛`,
        docRef: "§9",
        run: async () => {
          let calls = 0;
          const serve = makeUpstream(() =>
            calls === 1 && waitValue ? writeStatus(waitValue) : writeStatus(okValue),
          );
          const out = await runSpec(spec, sampleInput, (url) => {
            calls += 1;
            return serve(url);
          });
          return { ok: out.ok, detail: out.ok ? `${calls} 次调用后收敛` : `${out.status} ${out.code}` };
        },
      });
    }
    if (failValue) {
      probes.push({
        name: `async — 失败态 "${failValue}" 立刻失败`,
        docRef: "§9.1",
        run: async () => {
          const out = await runSpec(spec, sampleInput, makeUpstream(() => writeStatus(failValue)));
          return {
            ok: !out.ok && out.code === "upstream_task_failed",
            detail: out.ok ? "意外成功（会被当成计费成功）" : `${out.status} ${out.code}`,
          };
        },
      });
    }
    probes.push({
      name: "async — 未列出的状态不会假装成功",
      docRef: "§9.1",
      run: async () => {
        // With a `""` catch-all an unknown state keeps waiting (and eventually
        // times out) rather than being reported as a finished task.
        if (!poll.statusMap?.[""]) {
          return { ok: false, detail: 'statusMap 缺 "" 兜底项（保存时就会报错，这里再确认一次）' };
        }
        const fastSpec: MediaSpec = {
          ...spec,
          async: { ...spec.async!, poll: { ...poll, intervalMs: 1, timeoutMs: 60 } },
        };
        const out = await runSpec(fastSpec, sampleInput, makeUpstream(() => writeStatus("SomethingBrandNew")));
        return {
          ok: !out.ok && out.code === "task_timeout",
          detail: out.ok ? "把未知状态当成了成功" : `${out.code}${out.detail.includes("last status") ? "（错误信息带上了实际状态）" : ""}`,
        };
      },
    });
  }

  for (const [index, rule] of (spec.errors ?? []).entries()) {
    if (rule.httpStatus === undefined) continue;
    const wanted = Array.isArray(rule.httpStatus) ? rule.httpStatus[0] : rule.httpStatus;
    probes.push({
      name: `HTTP ${wanted} → ${rule.code}`,
      docRef: "§8",
      run: async () => {
        const out = await runSpec(spec, sampleInput, makeUpstream(() => ({ error: { type: rule.code, message: rule.code } }), wanted));
        return {
          ok: !out.ok && out.status === rule.status && out.code === rule.code,
          detail: out.ok ? "被当成成功" : `实际 ${out.status} ${out.code}（期望 ${rule.status} ${rule.code}）`,
        };
      },
    });
    void index;
  }

  for (const [index, rule] of (spec.errors ?? []).entries()) {
    const eq = isRecord(rule.when) ? rule.when.$eq : undefined;
    if (!Array.isArray(eq) || eq.length !== 2 || typeof eq[0] !== "string" || !eq[0].startsWith("$")) continue;
    const wanted = eq[1];
    if (wanted === 0) continue; // 0 is the success code, not an error
    probes.push({
      name: `厂商码 ${String(eq[0])} == ${String(wanted)} → ${rule.code}`,
      docRef: "§8",
      run: async () => {
        const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        // Inject at the rule's **own condition path** first. Routing this through
        // the spec's `errorCode` mapping alone made the probe lie: a spec whose
        // errors match on `$.code` but which maps no `errorCode` got nothing
        // injected, so the synthesized response was a plain success and the probe
        // reported "规则没触发（被当成成功）" — blaming the spec for a defect in
        // the probe. The condition is what the engine evaluates, so that is where
        // the value belongs; the mapped paths are still filled for realism.
        setAtPath(next, eq[0], wanted);
        for (const read of readPaths(spec.response)) {
          if (read.field === "errorCode") setAtPath(next, read.path, wanted);
        }
        const out = await runSpec(spec, sampleInput, makeUpstream(() => next));
        return {
          ok: !out.ok && out.status === rule.status && out.code === rule.code,
          detail: out.ok ? "规则没触发（被当成成功）" : `实际 ${out.status} ${out.code}`,
        };
      },
    });
    void index;
  }

  const hexRead = readPaths(spec.response).find((r) => r.encoding === "hex" && r.kind === "base64");
  if (hexRead) {
    probes.push({
      name: "encoding hex → 客户端拿到可解码的 base64",
      docRef: "§7.2",
      run: async () => {
        const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        setAtPath(next, hexRead.path, "49443304000000fffb90c4");
        const out = await runSpec(spec, sampleInput, makeUpstream(() => next));
        if (!out.ok) return { ok: false, detail: `${out.status} ${out.code}` };
        const got = await runSpec(
          spec,
          sampleInput,
          () => respond(next),
        );
        void got;
        return { ok: true, detail: "已转换" };
      },
    });
  }

  if (jsonMode && spec.response && spec.allowEmpty !== true) {
    probes.push({
      name: "映射为空会被拦下（而不是静默 0 产物）",
      docRef: "§7.5",
      run: async () => {
        const out = await runSpec(spec, sampleInput, makeUpstream(() => ({})));
        // An async spec with an empty body fails earlier, at task-id
        // extraction; both outcomes are correct, silence is not.
        const acceptable = new Set(["upstream_contract_mismatch", "no_task_id"]);
        return {
          ok: !out.ok && acceptable.has(out.code ?? ""),
          detail: out.ok ? "静默成功并计费 0" : `${out.status} ${out.code}`,
        };
      },
    });
  }

  if (typeof spec.limits?.maxN === "number") {
    probes.push({
      name: `n > maxN(${spec.limits.maxN}) 被拒`,
      docRef: "§10",
      run: async () => {
        const out = await runSpec(spec, { ...sampleInput, n: spec.limits!.maxN! + 1 }, makeUpstream(() => payload));
        return { ok: !out.ok && out.code === "n_too_large", detail: out.ok ? "没有被拒" : `${out.status} ${out.code}` };
      },
    });
  }

  void label;
  return probes;
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

/** Upstream keys that are almost always booleans; a string here is a bug. */
const BOOLEAN_LOOKING_KEYS = new Set([
  "stream",
  "async",
  "is_instrumental",
  "lyrics_optimizer",
  "force_cbr",
  "subtitle_enable",
  "aigc_watermark",
  "text_normalization",
  "latex_read",
  "prompt_optimizer",
  "watermark",
]);

/** Depth-first walk over a mapping tree, reporting each node with its key. */
function walkNodes(node: unknown, visit: (node: unknown, key?: string) => void, key?: string): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => walkNodes(entry, visit, key));
    return;
  }
  if (!isRecord(node)) return;
  visit(node, key);
  for (const [childKey, child] of Object.entries(node)) {
    walkNodes(child, visit, childKey);
  }
}

/**
 * Transforms that only make sense in one direction. Each of these has shipped:
 * `$dataUrl` in a response handed the client a `data:` URL it could not decode,
 * and a `$from` in a request silently built an array nobody sent upstream.
 */
const REQUEST_ONLY_TRANSFORMS = ["$dataUrl", "$file"];
const RESPONSE_ONLY_TRANSFORMS = ["$from", "$to", "$fetch"];

function transformKeysIn(node: unknown): Set<string> {
  const found = new Set<string>();
  walkNodes(node, (child) => {
    if (!isRecord(child)) return;
    for (const key of Object.keys(child)) {
      if (key.startsWith("$")) found.add(key);
    }
  });
  return found;
}

/** Keys of every `$enum`/`$mapSize` table whose path is the client `size`. */
function sizeTableKeys(node: unknown, scope = ""): string[] {
  const keys: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((entry) => keys.push(...sizeTableKeys(entry, scope)));
    return keys;
  }
  if (!isRecord(node)) return keys;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "$enum" || key === "$mapSize") && isRecord(value)) {
      const path = typeof value.path === "string" ? value.path : "$.size";
      if (path === "$.size" || path === "$.responseSize") {
        keys.push(...Object.keys(isRecord(value.map) ? value.map : isRecord(value.table) ? value.table : {}));
      }
      keys.push(...sizeTableKeys(value.default, scope));
      continue;
    }
    keys.push(...sizeTableKeys(value, scope));
  }
  return keys;
}

function staticChecks(spec: MediaSpec, raw: Record<string, unknown>, index: number): string[] {
  const out: string[] = [];
  const prefix = `specs[${index}]`;
  const modes = Array.isArray((spec.metadata as Record<string, unknown> | undefined)?.modes)
    ? ((spec.metadata as Record<string, unknown>).modes as string[])
    : [];
  const requestReads = readPaths(spec.request).map((r) => r.path.toLowerCase());

  // Direction mistakes, straight from the incident log.
  const inResponse = transformKeysIn(spec.response);
  for (const transform of REQUEST_ONLY_TRANSFORMS) {
    if (inResponse.has(transform)) {
      out.push(
        line(
          "fail",
          `${prefix} response 里用了 ${transform}`,
          "它只在请求方向有意义；响应里应该写 `value: \"$.data.audio\"` 这种直接取值（§6.4）",
        ),
      );
    }
  }
  const inRequest = transformKeysIn(spec.request);
  for (const transform of RESPONSE_ONLY_TRANSFORMS) {
    if (inRequest.has(transform)) {
      out.push(
        line("fail", `${prefix} request 里用了 ${transform}`, "它只在响应方向有意义（§6.4）"),
      );
    }
  }

  // `encoding` only means something for a value the client has to decode.
  walkNodes(spec.response, (node) => {
    if (!isRecord(node)) return;
    if (typeof node.encoding === "string" && node.kind === "url") {
      out.push(
        line("warn", `${prefix} item 的 kind 是 url 却声明了 encoding`, "url 不需要解码，声明是无效的（§7.2）"),
      );
    }
    if (typeof node.encoding === "string" && !["plain", "base64", "hex", "dataUrl"].includes(node.encoding)) {
      out.push(
        line("fail", `${prefix} item 的 encoding "${node.encoding}" 非法`, "只能是 plain / base64 / hex / dataUrl"),
      );
    }
  });

  // Two arrays pointing at the same upstream field produce every item twice.
  const itemsFrom = readPaths(isRecord(spec.response) ? spec.response.items : undefined)
    .filter((r) => r.path.endsWith("[*]"))
    .map((r) => r.path);
  const itemsB64From = readPaths(isRecord(spec.response) ? spec.response.itemsB64 : undefined)
    .filter((r) => r.path.endsWith("[*]"))
    .map((r) => r.path);
  for (const path of itemsFrom) {
    if (itemsB64From.includes(path)) {
      out.push(
        line("warn", `${prefix} items 和 itemsB64 指向同一个上游数组 ${path}`, "每个产物会被收两次（计费翻倍）"),
      );
    }
  }

  // The catalogue advertises sizes; a client that reads them and sends one the
  // spec cannot map silently gets the default.
  const advertised = Array.isArray((spec.metadata as Record<string, unknown> | undefined)?.sizes)
    ? ((spec.metadata as Record<string, unknown>).sizes as unknown[]).map(String)
    : null;
  if (advertised) {
    const mappable = [...new Set(sizeTableKeys(spec.request))];
    const missing = mappable.filter((key) => !advertised.includes(key));
    if (missing.length > 0) {
      out.push(
        line(
          "info",
          `${prefix} 尺寸映射表里有 ${missing.length} 个 size 没写进 metadata.sizes`,
          `${missing.slice(0, 5).join(", ")} —— 客户端读了目录也发现不了它们`,
        ),
      );
    }
  }

  // The catalogue limit and the enforced limit are two different numbers if
  // they disagree, and the client only sees the first one.
  const metaMaxN = (spec.metadata as Record<string, unknown> | undefined)?.max_n;
  if (
    typeof metaMaxN === "number" &&
    typeof spec.limits?.maxN === "number" &&
    metaMaxN !== spec.limits.maxN
  ) {
    out.push(
      line("warn", `${prefix} metadata.max_n=${metaMaxN} 与 limits.maxN=${spec.limits.maxN} 不一致`, "目录会宣传一个实际会 400 的上限"),
    );
  }

  // A mode we advertise but never map is a promise the spec cannot keep.
  const modeHints: Record<string, string[]> = {
    "image-to-image": ["image", "subject_reference", "init_image", "image_url"],
    "image-to-video": ["image", "first_frame", "first_frame_image"],
    "reference-to-video": ["image", "reference", "video", "audio"],
    "speech-to-text": ["image", "file", "audio"],
  };
  for (const mode of modes) {
    const hints = modeHints[mode];
    if (!hints) continue;
    if (!hints.some((hint) => requestReads.some((read) => read.includes(hint)))) {
      out.push(
        line("warn", `${prefix} metadata.modes 声明了 "${mode}"`, "但 request 里没有任何相关参数映射——别宣传没实现的能力（§11）"),
      );
    }
  }

  // Heuristics for the three mistake classes that survived every review round.
  walkNodes(spec.request, (node, key) => {
    if (key && BOOLEAN_LOOKING_KEYS.has(key) && isRecord(node) && "$const" in node && typeof node.$const === "string") {
      out.push(
        line(
          "warn",
          `${prefix} request.${key} 用了字符串常量`,
          `$const = ${JSON.stringify(node.$const)} —— 厂商要布尔时，multipart 里发出去是字符串而不是布尔值`,
        ),
      );
    }
    if (isRecord(node) && "$firstPresent" in node && Array.isArray(node.$firstPresent)) {
      for (const candidate of node.$firstPresent) {
        const isEmptyDefault =
          isRecord(candidate) && "$const" in candidate &&
          (candidate.$const === "" || candidate.$const === null);
        if (isEmptyDefault) {
          out.push(
            line(
              "warn",
              `${prefix} request.${key ?? "?"} 用空值兜底`,
              "厂商常给这类字段设 minLength —— 省略字段通常比发空串安全（§6.3）",
            ),
          );
        }
      }
    }
  });

  if (spec.async) {
    // `/v1/videos` → `/v1/videos/{{taskId}}` is ordinary REST and fine.
    // `/v2/video_generation` → `/v2/video_generation/query?task_id=` appends a new
    // literal segment to the *create* path, which is almost always a swapped
    // segment order: query endpoints do not live under the create path.
    const submit = spec.transport.path.split("?")[0];
    const poll = spec.async.poll.path.split("?")[0].replace(/\{\{taskId\}\}/g, "");
    if (poll.startsWith(submit) && poll.slice(submit.length).replace(/^\/+/, "").length > 0) {
      out.push(
        line(
          "warn",
          `${prefix} async.poll.path 在提交路径后面又接了字面量段`,
          `${spec.transport.path} → ${spec.async.poll.path} —— 查询接口通常不在创建路径之下，逐字符对照厂商文档（§9）`,
        ),
      );
    }
  }

  // A url item on an audio capability, from a generically-named payload field,
  // with nothing in the request that asks the upstream for a URL and no
  // `encoding` declared. That is the shape of "the client gets a hex blob
  // dressed as a URL": MiniMax `t2a_v2` / `music_generation` both default to
  // `hex`, and `data.audio` carries it either way.
  //
  // Deliberately narrow — an `audio.tts` item whose path ends in `url` is fine,
  // and video/image capabilities are out of scope because their artefact fields
  // are conventionally URL-named to begin with.
  if (spec.capability === "audio.tts" || spec.capability === "music.generate") {
    const urlItems = readPaths(spec.response).filter(
      (r) => r.kind === "url" && r.field !== "errorCode" && r.field !== "errorMessage",
    );
    const requestKeys = new Set<string>();
    walkNodes(spec.request, (node, key) => {
      if (key) requestKeys.add(key);
    });
    // `format` is excluded on purpose: `audio_setting.format` picks the codec,
    // not between url and base64.
    const hasFormatSwitch = [...requestKeys].some((key) =>
      /^(response_format|output_format|result_type|return_type)$/.test(key),
    );
    const declaresEncoding = readPaths(spec.response).some((r) => r.encoding !== undefined);
    const genericLeaf = urlItems.filter((r) => !/url/i.test(r.path.split(".").pop() ?? ""));
    if (genericLeaf.length > 0 && !hasFormatSwitch && !declaresEncoding) {
      out.push(
        line(
          "warn",
          `${prefix} ${spec.capability} 的产物声明为 url，但请求里没有任何参数要求上游返回 url`,
          `取自 ${genericLeaf.map((r) => r.path).join(", ")} —— 确认上游默认返回 URL；` +
            "MiniMax 的 t2a_v2 / music_generation 默认是 hex，要么加 output_format:\"url\"，" +
            "要么改成 kind:\"base64\" + encoding（§7.2）",
        ),
      );
    }
  }

  const responseRecord = isRecord(spec.response) ? spec.response : null;
  if (responseRecord && responseRecord.items !== undefined && responseRecord.itemsB64 !== undefined) {
    out.push(
      line("warn", `${prefix} 同时映射了 items 和 itemsB64`, "可以用 $ifPresent 多分支表达得更清楚（§6.2）"),
    );
  }
  if (responseRecord && responseRecord.itemsB64 !== undefined) {
    out.push(line("info", `${prefix} 用了 itemsB64`, "仍受支持，但新写法是 $ifPresent 多分支"));
  }
  if (typeof spec.limits?.timeoutMs === "number" && spec.limits.timeoutMs > 240_000) {
    out.push(line("warn", `${prefix} limits.timeoutMs = ${spec.limits.timeoutMs}`, "serverless 上限 300s，留太多余量会撞函数超时"));
  }
  if (spec.async?.poll.timeoutMs && spec.limits?.timeoutMs && spec.async.poll.timeoutMs > spec.limits.timeoutMs) {
    out.push(
      line("warn", `${prefix} async.poll.timeoutMs 大于 limits.timeoutMs`, "提交阶段可能先被外层超时截断"),
    );
  }
  if (spec.async && !spec.response) {
    out.push(line("fail", `${prefix} 有 async 但没有 response`, "轮询后无从判断状态（§9）"));
  }
  if (spec.async) {
    const poll = spec.async.poll;
    if (!poll.path.includes("{{taskId}}")) {
      out.push(line("fail", `${prefix} async.poll.path 没有 {{taskId}}`, "每次轮询都会查同一个 URL"));
    }
    const withoutCatchAll = poll.statusMap ? poll.statusMap[""] === undefined : true;
    if (withoutCatchAll) {
      out.push(line("fail", `${prefix} statusMap 缺 "" 兜底项`, "厂商新增一个状态就会挂到超时（§9.1）"));
    }
  }
  const unknownTop = Object.keys(raw).filter(
    (key) => !["specVersion", "capability", "displayName", "models", "baseUrl", "transport", "auth", "request", "response", "responseMode", "errors", "async", "limits", "allowEmpty", "metadata"].includes(key),
  );
  for (const key of unknownTop) {
    out.push(line("fail", `${prefix} 未知顶层字段 "${key}"`, "保存时会报错"));
  }
  if (spec.metadata) {
    const flat = (spec.metadata as Record<string, unknown>).modes;
    if (Array.isArray(flat) && flat.some((m) => typeof m !== "string")) {
      out.push(line("fail", `${prefix} metadata.modes 含非字符串`, "会进 /v1/models 的 relay 字段"));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function checkSpecDocument(input: unknown): Promise<CheckResult> {
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  const bump = (ok: boolean) => {
    if (ok) passed++;
    else failed++;
  };

  // Accept `{models, specs}`, a bare array of specs, or one spec.
  const record = isRecord(input) ? input : null;
  const rawSpecs = Array.isArray(input)
    ? input
    : Array.isArray(record?.specs)
      ? record!.specs
      : record && record.capability
        ? [input]
        : [];
  const models = isRecord(record?.models) ? (record!.models as Record<string, unknown>) : null;
  const fixtures = isRecord(record?.fixtures) ? (record!.fixtures as Fixtures) : null;

  lines.push(bold("PART 1  静态检查"));
  if (rawSpecs.length === 0) {
    lines.push(line("fail", "没有找到任何 spec", '输入应为 {"models":…,"specs":[…]} 或一个 spec 数组'));
    return { ok: false, passed, failed: failed + 1, lines };
  }

  const validation = validateMediaSpecs(rawSpecs);
  for (const error of validation.errors) {
    lines.push(line("fail", error));
    bump(false);
  }
  for (const warning of validation.warnings) {
    lines.push(line("warn", warning));
  }
  if (validation.errors.length === 0) {
    lines.push(line("pass", `${rawSpecs.length} 份 spec 通过结构与跨 spec 校验`));
    bump(true);
  }

  if (models) {
    const covered = new Set<string>();
    for (const raw of rawSpecs) {
      if (!isRecord(raw)) continue;
      for (const model of Array.isArray(raw.models) ? raw.models : []) covered.add(model);
    }
    const orphans = Object.keys(models).filter((name) => !covered.has(name));
    if (orphans.length > 0) {
      lines.push(
        line("warn", `${orphans.length} 个模型没有任何 spec 声明服务`, `${orphans.join(", ")}——调它们会 400 capability_not_supported`),
      );
    } else {
      lines.push(line("pass", `${Object.keys(models).length} 个模型都有 spec 覆盖`));
    }
    for (const [name, config] of Object.entries(models)) {
      if (!isRecord(config)) {
        lines.push(line("fail", `models.${name} 形状不对`, '应为 {"upstreamId":…,"pricePerItem":…,"enabled":true}'));
        bump(false);
        continue;
      }
      if (typeof config.upstreamId !== "string" || !config.upstreamId) {
        lines.push(line("fail", `models.${name}.upstreamId 缺失`));
        bump(false);
      }
      if (typeof config.pricePerItem !== "number" || config.pricePerItem < 0) {
        lines.push(line("fail", `models.${name}.pricePerItem 无效`, "每件多少整数积分，0 = 免费"));
        bump(false);
      }
      if (!Number.isInteger(config.pricePerItem as number)) {
        lines.push(line("warn", `models.${name}.pricePerItem 不是整数`, "协议按整数积分定价"));
      }
    }
  } else {
    lines.push(line("warn", "没有 models 块", "运营者还需要一份 models 才能建供应商"));
  }
  if (fixtures) {
    const used = new Set<string>();
    for (const raw of rawSpecs) {
      if (!isRecord(raw)) continue;
      const parsed = parseMediaSpec(raw);
      if (!parsed.ok) continue;
      const hit = fixtureFor(parsed.spec, fixtures);
      if (hit) used.add(hit.key);
    }
    const unused = Object.keys(fixtures).filter((key) => !used.has(key));
    if (unused.length > 0) {
      lines.push(
        line("warn", `${unused.length} 个 fixture 没有被任何 spec 命中`, `${unused.join(", ")} —— key 需与 displayName / 模型名 / capability 之一一致`),
      );
    } else {
      lines.push(line("pass", `${Object.keys(fixtures).length} 个真实上游响应已挂到对应 spec`));
    }
  }

  const parsedSpecs: { spec: MediaSpec; raw: Record<string, unknown>; index: number }[] = [];
  rawSpecs.forEach((raw, index) => {
    const parsed = parseMediaSpec(raw);
    if (parsed.ok) parsedSpecs.push({ spec: parsed.spec, raw: raw as Record<string, unknown>, index });
    const target: MediaSpec = parsed.ok
      ? parsed.spec
      : ({ capability: "image.generate" } as unknown as MediaSpec);
    for (const line_ of staticChecks(target, raw as Record<string, unknown>, index)) {
      lines.push(line_);
      if (line_.includes("✗")) bump(false);
    }
  });

  // Show the request that would actually go out, for eyeballing field names.
  lines.push("");
  lines.push(bold("  各 spec 实际发出的请求（可用示例入参）"));
  for (const { spec, index } of parsedSpecs) {
    const input = buildMediaScope({ model: "probe-model", ...(SAMPLE_INPUT[spec.capability] ?? { prompt: "probe" }) });
    const body = applyMapping(spec.request, input);
    const header: string[] = [`specs[${index}] ${spec.capability} → ${spec.transport.method} ${spec.transport.path}`];
    lines.push(dim(`    ${header.join("")}`));
    lines.push(dim(`    ${JSON.stringify(body)}`));
    for (const [name, mapping] of Object.entries(spec.transport.headers ?? {})) {
      const value = applyMapping(mapping, input);
      lines.push(dim(`    header ${name}: ${value === undefined ? "(不发)" : JSON.stringify(value)}`));
    }
    // The paths the response mapping reads, so they can be diffed character by
    // character against the vendor's response schema. The judge cannot verify
    // these against the vendor — only a reader with the docs can.
    const reads = readPaths(spec.response);
    if (reads.length > 0) {
      lines.push(dim(`    response 读取路径: ${reads.map((r) => r.path).join(", ")}`));
    }
  }

  lines.push("");
  lines.push(bold("PART 2  引擎探针（stub 上游，无网络、无需密钥）"));
  for (const { spec, index } of parsedSpecs) {
    lines.push("");
    lines.push(bold(`  specs[${index}] ${spec.capability} — ${spec.displayName ?? ""}`));
    for (const probe of probesFor(spec, String(index), fixtures)) {
      let result: { ok: boolean; detail: string };
      try {
        result = await probe.run();
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      bump(result.ok);
      lines.push(line(result.ok ? "pass" : "fail", `${probe.name}  ${dim(probe.docRef)}`, result.detail));
    }
  }

  return { ok: failed === 0, passed, failed, lines };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：pnpm spec-check <file.json>   （内容为 {\"models\":…,\"specs\":[…]} 或一个 spec 数组）");
    process.exit(2);
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(red(`读不到合法 JSON：${err instanceof Error ? err.message : String(err)}`));
    process.exit(2);
  }
  const result = await checkSpecDocument(input);
  console.log(result.lines.join("\n"));
  console.log("");
  console.log(
    result.ok
      ? green(`全部通过：${result.passed} 项`)
      : red(`${result.failed} 项未通过，${result.passed} 项通过`),
  );
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("spec-check.ts")) {
  void main();
}
