/**
 * GENERATED — do not edit.
 *
 * Produced by `scripts/gen-docs-index.cjs` from the two docs
 * components. `tests/unit/assistant-docs-index.test.ts` re-runs that generator and
 * compares, so a doc page that gains a line fails the build rather than quietly
 * becoming unreadable to the assistant.
 *
 * This exists because the docs are React components, their prose is i18n text, and
 * neither the components nor `docs/` is shipped inside the runtime image.
 */

export interface WebDocSection {
  /** Which surface renders it: the public/dashboard docs, or the admin docs. */
  surface: "user" | "admin";
  id: string;
  /** One line on what the page covers, for the index the model reads first. */
  summary: string;
  /** The i18n keys this page renders, in the order it renders them. */
  keys: string[];
  /** Set for a page that is not i18n prose, so the model is told what it is. */
  note?: string;
}

export const WEB_DOC_SECTIONS: WebDocSection[] = [
  {
    surface: "user",
    id: "start",
    summary: "快速开始：这是什么、需要什么环境变量、第一个请求怎么发",
    keys: ["docs.title","docs.intro","docs.basics.title","docs.basics.desc","docs.basics.line1","docs.basics.line2","docs.basics.line3","docs.basics.line4","docs.basics.warning"],
  },
  {
    surface: "user",
    id: "endpoints",
    summary: "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
    keys: ["docs.url.title","docs.url.desc","docs.url.public","docs.url.openaiBase","docs.url.anthropicBase"],
  },
  {
    surface: "user",
    id: "openai",
    summary: "OpenAI 兼容用法：chat/completions、鉴权、示例",
    keys: ["docs.openai.title","docs.openai.desc","docs.openai.line1","docs.openai.sharesBase","docs.openai.baseUrl","docs.openai.header","docs.openai.example","docs.openai.modelListHint","docs.openai.errors.title","docs.openai.errors.body","docs.openai.errors.shapeLabel","docs.openai.errors.typeHint","docs.openai.errors.quotaTip","docs.openai.errors.balanceHint"],
  },
  {
    surface: "user",
    id: "anthropic",
    summary: "Anthropic 兼容用法：/anthropic/v1/messages",
    keys: ["docs.anthropic.title","docs.anthropic.desc","docs.anthropic.line1","docs.anthropic.baseUrl.official","docs.anthropic.baseUrl.aiSdk","docs.anthropic.baseUrl","docs.anthropic.header","docs.anthropic.baseUrl.tip","docs.anthropic.example","docs.anthropic.sdkHint","docs.anthropic.sdk"],
  },
  {
    surface: "user",
    id: "responses",
    summary: "Responses 接口：什么时候用，和 chat/completions 的区别",
    keys: ["docs.responses.title","docs.responses.desc","docs.responses.line1","docs.responses.sameAsOpenai","docs.responses.example"],
  },
  {
    surface: "user",
    id: "models",
    summary: "有哪些模型可用：模型名、上下文长度、计价",
    keys: ["docs.models.title","docs.models.desc","docs.models.line1","docs.models.line2","docs.models.line3","docs.cli.example","docs.models.paramsTitle","docs.models.params"],
  },
  {
    surface: "user",
    id: "credits",
    summary: "额度余额：GET /v1/credits 怎么查、is_available、响应头里的额度",
    keys: ["docs.credits.title","docs.credits.desc","docs.credits.body","docs.credits.exampleLabel","docs.credits.shapeLabel","docs.credits.availHint","docs.credits.snapshotHint","docs.credits.ccswitchTitle","docs.credits.ccswitchNote","docs.credits.ccswitchShapeLabel","docs.credits.ccswitchIsValid","docs.credits.ccswitchScale","docs.credits.ccswitchBaseUrl","docs.credits.headersTitle","docs.credits.headersHint","docs.credits.headersLabel","docs.credits.headersVsEndpoint"],
  },
  {
    surface: "user",
    id: "sdks",
    summary: "官方 SDK 接法：Python / Node / CLI",
    keys: ["docs.python.title","docs.python.desc","docs.python.openai","docs.node.title","docs.node.desc","docs.node.openai"],
  },
  {
    surface: "user",
    id: "media",
    summary: "媒体能力总览与模型目录：图片、视频、语音、音乐",
    keys: ["…","docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","\\n","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
  },
  {
    surface: "user",
    id: "catalog",
    summary: "本部署的模型目录：实时读取服务商表，分对话与媒体两张表",
    keys: ["…","docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","\\n","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
  },
  {
    surface: "user",
    id: "parameters",
    summary: "管理员自己写的参数参考（如果管理员写了的话）",
    note: "参数参考：管理员在后台自己写的取值表——音色、尺寸、每个字段有哪些合法值。一次读一整页，页很大，所以先看索引里的行数再决定读哪一页，不要一上来就把整本吞掉。",
    keys: [],
  },
  {
    surface: "admin",
    id: "overview",
    summary: "管理员文档总览",
    keys: ["admin.docs.subtitle","admin.docs.overview.hint"],
  },
  {
    surface: "admin",
    id: "providers",
    summary: "服务商配置：新增、编辑、启用、优先级、格式",
    keys: ["admin.docs.provider.title","admin.docs.provider.desc","admin.docs.provider.kind","admin.docs.provider.baseUrl","admin.docs.provider.headers","admin.docs.provider.format","admin.docs.provider.formatTrap","admin.docs.provider.modes","admin.docs.provider.specs"],
  },
  {
    surface: "admin",
    id: "faces",
    summary: "OpenAI 面与 Anthropic 面：分别接哪些模型、为什么要分",
    keys: ["admin.docs.add.title","admin.docs.add.desc","admin.docs.add.step1","admin.docs.add.step2","admin.docs.add.step3","admin.docs.add.step4","admin.docs.add.why","admin.docs.add.note"],
  },
  {
    surface: "admin",
    id: "routes",
    summary: "路由规则：一个模型名会走到哪个上游",
    keys: ["admin.docs.routes.title","admin.docs.routes.desc","admin.docs.routes.col.endpoint","admin.docs.routes.col.base","admin.docs.routes.col.format","admin.docs.routes.r1.endpoint","admin.docs.routes.r1.base","admin.docs.routes.r1.format","admin.docs.routes.r2.endpoint","admin.docs.routes.r2.base","admin.docs.routes.r2.format","admin.docs.routes.r3.endpoint","admin.docs.routes.r3.base","admin.docs.routes.r3.format"],
  },
  {
    surface: "admin",
    id: "mapping",
    summary: "模型映射：客户端模型名 → 上游模型名",
    keys: ["admin.docs.mapping.title","admin.docs.mapping.desc","admin.docs.mapping.rule1","admin.docs.mapping.rule2","admin.docs.mapping.rule3"],
  },
  {
    surface: "admin",
    id: "quota",
    summary: "额度与计费：积分怎么算、池子怎么分配",
    keys: ["admin.docs.quota.title","admin.docs.quota.desc","admin.docs.quota.point1","admin.docs.quota.point2","admin.docs.quota.point3"],
  },
  {
    surface: "admin",
    id: "media",
    summary: "媒体适配：spec 怎么写、request/response 映射",
    keys: ["admin.docs.media.title","admin.docs.media.desc","admin.docs.media.rule1","admin.docs.media.rule2","admin.docs.media.rule3","admin.docs.nav.media","admin.docs.protocol.title","admin.docs.protocol.desc"],
  },
  {
    surface: "admin",
    id: "spec-check",
    summary: "spec 自检：怎么验证一份 spec 写对了",
    keys: ["admin.docs.specCheck.title","admin.docs.specCheck.desc","admin.docs.specCheck.fixtures","admin.docs.specCheck.openStandalone","admin.docs.nav.media","admin.docs.specCheck.usage","admin.docs.specCheck.readonly"],
  },
  {
    surface: "admin",
    id: "usage",
    summary: "用量与统计",
    keys: ["admin.docs.usage.title","admin.docs.usage.desc","admin.docs.usage.rule1","admin.docs.usage.rule2","admin.docs.usage.rule3","admin.docs.usage.rule4","admin.docs.usage.rule5","usage.title"],
  },
  {
    surface: "admin",
    id: "trouble",
    summary: "排错：常见报错与对应原因",
    keys: ["admin.docs.trouble.title","admin.docs.trouble.desc","admin.docs.trouble.step1","admin.docs.trouble.step2","admin.docs.trouble.step3"],
  },
  {
    surface: "admin",
    id: "ops",
    summary: "运维参考件（非文字说明）",
    note: "这一页不是文字说明，而是两份从仓库文件实时渲染的参考件：媒体适配协议（docs/模型适配协议/README.md）和 spec-check 脚本（scripts/spec-check.ts）。它们是给「写 spec 的 AI」用的原文，不是网关文档。需要其中某一份的内容，请用 fetch_page 或让用户从管理界面复制。",
    keys: [],
  },
  {
    surface: "admin",
    id: "assistant",
    summary: "怎么用 AI 助手：它能体检和批量改配置、能核对厂商文档，以及它做不到什么（改动都要你确认、撤不回已生效的提案、看不到密钥）",
    keys: ["admin.docs.assistant.title","admin.docs.assistant.desc","admin.docs.assistant.audit","admin.docs.assistant.bulk","admin.docs.assistant.docs","admin.docs.assistant.limits.title","admin.docs.assistant.limits.desc","admin.docs.assistant.limits.approval","admin.docs.assistant.limits.withdraw","admin.docs.assistant.limits.keys","admin.docs.assistant.limits.budget","admin.docs.assistant.ask.title","admin.docs.assistant.ask.desc","admin.docs.assistant.ask.oneShot","admin.docs.assistant.ask.verify","admin.docs.assistant.ask.source","admin.docs.ops.title","admin.docs.ops.desc","docs.title"],
  },
];
