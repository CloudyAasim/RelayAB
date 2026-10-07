/**
 * Generate the web-documentation index the assistant reads from.
 *
 * **The web docs only.** The repository's markdown was considered and dropped:
 * `read_docs` is a reader of this deployment's documentation pages, not of the
 * repository. `docs/模型适配协议/README.md` is the one file that did need to
 * reach the model — the admin page renders it and the assistant could not read
 * it — and it reaches the model through `get_media_spec_reference` rather than
 * from here, because a file is not a documentation page.
 *
 * Why this file exists at all: the docs pages are React components, and their
 * prose is i18n text rather than anything a tool can read. The components are
 * not shipped either — only the built bundle is. So the grouping is extracted
 * here, once, from the components' own `section === "…"` branches, and
 * `tests/unit/assistant-docs-index.test.ts` re-runs this and compares: a doc
 * page that gains a line fails the build instead of quietly becoming
 * unreadable to the assistant.
 *
 * Run: node scripts/gen-docs-index.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const OUT = path.join(ROOT, "src", "lib", "assistant", "docs-index.generated.ts");

/**
 * section id → the i18n keys its branch renders, in source order.
 *
 * The `fallbackSection` is for text that sits outside any branch — the page
 * title and intro, which every page shares.
 *
 * The second half of the return value is the keys that belong to *neither*, and
 * getting that boundary right took two attempts. Every `section === "…"` branch
 * lives in one component, and the same file also holds other components — a copy
 * button, a not-found card. A scan that simply remembers the last branch it saw
 * attributed all of them to that branch: for `DocsContent.tsx`, `media`. So the
 * chapter about image and speech generation came to contain "复制失败", "已复制"
 * and "文档里找不到这个章节", which is what `read_docs` handed the model.
 *
 * "After the last branch declaration" is not the boundary either — the last
 * branch's own body sits after it. What is the boundary is where the branch's
 * braces close, so the scan counts them: a key is the branch's prose while that
 * branch is open and furniture once it is not. Braces inside strings and line
 * comments are blanked first, since the file is full of `t("…")` and neither
 * carries one, and a miscount would move keys between prose and chrome rather
 * than fail loudly — the key counts this script prints are how that gets seen.
 */
function extractSections(file, fallbackSection) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const groups = new Map();
  let openBranch = null;
  let seenBranch = false;
  let depth = 0;
  const unattributed = [];

  for (const line of src.split("\n")) {
    // Depth before this line, so a branch's own opening brace counts towards it.
    const before = depth;
    const raw = line.replace(/\/\/.*$/, "");
    // Quoted runs blanked for the *counting* only: braces inside a JSX attribute
    // or a string would open and close a scope that does not exist. Backticks are
    // left alone because most of this file's `t()` calls sit inside a template
    // literal, and `${…}` is balanced anyway.
    const code = raw.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, (m) => " ".repeat(m.length));

    // Detection and extraction read the original line: blanking is a braces
    // problem, not a text problem.
    const cmp = raw.match(/section === "([a-z0-9-]+)"/);
    const arm = raw.match(/case "([a-z0-9-]+)"/);
    if (cmp || arm) {
      openBranch = { id: (cmp ?? arm)[1], base: before };
      seenBranch = true;
    } else if (openBranch && depth <= openBranch.base) {
      openBranch = null;
    }

    for (const m of raw.matchAll(/t\("([^"]+)"/g)) {
      // Inside a branch: its prose. Before the first branch: the page title and
      // intro, which every page shares. After the last one closed: furniture.
      const group = openBranch ? openBranch.id : seenBranch ? null : fallbackSection;
      if (!group) {
        if (!unattributed.includes(m[1])) unattributed.push(m[1]);
        continue;
      }
      if (!groups.has(group)) groups.set(group, []);
      const keys = groups.get(group);
      if (!keys.includes(m[1])) keys.push(m[1]);
    }

    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return { groups, unattributed, fallbackSection };
}

const user = extractSections("src/app/(user)/dashboard/docs/DocsContent.tsx", "start");
const admin = extractSections("src/app/(admin)/admin/docs/AdminDocsContent.tsx", "overview");
const userSections = user.groups;
const adminSections = admin.groups;

// ---------------------------------------------------------------------------
// The pages that are not a plain branch of i18n prose
// ---------------------------------------------------------------------------

/**
 * `"<surface>:<id>"` → the keys a page renders *through* something else.
 *
 * Counted by the dictionary guard below and by nothing else: they are covered
 * by the index, and they are never handed to the model as documentation.
 */
const CHROME = {};

/**
 * `"<surface>:<id>"` → text appended after the page's prose.
 *
 * The other half of the problem `chrome` solves. A page whose content is a file
 * or a component still has orientation prose, and the model needs to be told
 * where the rest of it is — "the protocol is below this" is a sentence that is
 * true on the rendered page and a dead end in the text a tool returns.
 */
const AFTER = {
  "admin:media":
    "这一页里的「适配协议全文」是一个仓库文件渲染出来的，read_docs 拿不到它 —— " +
    "协议正文用 get_media_spec_reference(what=\"protocol\") 读，分段读，读到 nextOffset 就接着读下一段。",
  "user:media":
    "实时模型目录用 list_gateway_models 取，那才是当前这张表的真实内容；" +
    "这一页里内嵌的目录组件是按页面渲染的界面，不是文档正文。",
};

/**
 * The chapter that renders another component's strings as well as its own.
 *
 * `media` renders `<ModelCatalog>` *inside* a card of its own prose, so the
 * catalogue's keys used to be written into this section's `keys` as well. It
 * first used `set` and that threw the chapter's own keys away — every sentence
 * it renders became unreachable while `read_docs` handed over the catalogue's
 * interface strings instead ("共 {n} 个模型", "按模型名、供应商、能力或说明搜索").
 * That was fixed by merging, which put the chapter back and left the other half
 * of the problem in place: the catalogue's strings are a live table's
 * *interface* — column headers, a search box, copy buttons — and reading them
 * as the documentation is how a chapter about media generation comes to contain
 * "复制失败" and "筛选".
 *
 * So they are separated. `chrome` says "this page renders these, and the index
 * covers them"; `keys` says "these are the page's prose, and these are what the
 * model is given". Both are real answers to different questions, and the
 * chapter points at `catalog` and at `list_gateway_models` for the live table
 * rather than pretending a column header is a sentence.
 */
const catalogSrc = [
  "src/components/docs/ModelCatalog.tsx",
  "src/components/docs/ModelCatalogPanel.tsx",
]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
  .join("\n");
const catalogKeys = [...new Set([...catalogSrc.matchAll(/t\("([^"]+)"/g)].map((m) => m[1]))];
CHROME["user:media"] = catalogKeys;
// `catalog` renders that component *alone*, so its own key list is empty and
// the catalogue's keys are all of it — as chrome, for the same reason. What
// that page actually answers, the model gets from `list_gateway_models`, which
// is the same table as live data rather than as a description of a table.
CHROME["user:catalog"] = catalogKeys;

// The keys that belong to no section: shared components in the same file. They
// go on the fallback section as chrome, because chrome is covered by the index
// and by the dictionary check but never rendered as prose — so a copy button
// cannot turn up in the middle of a chapter.
for (const [key, list] of [
  [`user:${user.fallbackSection}`, user.unattributed],
  [`admin:${admin.fallbackSection}`, admin.unattributed],
]) {
  if (list.length) CHROME[key] = [...new Set([...(CHROME[key] ?? []), ...list])];
}

// The admin `ops` page renders two reference components that read repository
// files at request time — the adapter protocol and the spec-check script. They
// are not i18n prose and are not the documentation of the gateway; the entry
// says so rather than returning an empty page the model would read as silence.
const NOT_PROSE = {
  "admin:ops":
    "这一页不是文字说明，而是两份从仓库文件实时渲染的参考件：媒体适配协议" +
    "（docs/模型适配协议/README.md）和 spec-check 脚本（scripts/spec-check.ts）。" +
    "它们是给「写 spec 的 AI」用的原文，不是网关文档。媒体适配协议用 " +
    "get_media_spec_reference(what=\"protocol\") 读；spec-check 脚本在仓库里，需要时请用户从管理界面复制。",
  // The live catalogue, rendered alone. Its table is data, and the tool that
  // returns data is `list_gateway_models` — a description of a table is worse
  // than the table when both are available.
  "user:catalog":
    "这一页是实时模型目录组件，本身没有文字说明。要当前这张表（对话模型与媒体模型，" +
    "含上下文长度、最大输出、思考档位、单价）用 list_gateway_models；" +
    "媒体服务商的配置用 list_media_providers。",
  // The parameters guide. Written at runtime from the admin form, so it has
  // no keys here at all — this index covers the built-in pages, and
  // `createDocReader` adds the guide and its pages from the settings row.
  "user:parameters":
    "参数参考：管理员在后台自己写的取值表——音色、尺寸、每个字段有哪些合法值。" +
    "一次读一整页，页很大，所以先看索引里的行数再决定读哪一页，" +
    "不要一上来就把整本吞掉。",
};

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

const sectionsSrc = fs.readFileSync(path.join(ROOT, "src/lib/docs/sections.ts"), "utf8");
function idsOf(constName) {
  const block = (sectionsSrc.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\]`)) ?? [])[1] ?? "";
  return [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

const sections = [
  ...idsOf("USER_SECTION_IDS").map((id) => ({
    surface: "user",
    id,
    keys: userSections.get(id) ?? [],
  })),
  ...idsOf("ADMIN_SECTION_IDS").map((id) => ({
    surface: "admin",
    id,
    keys: adminSections.get(id) ?? [],
  })),
];

/**
 * A key that is not in the dictionary is either a typo or not a key at all.
 *
 * Both extractors are regexes over source and can land on a plain string literal
 * sitting next to a `t()` call; the catalogue component has `"…"` and `"\n"` in
 * it, and both reached the assistant as literal `[missing: …]` lines inside what
 * it was told was the documentation. Those two are dropped, because the source
 * is fine and only the regex over-reached.
 *
 * A key *shaped* token that the dictionary does not have is a different thing
 * entirely: `t("docs.media.voice")` when the entry is `docs.media.voices` is a
 * typo that would render as an empty line in the page a person reads and as a
 * `[missing: …]` in the text the model reads. That one stops the build.
 */
const dictSrc = fs.readFileSync(path.join(ROOT, "src/lib/i18n/dict.ts"), "utf8");
const knownKeys = new Set(
  [...dictSrc.matchAll(/"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)":/g)].map((m) => m[1]),
);
const KEY_SHAPED = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+$/;
const typo = [];
const dropped = [];
for (const s of sections) {
  // Chrome goes through the same dictionary check: it is covered by the index,
  // so a typo in it is just as much a broken string on the rendered page.
  s.chrome = (CHROME[`${s.surface}:${s.id}`] ?? []).filter((k) => {
    if (knownKeys.has(k)) return true;
    if (KEY_SHAPED.test(k)) typo.push(`${s.surface}:${s.id} → ${JSON.stringify(k)}`);
    else dropped.push(`${s.surface}:${s.id} → ${JSON.stringify(k)}`);
    return false;
  });
  s.keys = s.keys.filter((k) => {
    if (knownKeys.has(k)) return true;
    if (KEY_SHAPED.test(k)) typo.push(`${s.surface}:${s.id} → ${JSON.stringify(k)}`);
    else dropped.push(`${s.surface}:${s.id} → ${JSON.stringify(k)}`);
    return false;
  });
}
if (typo.length > 0) {
  console.error(
    `docs index: ${typo.length} key-shaped token(s) do not exist in the dictionary:\n  ` +
      typo.join("\n  "),
  );
  process.exit(1);
}
if (dropped.length > 0) {
  console.log(
    `docs index: dropped ${dropped.length} non-key literal(s) the extractor picked up:\n  ` +
      dropped.join("\n  "),
  );
}

/** The one-line description a reader sees in the index. */
const TITLES = {
  "user:start": "快速开始：这是什么、需要什么环境变量、第一个请求怎么发",
  "user:endpoints": "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
  "user:openai": "OpenAI 兼容用法：chat/completions、鉴权、示例",
  "user:anthropic": "Anthropic 兼容用法：/anthropic/v1/messages",
  "user:responses": "Responses 接口：什么时候用，和 chat/completions 的区别",
  "user:models": "有哪些模型可用：模型名、上下文长度、计价",
  "user:credits": "额度余额：GET /v1/credits 怎么查、is_available、响应头里的额度",
  "user:sdks": "官方 SDK 接法：Python / Node / CLI",
  "user:media": "媒体能力总览与模型目录：图片、视频、语音、音乐",
  "user:catalog": "本部署的模型目录：实时读取服务商表，分对话与媒体两张表",
  "user:parameters": "管理员自己写的参数参考（如果管理员写了的话）",
  "admin:overview": "管理员文档总览",
  "admin:assistant":
    "怎么用 AI 助手：它能体检和批量改配置、能核对厂商文档，以及它做不到什么（改动都要你确认、撤不回已生效的提案、看不到密钥）",
  "admin:providers": "服务商配置：新增、编辑、启用、优先级、格式",
  "admin:faces": "OpenAI 面与 Anthropic 面：分别接哪些模型、为什么要分",
  "admin:routes": "路由规则：一个模型名会走到哪个上游",
  "admin:mapping": "模型映射：客户端模型名 → 上游模型名",
  "admin:quota": "额度与计费：积分怎么算、池子怎么分配",
  "admin:media": "媒体适配：spec 怎么写、request/response 映射",
  "admin:spec-check": "spec 自检：怎么验证一份 spec 写对了",
  "admin:usage": "用量与统计",
  "admin:trouble": "排错：常见报错与对应原因",
  "admin:ops": "运维参考件（非文字说明）",
};

const q = (s) => JSON.stringify(s);
const lines = [];
lines.push("/**");
lines.push(" * GENERATED — do not edit.");
lines.push(" *");
lines.push(" * Produced by `scripts/gen-docs-index.cjs` from the two docs");
lines.push(" * components. `tests/unit/assistant-docs-index.test.ts` re-runs that generator and");
lines.push(" * compares, so a doc page that gains a line fails the build rather than quietly");
lines.push(" * becoming unreadable to the assistant.");
lines.push(" *");
lines.push(" * This exists because the docs are React components and their prose is i18n text,");
lines.push(" * so the grouping has to be extracted rather than read.");
lines.push(" */");
lines.push("");
lines.push("export interface WebDocSection {");
lines.push("  /** Which surface renders it: the public/dashboard docs, or the admin docs. */");
lines.push('  surface: "user" | "admin";');
lines.push("  id: string;");
lines.push("  /** One line on what the page covers, for the index the model reads first. */");
lines.push("  summary: string;");
lines.push("  /** The i18n keys this page renders as prose, in the order it renders them. */");
lines.push("  keys: string[];");
lines.push("  /**");
lines.push("   * Keys this page renders through a component it embeds.");
lines.push("   *");
lines.push("   * Covered by the index and by the dictionary check, and never handed to");
lines.push("   * the model as documentation: a column header and a copy button are the");
lines.push("   * rendered page's own furniture, not what the page is saying.");
lines.push("   */");
lines.push("  chrome?: string[];");
lines.push("  /** Set for a page that is not i18n prose, so the model is told what it is. */");
lines.push("  note?: string;");
lines.push("  /** Appended after the prose: where the rest of the page lives, if it does. */");
lines.push("  after?: string;");
lines.push("}");
lines.push("");
lines.push("export const WEB_DOC_SECTIONS: WebDocSection[] = [");
for (const s of sections) {
  const key = `${s.surface}:${s.id}`;
  const note = NOT_PROSE[key];
  lines.push("  {");
  lines.push(`    surface: ${q(s.surface)},`);
  lines.push(`    id: ${q(s.id)},`);
  lines.push(`    summary: ${q(TITLES[key] ?? "")},`);
  if (note) lines.push(`    note: ${q(note)},`);
  lines.push(`    keys: ${q(s.keys)},`);
  if (s.chrome.length) lines.push(`    chrome: ${q(s.chrome)},`);
  if (AFTER[key]) lines.push(`    after: ${q(AFTER[key])},`);
  lines.push("  },");
}
lines.push("];");
lines.push("");

fs.writeFileSync(OUT, lines.join("\n"), "utf8");

console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)\n`);
for (const s of sections) {
  const key = `${s.surface}:${s.id}`;
  const flag = NOT_PROSE[key] ? " (note)" : s.keys.length === 0 ? " (EMPTY)" : "";
  const chrome = s.chrome.length ? ` + ${s.chrome.length} chrome` : "";
  console.log(`  ${key.padEnd(18)} ${String(s.keys.length).padStart(3)} keys${chrome}${flag}`);
}
const empty = sections.filter((s) => s.keys.length === 0 && !NOT_PROSE[`${s.surface}:${s.id}`]);
if (empty.length) console.log(`\nWARNING empty sections: ${empty.map((s) => s.id).join(", ")}`);
