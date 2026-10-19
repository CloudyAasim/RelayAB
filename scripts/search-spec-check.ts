/**
 * scripts/search-spec-check.ts — the search judge.
 *
 *   pnpm search-spec-check <file.json>     # a spec, or { spec, baseUrl, apiKey }
 *
 * A spec is data, so the only trustworthy way to review one is to *run* it. This
 * script is the closed loop the protocol documentation cannot be:
 *
 *   PART 1  static — validation, and the exact upstream request that would be
 *           sent, so "which URL does this actually hit" is a thing you read
 *           rather than a thing you infer.
 *   PART 2  probes — the spec is executed against a *synthesized* upstream. The
 *           stub response is derived from the spec's own `response` mapping, so
 *           no fixtures are needed for a new vendor.
 *
 * Nothing here touches the network or needs an API key.
 *
 * Why it exists: a spec that saves cleanly can still fail on a live request —
 * a result array one level deeper than the mapping says, a query parameter
 * that never left, a field name the vendor spells differently. Reading the
 * JSON cannot show those. Running it can.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSearchSpec, type SearchSpec } from "../src/lib/search/spec";
import { buildSearchRequest, executeSearch } from "../src/lib/search/engine";
import { SEARCH_TEMPLATES } from "../src/lib/search/templates";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);
const dim = (t: string) => paint("90", t);
const bold = (t: string) => paint("1", t);

let failures = 0;
let warnings = 0;

function fail(message: string): void {
  failures += 1;
  console.log(`  ${red("✗")} ${message}`);
}

function warn(message: string): void {
  warnings += 1;
  console.log(`  ${yellow("!")} ${message}`);
}

function pass(message: string): void {
  console.log(`  ${green("✓")} ${message}`);
}

function note(message: string): void {
  console.log(`  ${dim("·")} ${message}`);
}

function heading(text: string): void {
  console.log(`\n${bold(text)}`);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface Input {
  spec: unknown;
  baseUrl?: string;
  apiKey?: string;
}

function readInput(file: string): Input | null {
  if (!existsSync(file)) {
    console.log(red(`读不到 ${file}`));
    return null;
  }
  let parsed: unknown;
  try {
    // A leading BOM is stripped rather than complained about: Windows editors
    // write one, and "your file is not JSON" is not a useful thing to tell
    // someone whose JSON is fine.
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    parsed = JSON.parse(text);
  } catch (err) {
    console.log(red(`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  if (parsed && typeof parsed === "object" && "spec" in (parsed as Record<string, unknown>)) {
    const wrapper = parsed as Record<string, unknown>;
    return {
      spec: wrapper.spec,
      baseUrl: typeof wrapper.baseUrl === "string" ? wrapper.baseUrl : undefined,
      apiKey: typeof wrapper.apiKey === "string" ? wrapper.apiKey : undefined,
    };
  }
  return { spec: parsed };
}

// ---------------------------------------------------------------------------
// Synthesizing an upstream answer from the spec's own mapping
// ---------------------------------------------------------------------------

/** `$.web.results` → `["web", "results"]`. */
function pathSegments(path: string): string[] {
  const body = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : "";
  return body.split(".").filter(Boolean);
}

/** The key a field path ends at: `$.a.b` → `b`. */
function lastSegment(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? "";
}

/** The candidate paths of a field, whichever form it was written in. */
function fieldPaths(field: unknown): string[] {
  if (typeof field === "string") return [field];
  if (field && typeof field === "object" && Array.isArray((field as { $firstPresent?: unknown }).$firstPresent)) {
    return ((field as { $firstPresent: unknown[] }).$firstPresent ?? []).filter(
      (p): p is string => typeof p === "string",
    );
  }
  return [];
}

/**
 * A response body that satisfies the spec's own mapping.
 *
 * Built from the mapping rather than from a fixture, so a new vendor needs no
 * sample: the judge asks "if the vendor answered like this spec says it
 * answers, would the gateway read the results out?" — which is the question a
 * wrong field name actually breaks.
 */
function synthesizeResponse(spec: SearchSpec): unknown {
  const segments = pathSegments(spec.response.items);
  if (segments.length === 0) return {};

  const item: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec.response.fields)) {
    const candidates = fieldPaths(field);
    const first = candidates[0];
    if (!first) continue;
    const key = lastSegment(first);
    if (!key) continue;
    if (name === "url") item[key] = "https://example.com/doc";
    else if (name === "title") item[key] = "示例标题";
    else item[key] = "这是摘要。";
  }

  // The array itself, under the key the path's last segment names.
  const key = segments[segments.length - 1];
  let node: unknown = [item];
  for (const segment of segments.slice(0, -1).reverse()) {
    node = { [segment]: node };
  }
  return { [key]: node };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** The array of hits inside a synthesized payload. */
function itemsArray(payload: unknown, spec: SearchSpec): unknown[] | null {
  let node: unknown = payload;
  for (const segment of pathSegments(spec.response.items)) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return Array.isArray(node) ? node : null;
}

function stubFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function runProbes(spec: SearchSpec, baseUrl: string, apiKey?: string): Promise<void> {
  heading("PART 2 探针（对着合成的上游跑一遍）");

  const payload = synthesizeResponse(spec);
  note(`合成响应：${JSON.stringify(payload)}`);

  const results = await executeSearch(spec, baseUrl, {
    query: "示例查询",
    limit: 5,
    apiKey,
    displayName: spec.displayName ?? spec.vendor ?? "搜索后端",
    fetchImpl: stubFetch(payload),
  });

  if (results.length === 0) {
    fail("上游返回了内容，但一条结果都没读出来 ——多半是 response.items 或 response.fields 指错了");
  } else {
    pass(`读出 ${results.length} 条结果：${results[0].url}`);
    if (results[0].title !== "示例标题") {
      warn(`标题读成了「${results[0].title}」，与合成的「示例标题」不符`);
    }
    if (results[0].snippet !== "这是摘要。") {
      warn(`摘要读成了「${results[0].snippet}」，与合成的「这是摘要。」不符`);
    }
  }

  // A result the assistant could not follow is dropped on purpose.
  const poisoned = synthesizeResponse(spec);
  const poisonedList = itemsArray(poisoned, spec);
  if (poisonedList) {
    const key = lastSegment(fieldPaths(spec.response.fields.url)[0] ?? "$.url");
    poisonedList.push({ [key]: "javascript:alert(1)" });
    const kept = await executeSearch(spec, baseUrl, {
      query: "示例查询",
      limit: 5,
      apiKey,
      displayName: "搜索后端",
      fetchImpl: stubFetch(poisoned),
    });
    if (kept.length !== results.length) {
      fail(`不可用的地址没有被丢掉（${kept.length} 条 vs ${results.length} 条）`);
    } else {
      pass("不可用的地址（javascript:）被丢掉了");
    }
  }

  // A duplicate URL is one result, not two.
  const duplicated = synthesizeResponse(spec);
  const list = itemsArray(duplicated, spec);
  if (list && list.length > 0) {
    list.push({ ...(list[0] as Record<string, unknown>) });
    const deduped = await executeSearch(spec, baseUrl, {
      query: "示例查询",
      limit: 5,
      apiKey,
      displayName: "搜索后端",
      fetchImpl: stubFetch(duplicated),
    });
    if (deduped.length !== results.length) {
      fail(`重复地址没有去重（${deduped.length} 条 vs ${results.length} 条）`);
    } else {
      pass("重复地址去重了");
    }
  }

  // The upstream's refusal has to be an error, not an empty list.
  for (const [status, expect] of [
    [401, /HTTP 401/],
    [429, /限流/],
    [500, /HTTP 500/],
  ] as const) {
    try {
      await executeSearch(spec, baseUrl, {
        query: "示例查询",
        limit: 5,
        apiKey,
        displayName: "搜索后端",
        fetchImpl: (async () => new Response("nope", { status })) as unknown as typeof fetch,
      });
      fail(`上游返回 ${status} 时没有报错`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (expect.test(message)) pass(`上游 ${status} → ${message.split("。")[0]}`);
      else fail(`上游 ${status} 的提示不对：${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.log(red("用法：pnpm search-spec-check <file.json>"));
    process.exit(2);
  }

  const input = readInput(file);
  if (!input) process.exit(2);

  heading("PART 1 静态检查");
  const parsed = parseSearchSpec(input.spec);
  if (!parsed.ok) {
    for (const issue of parsed.errors) fail(issue);
    console.log(`\n${red("协议不合法，没有继续跑探针。")}`);
    process.exit(1);
  }
  const spec = parsed.spec;
  pass("协议校验通过");
  for (const warning of parsed.warnings) warn(warning);

  const baseUrl = input.baseUrl ?? spec.baseUrl ?? "";
  if (!baseUrl) {
    fail("没有服务地址：在文件里给 baseUrl，或在 spec 里写 baseUrl");
  } else {
    pass(`服务地址：${baseUrl}`);
  }

  heading("PART 1 会发出去的请求");
  try {
    const request = buildSearchRequest(spec, baseUrl, {
      query: "示例查询",
      limit: 5,
      apiKey: input.apiKey ?? "sample-key",
    });
    note(`${request.method} ${request.url}`);
    for (const [name, value] of Object.entries(request.headers)) {
      note(`${name}: ${value.includes("sample-key") ? value.replace("sample-key", "<密钥>") : value}`);
    }
    if (request.body !== undefined) {
      note("body:");
      for (const line of JSON.stringify(JSON.parse(request.body), null, 2).split("\n")) {
        note(`  ${line}`);
      }
    }
  } catch (err) {
    fail(`拼不出请求：${err instanceof Error ? err.message : String(err)}`);
  }

  if (baseUrl) {
    await runProbes(spec, baseUrl, input.apiKey ?? "sample-key");
  }

  heading("内置模板");
  for (const template of SEARCH_TEMPLATES) {
    note(`${template.id}：${template.description}`);
  }

  console.log(
    `\n${failures === 0 ? green("全部通过") : red(`${failures} 处不通过`)}${
      warnings > 0 ? `，${yellow(`${warnings} 处提醒`)}` : ""
    }`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
