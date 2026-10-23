/**
 * GENERATED — do not edit.
 *
 * Produced by `scripts/gen-docs-index.cjs` from the two docs
 * components. `tests/unit/assistant-docs-index.test.ts` re-runs that generator and
 * compares, so a doc page that gains a line fails the build rather than quietly
 * becoming unreadable to the assistant.
 *
 * This exists because the docs are React components and their prose is i18n text,
 * so the grouping has to be extracted rather than read.
 */

export interface WebDocSection {
  /** Which surface renders it: the public/dashboard docs, or the admin docs. */
  surface: "user" | "admin";
  id: string;
  /** One line on what the page covers, for the index the model reads first. */
  summary: string;
  /** The i18n keys this page renders as prose, in the order it renders them. */
  keys: string[];
  /**
   * Keys this page renders through a component it embeds.
   *
   * Covered by the index and by the dictionary check, and never handed to
   * the model as documentation: a column header and a copy button are the
   * rendered page's own furniture, not what the page is saying.
   */
  chrome?: string[];
  /** Set for a page that is not i18n prose, so the model is told what it is. */
  note?: string;
  /** Appended after the prose: where the rest of the page lives, if it does. */
  after?: string;
}

export const WEB_DOC_SECTIONS: WebDocSection[] = [
  {
    surface: "user",
    id: "start",
    summary: "快速开始：这是什么、需要什么环境变量、第一个请求怎么发",
    keys: ["docs.title","docs.intro","docs.basics.title","docs.basics.desc","docs.basics.line1","docs.basics.line2","docs.basics.line3","docs.basics.line4","docs.basics.warning"],
    chrome: ["docs.unknown.title","docs.unknown.desc","docs.copy.failed","docs.copy.copied","common.copy"],
  },
  {
    surface: "user",
    id: "endpoints",
    summary: "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
    keys: ["docs.url.title","docs.url.desc","docs.url.public","docs.url.openaiBase","docs.url.anthropicBase"],
  },
  {
    surface: "user",
    id: "endpoints",
    summary: "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
    keys: ["docs.url.title","docs.url.desc","docs.url.public","docs.url.openaiBase","docs.url.anthropicBase"],
  },
  {
    surface: "user",
    id: "media",
    summary: "媒体能力总览与模型目录：图片、视频、语音、音乐",
    keys: ["docs.media.title","docs.media.desc","docs.media.line1","docs.media.image","docs.media.edit","docs.media.video","docs.media.tts","docs.media.stt","docs.media.translate","docs.media.music","docs.media.voices","docs.media.voicesNote","docs.media.voicePicker","docs.media.billing","docs.help.contactAdmin"],
    chrome: ["docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
    after: "实时模型目录用 list_gateway_models 取，那才是当前这张表的真实内容；这一页里内嵌的目录组件是按页面渲染的界面，不是文档正文。",
  },
  {
    surface: "user",
    id: "search",
    summary: "网页搜索接口 /v1/search：怎么调、按次计费、失败不扣费",
    keys: ["docs.search.title","docs.search.desc","docs.search.line1","docs.search.sharesBase","docs.search.baseUrl","docs.search.header","docs.search.examplePost","docs.search.exampleGet","docs.search.requestTitle","docs.search.requestBody","docs.search.requestHint","docs.search.serviceHint","docs.search.responseTitle","docs.search.responseBody","docs.search.responseHint","docs.search.balanceHeader","docs.search.balanceHint","docs.search.billing","docs.search.note","docs.search.assistant","docs.search.ownServiceNote","docs.search.servicesTitle","docs.search.servicesDesc","docs.search.servicesExample","docs.search.servicesResponse","docs.search.servicesHint","docs.search.errorsTitle","docs.search.errorsBody","docs.search.errorsShape","docs.search.errorsTypeHint","docs.search.errorsQuotaTip"],
  },
  {
    surface: "user",
    id: "openai",
    summary: "OpenAI 兼容用法：chat/completions、鉴权、示例",
    keys: ["docs.openai.title","docs.openai.desc","docs.openai.line1","docs.openai.sharesBase","docs.openai.baseUrl","docs.openai.header","docs.openai.example","docs.openai.modelListHint","docs.openai.anyVendor","docs.openai.errors.title","docs.openai.errors.body","docs.openai.errors.shapeLabel","docs.openai.errors.typeHint","docs.openai.errors.quotaTip","docs.openai.errors.balanceHint"],
  },
  {
    surface: "user",
    id: "anthropic",
    summary: "Anthropic 兼容用法：/anthropic/v1/messages",
    keys: ["docs.anthropic.title","docs.anthropic.desc","docs.anthropic.line1","docs.anthropic.baseUrl.official","docs.anthropic.baseUrl.aiSdk","docs.anthropic.baseUrl","docs.anthropic.header","docs.anthropic.baseUrl.tip","docs.anthropic.example","docs.anthropic.sdkHint","docs.anthropic.sdk","docs.anthropic.modelsTitle","docs.anthropic.modelsDesc","docs.anthropic.modelsExample","docs.anthropic.modelsResponse"],
  },
  {
    surface: "user",
    id: "gemini",
    summary: "Gemini 兼容用法：/v1beta/models/{model}:generateContent",
    keys: ["docs.gemini.title","docs.gemini.desc","docs.gemini.line1","docs.gemini.endpoint","docs.gemini.key","docs.gemini.keyValue","docs.gemini.example","docs.gemini.streaming","docs.gemini.limits","docs.gemini.anyVendor"],
  },
  {
    surface: "user",
    id: "responses",
    summary: "Responses 接口：什么时候用，和 chat/completions 的区别",
    keys: ["docs.responses.title","docs.responses.desc","docs.responses.line1","docs.responses.sameAsOpenai","docs.responses.example","docs.responses.alias"],
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
    keys: ["docs.media.title","docs.media.desc","docs.media.line1","docs.media.image","docs.media.edit","docs.media.video","docs.media.tts","docs.media.stt","docs.media.translate","docs.media.music","docs.media.voices","docs.media.voicesNote","docs.media.voicePicker","docs.media.billing","docs.help.contactAdmin"],
    chrome: ["docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
    after: "实时模型目录用 list_gateway_models 取，那才是当前这张表的真实内容；这一页里内嵌的目录组件是按页面渲染的界面，不是文档正文。",
  },
  {
    surface: "user",
    id: "media",
    summary: "媒体能力总览与模型目录：图片、视频、语音、音乐",
    keys: ["docs.media.title","docs.media.desc","docs.media.line1","docs.media.image","docs.media.edit","docs.media.video","docs.media.tts","docs.media.stt","docs.media.translate","docs.media.music","docs.media.voices","docs.media.voicesNote","docs.media.voicePicker","docs.media.billing","docs.help.contactAdmin"],
    chrome: ["docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
    after: "实时模型目录用 list_gateway_models 取，那才是当前这张表的真实内容；这一页里内嵌的目录组件是按页面渲染的界面，不是文档正文。",
  },
  {
    surface: "user",
    id: "endpoints",
    summary: "本部署的对外地址：/v1 与 /anthropic 的 base URL 怎么填",
    keys: ["docs.url.title","docs.url.desc","docs.url.public","docs.url.openaiBase","docs.url.anthropicBase"],
  },
  {
    surface: "user",
    id: "vectors",
    summary: "向量与重排接口 /v1/embeddings、/v1/rerank：怎么调、怎么计费",
    keys: ["docs.vectors.title","docs.vectors.desc","docs.vectors.line1","docs.vectors.embeddings","docs.vectors.embeddingsInput","docs.vectors.rerank","docs.vectors.rerankInput","docs.vectors.billing","docs.vectors.note","docs.help.contactAdmin"],
  },
  {
    surface: "user",
    id: "catalog",
    summary: "本部署的模型目录：实时读取服务商表，分对话与媒体两张表",
    note: "这一页是实时模型目录组件，本身没有文字说明。要当前这张表（对话模型与媒体模型，含上下文长度、最大输出、思考档位、单价）用 list_gateway_models；媒体服务商的配置用 list_media_providers。",
    keys: [],
    chrome: ["docs.catalog.reasoningSwitchOnly","docs.catalog.reasoningAlwaysOn","docs.catalog.reasoningEffortOnly","docs.catalog.reasoningNone","docs.catalog.baseUrl","docs.catalog.chatModels","docs.catalog.mediaModels","docs.catalog.support","docs.catalog.search","docs.catalog.searchPlaceholder","docs.catalog.filter","docs.catalog.all","docs.catalog.chat","docs.catalog.media","docs.catalog.count","docs.catalog.groupChat","docs.catalog.groupMedia","docs.catalog.groupChatDesc","docs.catalog.groupMediaDesc","docs.catalog.model","docs.catalog.providerOf","docs.catalog.context","docs.catalog.maxOutput","docs.catalog.kind","docs.catalog.endpoint","docs.catalog.rateIn","docs.catalog.perMillion","docs.catalog.rateOut","docs.catalog.rateCachedRead","docs.catalog.rateCachedWrite","docs.catalog.pricePerItem","docs.catalog.perItem","docs.catalog.empty","docs.catalog.priority","docs.catalog.detail","docs.catalog.base","docs.catalog.format","docs.catalog.upstream","docs.catalog.reasoningLevels","docs.catalog.thinkingSwitch","docs.catalog.thinkingSwitchYes","docs.catalog.thinkingSwitchNo","docs.catalog.modes","docs.catalog.maxReference","docs.catalog.sizes","docs.catalog.detailEmpty","docs.catalog.providerGroup","docs.catalog.enabled","docs.catalog.disabled","docs.catalog.modelCount"],
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
    summary: "服务商配置：新增、编辑、启用、优先级、格式，以及文本适配协议全文（普通服务商每个兼容接口的参数规则怎么写）",
    keys: ["admin.docs.provider.title","admin.docs.provider.desc","admin.docs.provider.kind","admin.docs.provider.baseUrl","admin.docs.provider.headers","admin.docs.provider.format","admin.docs.provider.formatTrap","admin.docs.provider.modes","admin.docs.provider.specs","admin.docs.provider.textProtocol","admin.docs.textProtocol.title","admin.docs.textProtocol.desc"],
    after: "这一页下半部分的「文本适配协议全文」也是一个仓库文件渲染出来的，read_docs 拿不到它 —— 协议正文用 get_text_spec_reference(what=\"protocol\") 读，分段读，读到 nextOffset 就接着读下一段；可套用的内置预设用 get_text_spec_reference(what=\"presets\") 取。",
  },
  {
    surface: "admin",
    id: "faces",
    summary: "OpenAI 面与 Anthropic 面：分别接哪些模型、为什么要分",
    keys: ["admin.docs.add.title","admin.docs.add.desc","admin.docs.add.step1","admin.docs.add.step2","admin.docs.add.step3","admin.docs.add.step4","admin.docs.add.why","admin.docs.add.note","admin.docs.add.translate"],
  },
  {
    surface: "admin",
    id: "routes",
    summary: "路由规则：一个模型名会走到哪个上游",
    keys: ["admin.docs.routes.title","admin.docs.routes.desc","admin.docs.routes.col.endpoint","admin.docs.routes.col.base","admin.docs.routes.col.format","admin.docs.routes.r1.endpoint","admin.docs.routes.r1.base","admin.docs.routes.r1.format","admin.docs.routes.r2.endpoint","admin.docs.routes.r2.base","admin.docs.routes.r2.format","admin.docs.routes.r3.endpoint","admin.docs.routes.r3.base","admin.docs.routes.r3.format","admin.docs.routes.r4.endpoint","admin.docs.routes.r4.base","admin.docs.routes.r4.format"],
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
    after: "这一页里的「适配协议全文」是一个仓库文件渲染出来的，read_docs 拿不到它 —— 协议正文用 get_media_spec_reference(what=\"protocol\") 读，分段读，读到 nextOffset 就接着读下一段。",
  },
  {
    surface: "admin",
    id: "spec-check",
    summary: "spec 自检：怎么验证一份 spec 写对了",
    keys: ["admin.docs.specCheck.title","admin.docs.specCheck.desc","admin.docs.specCheck.fixtures","admin.docs.specCheck.openStandalone","admin.docs.nav.media","admin.docs.specCheck.usage","admin.docs.specCheck.readonly"],
  },
  {
    surface: "admin",
    id: "search",
    summary: "网页搜索：SearXNG 后端、开关、按次计费、面板与排查",
    keys: ["admin.docs.search.title","admin.docs.search.desc","admin.docs.search.arch","admin.docs.search.config","admin.docs.search.panel","admin.docs.search.security","admin.docs.search.assistant","admin.docs.search.trouble","admin.search.title","admin.search.desc","admin.docs.searchProtocol.title","admin.docs.searchProtocol.desc"],
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
    summary: "运维命令：建管理员、改密码、换密钥、查用量（命令是页面上的字面量，read_docs 读不到）",
    note: "这一页是运维命令：建管理员、改密码、换密钥、查用量。命令本身是页面上的字面量，不是词典里的句子，所以 read_docs 只能拿到这一页的标题和说明，命令列表读不到 —— 需要哪条命令，去 /admin/docs/ops 那一页看，或者问管理员。",
    keys: ["admin.docs.ops.title","admin.docs.ops.desc","docs.title"],
  },
  {
    surface: "admin",
    id: "assistant",
    summary: "怎么用 AI 助手：它能体检和批量改配置、能核对厂商文档，以及它做不到什么（改动都要你确认、撤不回已生效的提案、看不到密钥）",
    keys: ["admin.docs.assistant.title","admin.docs.assistant.desc","admin.docs.assistant.audit","admin.docs.assistant.bulk","admin.docs.assistant.docs","admin.docs.assistant.limits.title","admin.docs.assistant.limits.desc","admin.docs.assistant.limits.approval","admin.docs.assistant.limits.withdraw","admin.docs.assistant.limits.keys","admin.docs.assistant.limits.budget","admin.docs.assistant.ask.title","admin.docs.assistant.ask.desc","admin.docs.assistant.ask.oneShot","admin.docs.assistant.ask.verify","admin.docs.assistant.ask.source"],
  },
];
