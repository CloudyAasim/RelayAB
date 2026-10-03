/**
 * Generate the web-documentation index the assistant reads from.
 *
 * **The web docs only.** The repository's markdown was considered and dropped:
 * the assistant does not need it, and `docs/` does not exist inside the
 * runtime image anyway.
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
 */
function extractSections(file, fallbackSection) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const groups = new Map();
  let current = null;

  for (const line of src.split("\n")) {
    const cmp = line.match(/section === "([a-z0-9-]+)"/);
    const arm = line.match(/case "([a-z0-9-]+)"/);
    if (cmp) current = cmp[1];
    else if (arm) current = arm[1];

    for (const m of line.matchAll(/t\("([^"]+)"/g)) {
      const group = current ?? fallbackSection;
      if (!groups.has(group)) groups.set(group, []);
      const keys = groups.get(group);
      if (!keys.includes(m[1])) keys.push(m[1]);
    }
  }
  return groups;
}

const userSections = extractSections("src/app/(user)/dashboard/docs/DocsContent.tsx", "start");
const adminSections = extractSections("src/app/(admin)/admin/docs/AdminDocsContent.tsx", "overview");

// ---------------------------------------------------------------------------
// The two pages that are not a branch of i18n prose
// ---------------------------------------------------------------------------

/**
 * The two chapters that are not a branch of i18n prose in `DocsContent`.
 *
 * `media` renders `<ModelCatalog>`, so its text lives in another component
 * entirely. `catalog` renders the same component on its own, as a chapter of
 * its own. Both are added explicitly rather than left empty, because an empty
 * section reads as "this page says nothing" and the model would say so.
 */
const catalogSrc = [
  "src/components/docs/ModelCatalog.tsx",
  "src/components/docs/ModelCatalogPanel.tsx",
]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
  .join("\n");
const catalogKeys = [...new Set([...catalogSrc.matchAll(/t\("([^"]+)"/g)].map((m) => m[1]))];
userSections.set("media", catalogKeys);
userSections.set("catalog", catalogKeys);

// The admin `ops` page renders two reference components that read repository
// files at request time — the adapter protocol and the spec-check script. They
// are not i18n prose and are not the documentation of the gateway; the entry
// says so rather than returning an empty page the model would read as silence.
const NOT_PROSE = {
  "admin:ops":
    "这一页不是文字说明，而是两份从仓库文件实时渲染的参考件：媒体适配协议" +
    "（docs/模型适配协议/README.md）和 spec-check 脚本（scripts/spec-check.ts）。" +
    "它们是给「写 spec 的 AI」用的原文，不是网关文档。需要其中某一份的内容，"+
    "请用 fetch_page 或让用户从管理界面复制。",
  // The operator's chapter. Written at runtime from the admin form, so it has
  // no keys here at all — this index covers the built-in pages, and
  // `createDocReader` adds that one from the settings row.
  "user:notes":
    "站长自己写的补充说明。这一章不属于内置文档，是管理员在后台自己写的，" +
    "每次提问都按当时的版本读取。",
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

/** The one-line description a reader sees in the index. */
const TITLES = {
  "user:start": "快速开始：这是什么、需要什么环境变量、第一个请求怎么发",
  "user:endpoints": "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
  "user:openai": "OpenAI 兼容用法：chat/completions、鉴权、示例",
  "user:anthropic": "Anthropic 兼容用法：/anthropic/v1/messages",
  "user:responses": "Responses 接口：什么时候用，和 chat/completions 的区别",
  "user:models": "有哪些模型可用：模型名、上下文长度、计价",
  "user:sdks": "官方 SDK 接法：Python / Node / CLI",
  "user:media": "媒体能力总览与模型目录：图片、视频、语音、音乐",
  "user:catalog": "本部署的模型目录：实时读取服务商表，分对话与媒体两张表",
  "user:notes": "站长自己写的补充说明（如果管理员写了的话）",
  "admin:overview": "管理员文档总览",
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
lines.push(" * This exists because the docs are React components, their prose is i18n text, and");
lines.push(" * neither the components nor `docs/` is shipped inside the runtime image.");
lines.push(" */");
lines.push("");
lines.push("export interface WebDocSection {");
lines.push("  /** Which surface renders it: the public/dashboard docs, or the admin docs. */");
lines.push('  surface: "user" | "admin";');
lines.push("  id: string;");
lines.push("  /** One line on what the page covers, for the index the model reads first. */");
lines.push("  summary: string;");
lines.push("  /** The i18n keys this page renders, in the order it renders them. */");
lines.push("  keys: string[];");
lines.push("  /** Set for a page that is not i18n prose, so the model is told what it is. */");
lines.push("  note?: string;");
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
  lines.push("  },");
}
lines.push("];");
lines.push("");

fs.writeFileSync(OUT, lines.join("\n"), "utf8");

console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)\n`);
for (const s of sections) {
  const key = `${s.surface}:${s.id}`;
  const flag = NOT_PROSE[key] ? " (note)" : s.keys.length === 0 ? " (EMPTY)" : "";
  console.log(`  ${key.padEnd(18)} ${String(s.keys.length).padStart(3)} keys${flag}`);
}
const empty = sections.filter((s) => s.keys.length === 0 && !NOT_PROSE[`${s.surface}:${s.id}`]);
if (empty.length) console.log(`\nWARNING empty sections: ${empty.map((s) => s.id).join(", ")}`);
