/**
 * src/lib/assistant/tool-text.ts
 *
 * The assistant's tool layer, in two languages.
 *
 * Two tables, one structure:
 *
 *  - **TOOL_DESCRIPTIONS** — what each tool says about itself. The tool
 *    catalogue in `tools.ts` is the *shape* (names, parameters, enums); this is
 *    the *prose*, and the prose is what the model reads before it decides
 *    which tool to call and what to put in the arguments. It was Chinese only,
 *    which a model understands perfectly well — but an English reader watching
 *    a tool call in the interface was reading a Chinese instruction sheet.
 *
 *  - **TOOL_REFUSALS** — what a tool says when it refuses. These are read by
 *    the person in front of the screen, in the tool card, so they follow the
 *    reader's language rather than the deployment's.
 *
 * ## Why the text lives here and not in `tools.ts`
 *
 * The structure is one thing and the wording is another, and mixing them makes
 * both worse: a Chinese-only description cannot be translated without touching
 * the schema around it, and a schema change is a change to what the model is
 * offered. So the catalogue stays in `tools.ts` — one definition, one shape —
 * and every sentence in it is a lookup here.
 *
 * The keys are derived, not invented:
 *
 *  - a tool's own description is keyed by the tool name (`list_gateway_models`);
 *  - a parameter's description is `<tool>.<parameter>` (`test_gateway_model.model`);
 *  - a parameter of a parameter is `<tool>.<parameter>.<field>`
 *    (`propose_provider_update.models.purpose`).
 *
 * Parameter names are unique inside a tool, so the derivation cannot collide.
 *
 * ## The fallback is Chinese on purpose
 *
 * A missing row returns the key itself rather than an empty string: an empty
 * description is invisible, and a description that reads as its own key is a
 * bug somebody can see. A row that has a Chinese text but no English yet reads
 * as Chinese — the deployment's own language is always a truthful answer.
 */
import type { Locale } from "../i18n/dict";

/** A sentence in both languages. */
export interface ToolText {
  "zh-CN": string;
  en: string;
}

/**
 * Every description the tool catalogue uses.
 *
 * The Chinese column is the wording the deployment has been running: it is
 * copied over unchanged, because it is the prompt material that is already
 * working. The English column is a translation rather than a summary, so the
 * two say the same thing.
 */
export const TOOL_DESCRIPTIONS: Record<string, ToolText> = {
  "ask_user": {
    "zh-CN":
      "向用户提一个问题，然后这一轮就结束，等他回答。\n\n" +
      "**什么时候必须用它**：有一件事你不知道答案，而猜错的代价比多问一句大。" +
      "典型的是需要人做决定或需要只有他知道的事——这个模型的价格是多少、" +
      "要不要开启某个协议面、你更想要哪种做法。\n\n" +
      "**什么时候不要用**：文档里写着答案的（先去查文档）、用户刚才说过的、" +
      "你自己能定一个合理默认并把它讲清楚的。\n\n" +
      "**用了它之后必须停止**。不要再调用任何其他工具，不要接着往下做，" +
      "也不要「顺便假设一个答案继续」。用户的回答会在下一轮到达你手里。\n\n" +
      "options 是给用户点的按钮——当他只有几个明确选择时给上它" +
      "（比如「切成高级模式」「先只用 OpenAI 面」）；" +
      "当他可能要自己输入（价格、URL）就留空，只用 question。",
    en:
      "Ask the user one question, then end this turn and wait for the answer.\n\n" +
      "**When you must use it**: there is something you do not know the answer to, and guessing wrong " +
      "costs more than asking one more question. The typical cases are a decision only a person can " +
      "make, or a fact only they know — what this model costs, whether a protocol surface should be " +
      "turned on, which approach they would rather have.\n\n" +
      "**When you must not use it**: the answer is in the documentation (go and read the docs), the " +
      "user just told you, or you can pick a sensible default yourself and explain it clearly.\n\n" +
      "**After using it you must stop.** Do not call any other tool, do not carry on with the work, " +
      "and do not \"assume an answer and carry on anyway\". The user's answer will reach you on the " +
      "next turn.\n\n" +
      "options are the buttons the user can click — offer them when there are only a few clear " +
      "choices (for example \"switch to advanced mode\" \"use only the OpenAI surface for now\"). " +
      "Leave them empty when the user may have to type something themselves (a price, a URL) and use " +
      "question alone.",
  },
  "ask_user.question": {
    "zh-CN": "要问的问题。一句话，具体到能直接回答。",
    en: "The question to ask. One sentence, specific enough to be answered directly.",
  },
  "ask_user.options": {
    "zh-CN":
      "可选的候选答案，会显示成按钮让用户点。答案数量少而确定时用它，" +
      "用户可能自己输入时不要给。",
    en:
      "Optional candidate answers, shown as buttons for the user to click. Use them when there are " +
      "few answers and they are certain; do not offer them when the user may type their own.",
  },
  "ask_user.placeholder": {
    "zh-CN": "自由输入框的占位提示，例如「输入每百万 token 的积分价格」。",
    en: "Placeholder text for the free-form input box, for example \"enter the credit price per million tokens\".",
  },
  "ask_user.hint": {
    "zh-CN": "可选：这个问题问出来是为了什么、答案会用来做什么。",
    en: "Optional: why this question is being asked, and what the answer will be used for.",
  },
  "list_gateway_models": {
    "zh-CN":
      "列出这个 RelayAB 网关当前对外提供的所有模型（聊天与媒体），**并带上每个聊天模型的" +
      "上下文窗口、最大输出，以及思考能力**——思考那部分在 reasoning 字段里，" +
      "levels（可选档位）、effortSupported（能不能调深度）、switchSupported（能不能关掉）" +
      "**三者必须一起读、一起说**，缺一不可。回答「有哪些模型」「上下文多大」" +
      "「支持思考吗 / 能选哪几档 / 能不能关掉」这类问题时先调它，" +
      "不要凭记忆报模型名，也不要因为看不到管理员配置就说查不到——数字就在这个返回值里。",
    en:
      "List every model this RelayAB gateway currently serves (chat and media), **together with " +
      "each chat model's context window, maximum output and thinking capability** — the thinking " +
      "part is in the reasoning field: levels (the optional tiers), effortSupported (whether the " +
      "depth can be adjusted), switchSupported (whether it can be turned off). " +
      "**All three must be read together and reported together**; none of them may be left out. " +
      "Call this first when answering questions like \"which models do you serve\" \"how big is the " +
      "context\" \"do they support thinking / which tiers can I pick / can it be turned off\". Do not " +
      "recite model names from memory, and do not claim you cannot find them because you cannot see " +
      "the administrator's configuration — the numbers are right there in this result.",
  },
  "test_gateway_model": {
    "zh-CN":
      "用一个具体模型跑一次真实请求，验证它是否真的可用。会消耗用户自己的配额。" +
      "回答「这个模型能用吗」「帮我试试 X」时用它，而不是只看模型列表就下结论。",
    en:
      "Run one real request against a specific model to verify that it actually works. It spends " +
      "the user's own quota. Use it when answering \"does this model work\" \"try X for me\" instead " +
      "of concluding from the model list alone.",
  },
  "test_gateway_model.model": {
    "zh-CN": "要测试的模型名，取自 list_gateway_models",
    en: "The model to test, taken from list_gateway_models",
  },
  "test_gateway_model.prompt": {
    "zh-CN": "测试提示词，默认一个简短问题",
    en: "The test prompt; defaults to one short question",
  },
  "get_my_usage": {
    "zh-CN": "查询当前用户的配额、已用积分、密钥列表和最近用量。",
    en: "Look up the current user's quota, credits used, key list and recent usage.",
  },
  "get_deployment_notes": {
    "zh-CN":
      "取回本项目的部署参考：环境变量、Dokku/SQLite 部署步骤、备份与排错要点。" +
      "用户问「怎么部署」「要配什么环境变量」「怎么备份」时用它，答案要基于返回内容而不是记忆。",
    en:
      "Retrieve this project's deployment reference: environment variables, Dokku/SQLite deployment " +
      "steps, backup and troubleshooting essentials. Use it when the user asks \"how do I deploy " +
      "this\" \"which environment variables do I need\" \"how do I back it up\", and base the answer on " +
      "what it returns rather than on memory.",
  },
  "get_deployment_notes.topic": {
    "zh-CN": "可选 narrowed 主题，如 dokku / env / backup / nginx",
    en: "Optional narrowed topic, such as dokku / env / backup / nginx",
  },
  "web_search": {
    "zh-CN":
      "搜索公开网页，返回标题、网址和摘要。**不知道厂商文档地址时先用它**，拿到候选地址再用 " +
      "fetch_page 读正文 —— 摘要不是文档，不能拿摘要里的字段名去写配置。\n" +
      "工具本身只做检索，不读页面；结果里每条 url 都可以直接交给 fetch_page。\n" +
      "如果部署没有配置搜索后端，它会明确告诉你，这时才向用户要链接；" +
      "**不要在没有调用它的情况下声称「我搜索了」**。",
    en:
      "Search the public web and return titles, URLs and snippets. **Use it first when you do not " +
      "know a vendor's documentation URL**; once you have a candidate URL, read the body with " +
      "fetch_page — a snippet is not the documentation, and you must not write configuration from " +
      "field names you only saw in a snippet.\n" +
      "The tool itself only retrieves; it does not read pages. Every url in the result can be handed " +
      "straight to fetch_page.\n" +
      "If the deployment has no search backend configured it will say so plainly, and only then " +
      "should you ask the user for a link. **Do not claim \"I searched\" without having called it.**",
  },
  "web_search.query": {
    "zh-CN": "搜索词。写清楚厂商名和要找的东西，例如「智谱 BigModel 图像生成 API 文档」。",
    en: "The search terms. Name the vendor and what you are looking for, for example \"Zhipu BigModel image generation API documentation\".",
  },
  "web_search.limit": {
    "zh-CN": "最多返回几条，1–8，默认 6。",
    en: "How many results to return at most, 1–8, default 6.",
  },
  "fetch_page": {
    "zh-CN":
      "抓取一个公开网页并读出正文文字。查厂商官方文档、API 参考、报错说明时用它 —— " +
      "这些内容不能靠记忆编。用户给了一个网址、或者问题需要看某个具体页面时，先调它再回答。" +
      "只支持 http/https 的公网地址，内网地址会被拒绝；返回的是正文纯文本，不含图片和脚本。\n" +
      "如果页面是单页应用、正文抓不到，工具会自动尝试同域的 Markdown 版本、llms.txt 和 openapi.json，" +
      "并在结果里标出可继续读的地址。",
    en:
      "Fetch a public web page and read out its body text. Use it for vendor official documentation, " +
      "API references and error explanations — that content cannot be made up from memory. When the " +
      "user gives you a URL, or the question needs a particular page, call it before answering. " +
      "Only public http/https addresses are supported and private ones are refused; what comes back is " +
      "plain body text, without images or scripts.\n" +
      "If the page is a single-page app and the body cannot be fetched, the tool automatically tries " +
      "the Markdown version on the same domain, llms.txt and openapi.json, and marks the addresses " +
      "that can still be read in the result.",
  },
  "fetch_page.url": {
    "zh-CN": "要读的完整网址，例如 https://platform.minimaxi.com/docs/api-reference/image-generation",
    en: "The full URL to read, for example https://platform.minimaxi.com/docs/api-reference/image-generation",
  },
  "read_docs": {
    "zh-CN":
      "读本系统自己的文档正文 —— 和用户界面上 /docs、/dashboard/docs、/admin/docs 显示的是同一份。\n" +
      "不带 topic 返回目录；带 topic 返回那一页的全文。\n" +
      "凡是问「这个系统怎么用」「这个接口怎么调」「这个配置项是什么意思」「为什么报这个错」，" +
      "都要先读文档再回答，不要凭记忆作答。管理员文档只有管理员能读。",
    en:
      "Read this system's own documentation — the same text the reader sees at /docs, " +
      "/dashboard/docs and /admin/docs.\n" +
      "Without a topic it returns the table of contents; with a topic it returns that page in full.\n" +
      "For anything like \"how do I use this system\" \"how do I call this endpoint\" \"what does this " +
      "setting mean\" \"why am I getting this error\", read the documentation first and answer from " +
      "it rather than from memory. Only administrators can read the admin documentation.",
  },
  "read_docs.topic": {
    "zh-CN":
      "不填则返回目录。填写形如 openai、anthropic、media、providers、trouble、mapping。" +
      "也可以写 user:openai 或 admin:providers 指定是哪一套。",
    en:
      "Leave it out to get the table of contents. Otherwise give a topic such as openai, anthropic, " +
      "media, providers, trouble, mapping. You can also write user:openai or admin:providers to say " +
      "which set you mean.",
  },
  "generate_image": {
    "zh-CN":
      "用一个媒体模型生成图片，返回图片 URL。走的是本系统的 /v1/images/generations 端点，" +
      "消耗用户自己的配额。\n" +
      "图生图（以图为参考）用 image 参数：填 attachment 表示「用用户这条消息里附的那张图」，" +
      "或直接给一个 http(s) 图片网址。服务商是否支持图生图取决于它的 spec，" +
      "先用 list_media_providers 看该模型的 spec 里 metadata.modes 有没有 image-to-image。",
    en:
      "Generate an image with a media model and return the image URL. It goes through this system's " +
      "/v1/images/generations endpoint and spends the user's own quota.\n" +
      "For image-to-image (working from a reference picture) use the image parameter: put attachment " +
      "to mean \"the picture attached to this message\", or give an http(s) image URL directly. " +
      "Whether a provider supports image-to-image depends on its spec — call list_media_providers " +
      "first and check whether the model's spec lists image-to-image under metadata.modes.",
  },
  "generate_image.model": {
    "zh-CN": "图片模型名，取自 list_gateway_models 的 mediaModels",
    en: "The image model name, taken from mediaModels in list_gateway_models",
  },
  "generate_image.prompt": {
    "zh-CN": "想生成什么画面",
    en: "What the picture should show",
  },
  "generate_image.size": {
    "zh-CN": "如 1024x1024；不填则用服务商默认",
    en: "For example 1024x1024; leave it out to use the provider's default",
  },
  "generate_image.ratio": {
    "zh-CN": "宽高比，如 16:9、9:16。服务商通常按尺寸表把它换算成实际尺寸。",
    en: "Aspect ratio, for example 16:9 or 9:16. Providers usually turn it into actual dimensions using their size table.",
  },
  "generate_image.image": {
    "zh-CN":
      "参考图。填 attachment 表示用用户这条消息里附的图片；也可以给一个 http(s) 图片网址。" +
      "不填就是文生图。这个工具不接收 base64。",
    en:
      "The reference picture. Put attachment to use the image attached to this message; you can also " +
      "give an http(s) image URL. Leave it out for plain text-to-image. This tool does not accept " +
      "base64.",
  },
  "list_voices": {
    "zh-CN":
      "列出本部署能用的全部音色（按服务商分组，含显示名、描述和适用模型）。" +
      "查「有哪些音色」「这个音色支持哪些模型」「换音色」时先调它，不要凭记忆报音色 id。",
    en:
      "List every voice this deployment can use (grouped by provider, with display name, description " +
      "and the models it applies to). Call it first when asked \"which voices are there\" \"which models " +
      "does this voice support\" \"can I change the voice\", and do not recite voice ids from memory.",
  },
  "generate_speech": {
    "zh-CN":
      "用语音合成模型把文字读成音频，返回实际生成的字节数与 content-type。" +
      "走 /v1/audio/speech，消耗用户自己的配额。",
    en:
      "Read text out loud with a speech synthesis model and return the number of bytes actually " +
      "produced plus the content-type. It goes through /v1/audio/speech and spends the user's own " +
      "quota.",
  },
  "generate_speech.model": {
    "zh-CN": "语音模型名",
    en: "The speech model name",
  },
  "generate_speech.input": {
    "zh-CN": "要读出来的文字",
    en: "The text to read out",
  },
  "generate_speech.voice": {
    "zh-CN":
      "音色 id。留空则使用已验证可用的默认值 —— MiniMax 的 t2a_v2 缺少 voice_id 会直接拒绝，" +
      "所以这不是真正可选的。",
    en:
      "The voice id. Leave it empty to use a verified default — MiniMax's t2a_v2 rejects a request " +
      "without voice_id, so this is not really optional.",
  },
  "transcribe_audio": {
    "zh-CN":
      "把一段语音转成文字。传 attachment（用户这一条消息里附的音频）、一个 http(s) 音频网址，" +
      "或一个 data URL。走 /v1/audio/transcriptions，消耗用户自己的配额，返回识别出的文本。\n" +
      "如果用户发来的是音频而你在找别的办法，先用这个 —— 网关已经配好了 ASR 模型，" +
      "不需要让用户自己去发请求。",
    en:
      "Transcribe a piece of audio into text. Pass attachment (the audio attached to this message), " +
      "an http(s) audio URL, or a data URL. It goes through /v1/audio/transcriptions, spends the " +
      "user's own quota, and returns the recognised text.\n" +
      "If the user has sent audio and you are looking for another way to read it, use this first — " +
      "the gateway already has ASR models configured, and the user does not have to send the request " +
      "themselves.",
  },
  "transcribe_audio.model": {
    "zh-CN": "语音识别模型名，例如 asr-1.0",
    en: "The speech recognition model name, for example asr-1.0",
  },
  "transcribe_audio.audio": {
    "zh-CN": "attachment、http(s) 音频网址，或 data URL。",
    en: "attachment, an http(s) audio URL, or a data URL.",
  },
  "transcribe_audio.language": {
    "zh-CN": "音频主要语言，可留空。中文例如 zh。",
    en: "The main language of the audio; may be left empty. Chinese, for example, is zh.",
  },
  "generate_video": {
    "zh-CN":
      "提交一个视频生成任务。视频是异步的：这里只返回任务 id 和当前状态，" +
      "产物要稍后由上游查询，不要在这里反复重试。",
    en:
      "Submit a video generation job. Video is asynchronous: this returns only the job id and the " +
      "current status, and the artefact has to be fetched from the upstream a little later — do not " +
      "keep retrying here.",
  },
  "generate_video.model": {
    "zh-CN": "视频模型名",
    en: "The video model name",
  },
  "generate_video.prompt": {
    "zh-CN": "想生成什么画面",
    en: "What the video should show",
  },
  "generate_video.duration": {
    "zh-CN": "时长（秒）；留空用默认值",
    en: "Duration in seconds; leave it empty to use the default",
  },
  "generate_video.ratio": {
    "zh-CN": "画面比例，如 16:9；留空用默认值",
    en: "Frame ratio, for example 16:9; leave it empty to use the default",
  },
  "audit_provider_config": {
    "zh-CN":
      "体检一个聊天服务商的模型配置，找出**具体哪几个模型、哪个字段**有问题。\n" +
      "用户问「这个服务商的配置有没有问题」「为什么有的模型不收钱」时先调这个，" +
      "拿到清单再用 propose_model_configs_update 一次改完。\n" +
      "只读，不改任何东西。检查项：价格全为 0 的模型、积分与元混用、缓存读取有价但写入没填、" +
      "声明了不支持思考等级却仍然有档位、上下文或输出上限缺失。",
    en:
      "Check a chat provider's model configuration and find out **which models and which fields** " +
      "are wrong.\n" +
      "Call this when the user asks \"is this provider's configuration broken\" \"why are some models " +
      "not being charged\", then fix the whole list in one go with propose_model_configs_update.\n" +
      "Read-only; it changes nothing. What it checks: models priced at 0 throughout, credits and yuan " +
      "mixed together, a priced cache read with no cache write price, a model that declares thinking " +
      "levels unsupported while still offering tiers, and a missing context or output limit.",
  },
  "audit_provider_config.providerId": {
    "zh-CN": "要体检的服务商 id；省略则体检全部",
    en: "The id of the provider to check; omit it to check every provider",
  },
  "propose_model_configs_update": {
    "zh-CN":
      "**一次性配置一个服务商下多个模型**——上下文、最大输出、思考等级、思考等级支持声明、" +
      "四个价格、显示名、是否启用。\n" +
      "管理员点一次确认，全部生效。\n\n" +
      "**要一次改多个模型就用这个，不要循环调 propose_model_config_update**——" +
      "那会生成 N 条提案、要点 N 次确认，而且中途失败会留下半配置的状态。\n" +
      "只改一个模型时两个都行，这个更省事。\n\n" +
      "models 里只写要改的字段；没写的字段保持原样，不会被清零。\n\n" +
      "**被拦下来的时候**：如果提示里说某个字段「看起来是错的」，先判断是值真的错了、" +
      "还是这条检查误伤了一个已经就对的配置。值错了就改值；确实如此（比如厂商的这两个模型真的免费）" +
      "就在 confirmFindings 里写上「code:模型名」，例如 all_zero:agnes-2.5-flash。**不要原样重发一遍**，" +
      "同样的内容会得到同样的拒绝。",
    en:
      "**Configure several models of one provider in a single proposal** — context, maximum output, " +
      "thinking tiers, the thinking-tier support declaration, four prices, display name, and whether " +
      "each model is enabled.\n" +
      "The administrator confirms once and all of it takes effect.\n\n" +
      "**Use this when you need to change several models at once; do not loop over " +
      "propose_model_config_update** — that produces N proposals, N confirmations, and leaves the " +
      "provider half-configured if one of them fails partway through.\n" +
      "When you are only changing one model, either tool is fine; this one is less work.\n\n" +
      "In models, write only the fields you want to change; the ones you leave out keep their current " +
      "values and are not zeroed.\n\n" +
      "**When it is refused**: if the message says a field \"looks wrong\", first work out whether the " +
      "value really is wrong or whether the check has caught a configuration that was already correct. " +
      "If the value is wrong, fix the value; if it really is that way (these two models are genuinely " +
      "free at the vendor), write \"code:model-name\" in confirmFindings, for example " +
      "all_zero:agnes-2.5-flash. **Do not send the same thing again** — identical content gets the " +
      "identical refusal.",
  },
  "propose_model_configs_update.providerId": {
    "zh-CN": "服务商 id，用 list_providers 查",
    en: "The provider id; look it up with list_providers",
  },
  "propose_model_configs_update.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_model_configs_update.models": {
    "zh-CN": "模型名 → 该模型要设的字段。只有列出的字段会被写入，其余保持原样。",
    en: "Model name → the fields to set for that model. Only the listed fields are written; the rest keep their current values.",
  },
  "propose_model_configs_update.models.purpose": {
    "zh-CN":
      "这个模型是做什么用的：chat（对话）、embedding（向量）、rerank（重排）、moderation（审核）。\n" +
      "决定它在管理员给账号授权时归到哪一组 —— 不设就是对话模型。",
    en:
      "What this model is for: chat (conversation), embedding (vectors), rerank (reranking), " +
      "moderation (moderation).\n" +
      "It decides which group the model falls into when an administrator grants an account access " +
      "— leave it unset and the model counts as a chat model.",
  },
  "propose_model_configs_update.models.contextLength": {
    "zh-CN": "上下文长度（输入 token 上限）",
    en: "Context length (the input token limit)",
  },
  "propose_model_configs_update.models.reasoningLevels": {
    "zh-CN":
      "这个模型接受的思考等级，照厂商文档原样写。空数组 = 不支持。\n" +
      "厂商文档明确写了它不读这个参数时，同时设 reasoningEffortSupported: false——" +
      "界面会把对应的下拉置灰。",
    en:
      "The thinking tiers this model accepts, written exactly as the vendor's documentation has " +
      "them. An empty array means unsupported.\n" +
      "When the vendor's documentation says plainly that it ignores this parameter, also set " +
      "reasoningEffortSupported: false — the matching dropdown is greyed out in the interface.",
  },
  "propose_model_configs_update.models.reasoningEffortSupported": {
    "zh-CN":
      "厂商是否支持 reasoning_effort。填 false 会让助手设置里的档位下拉置灰。" +
      "不确定就别传——没声明过和声明过「不支持」是两回事，只有传了才会置灰。",
    en:
      "Whether the vendor supports reasoning_effort. Setting false greys out the tier dropdown in " +
      "the assistant settings. Leave it out if you are not sure — never having declared it and " +
      "declaring it \"unsupported\" are two different things, and only sending it greys the control out.",
  },
  "propose_model_configs_update.models.thinkingSwitchSupported": {
    "zh-CN":
      "厂商是否接受 thinking 开关（关掉思考）。填 false 会让助手设置里的「思考开关」置灰。\n" +
      "**厂商会拒绝关闭请求时填 false**：M2.x 系列收下 disabled 却照样思考；" +
      "M3.1-Flash-Preview 直接返回 400。只有 MiniMax-M3 认这个开关。",
    en:
      "Whether the vendor accepts the thinking switch (turning thinking off). Setting false greys " +
      "out the \"thinking switch\" in the assistant settings.\n" +
      "**Set false when the vendor refuses to turn thinking off**: the M2.x series accepts disabled " +
      "and thinks anyway; M3.1-Flash-Preview returns 400 outright. Only MiniMax-M3 honours this " +
      "switch.",
  },
  "propose_model_configs_update.models.inputCost": {
    "zh-CN": "每 100 万输入 token 的积分",
    en: "Credits per 1M input tokens",
  },
  "propose_model_configs_update.models.outputCost": {
    "zh-CN": "每 100 万输出 token 的积分",
    en: "Credits per 1M output tokens",
  },
  "propose_model_configs_update.models.cachedInputCost": {
    "zh-CN":
      "每 100 万「命中上游提示缓存」的输入 token 的积分。0 = 缓存命中免费。不填 = 按 inputCost 算。",
    en:
      "Credits per 1M input tokens that hit the upstream prompt cache. 0 = cache hits are free. " +
      "Leave it out to charge by inputCost.",
  },
  "propose_model_configs_update.models.cacheWriteCost": {
    "zh-CN":
      "每 100 万「写入上游缓存」的积分。0 = 写入免费。**留空和 0 不是一回事**：留空会按 inputCost 收钱。",
    en:
      "Credits per 1M tokens written to the upstream cache. 0 = writes are free. **Leaving it empty " +
      "and setting 0 are not the same thing**: leaving it empty charges by inputCost.",
  },
  "propose_model_configs_update.confirmFindings": {
    "zh-CN":
      "你确认过、因而不再拦下来的检查项，格式「code:模型名」，例如 " +
      "\"all_zero:agnes-2.5-flash\"。**只在厂商文档或官方定价页确写它免费时才用。**\n" +
      "只有真正会被这次改动碰到的字段才会被拦；模型本来就是 0 价、而你只是在改上下文长度，" +
      "那样根本不会被拦，也不需要在这里声明。",
    en:
      "The checks you have confirmed and are therefore no longer blocked on, in the form " +
      "\"code:model-name\", for example \"all_zero:agnes-2.5-flash\". **Use it only when the " +
      "vendor's documentation or official pricing page says the model is free.**\n" +
      "Only the fields this change actually touches are blocked. A model that was already priced at " +
      "0 and that you are merely changing the context length for is not blocked at all, and needs " +
      "no mention here.",
  },
  "withdraw_proposal": {
    "zh-CN":
      "撤回一条**还在待确认**的提案。propose_* 只能建不能撤，缺了这个工具，" +
      "助手就只能看着自己提交的东西一直挂在队列里，明知它过时了也收不回来。\n" +
      "**只能撤待确认的。** 已经生效（applied）的撤不掉——那不是撤回，是想改回去，" +
      "要改就重新提一条。撤不成功会告诉你原因，别当成已经撤掉了。\n" +
      "撤回前先 list_my_proposals 确认那条确实是 pending，别凭上一轮的印象撤。",
    en:
      "Withdraw a proposal that is **still pending confirmation**. propose_* can only create, never " +
      "withdraw; without this tool the assistant can only watch what it submitted sit in the queue, " +
      "unable to pull it back even when it knows it is out of date.\n" +
      "**Only pending proposals can be withdrawn.** One that has already taken effect (applied) " +
      "cannot — that is not a withdrawal, that is wanting to change it back, and the way to change " +
      "it back is to propose a new one. If the withdrawal fails you will be told why; do not treat it " +
      "as withdrawn.\n" +
      "Before withdrawing, call list_my_proposals and confirm the proposal really is pending, rather " +
      "than acting on an impression from an earlier turn.",
  },
  "withdraw_proposal.actionId": {
    "zh-CN": "要撤回的提案 id",
    en: "The id of the proposal to withdraw",
  },
  "withdraw_proposal.reason": {
    "zh-CN": "一句话说明为什么撤回",
    en: "One sentence saying why it is being withdrawn",
  },
  "list_my_proposals": {
    "zh-CN":
      "列出你（当前用户）提交过的配置变更提案，以及每一条现在是待确认、已生效还是被拒绝。\n" +
      "**你在界面上点过确认之后，用这个来核实**，不要靠猜：propose_* 只是把变更放进待确认队列，" +
      "你自己看不到队列状态，所以之前几次只能说「不知道有没有生效」。\n" +
      "确认后再用 list_providers 读回配置，两个一对比就知道改动到底落下没有。\n" +
      "**status 是 failed 时先读 result**：那是服务端执行时写下的原因" +
      "（媒体服务商会是校验器列出的完整问题清单）。有 result 就照它改，不要靠推断猜是哪一步错了。",
    en:
      "List the configuration-change proposals you (the current user) submitted, and whether each " +
      "one is now pending, applied or rejected.\n" +
      "**Use this to verify after the user has clicked confirm in the interface** — do not guess: " +
      "propose_* only puts the change in the pending queue and you cannot see the queue's state " +
      "yourself, which is why earlier attempts could only say \"I do not know whether it took " +
      "effect\".\n" +
      "After the confirmation, read the configuration back with list_providers; comparing the two " +
      "tells you whether the change actually landed.\n" +
      "**When status is failed, read result first**: that is the reason the server wrote when it ran " +
      "the action (for a media provider it is the validator's complete list of problems). If there " +
      "is a result, fix what it says instead of guessing which step went wrong.",
  },
  "list_my_proposals.status": {
    "zh-CN":
      "只看某一种状态：pending（待确认）/ applied（已生效）/ rejected（被拒绝）/ failed（应用失败）。" +
      "省略则全部返回。",
    en:
      "Show only one status: pending (awaiting confirmation) / applied (in effect) / rejected " +
      "(refused) / failed (the apply failed). Leave it out to return everything.",
  },
  "list_providers": {
    "zh-CN":
      "列出所有聊天服务商的配置（密钥永不返回）。" +
      "诊断「模型路由到哪个上游」「为什么某个模型不通」时先用它。",
    en:
      "List the configuration of every chat provider (keys are never returned). Use it first when " +
      "diagnosing \"which upstream does this model route to\" \"why does this model not work\".",
  },
  "probe_provider_host": {
    "zh-CN":
      "用某个服务商已存的密钥去探测候选 base URL 是否认证通过，返回上游真实模型列表。" +
      "MiniMax 这类分区域的厂商用它来确认密钥属于哪个区域 —— 不要靠猜，探测结果才是答案。" +
      "只读，不改任何配置。",
    en:
      "Probe a candidate base URL with a provider's stored key to see whether it authenticates, " +
      "and return the upstream's real model list. Region-split vendors such as MiniMax need it to " +
      "confirm which region the key belongs to — do not guess, the probe result is the answer. " +
      "Read-only; it changes no configuration.",
  },
  "probe_provider_host.providerId": {
    "zh-CN": "用哪个服务商已存的密钥",
    en: "Which provider's stored key to use",
  },
  "probe_provider_host.baseUrl": {
    "zh-CN": "要探测的 base URL，例如 https://api.minimaxi.com/v1",
    en: "The base URL to probe, for example https://api.minimaxi.com/v1",
  },
  "probe_provider_host.path": {
    "zh-CN": "模型列表路径，默认 /v1/models",
    en: "The model list path, default /v1/models",
  },
  "list_media_providers": {
    "zh-CN":
      "列出所有媒体服务商及其模型与 spec 摘要（图片/视频/语音）。默认不给 spec 正文，" +
      "要改某一份 spec 时加 full=true 单独取。",
    en:
      "List every media provider with its models and a summary of its specs (image/video/speech). " +
      "The spec bodies are not included by default; to change one, ask for it on its own with " +
      "full=true.",
  },
  "list_media_providers.full": {
    "zh-CN": "true 时返回每份 spec 的完整 JSON（体积很大，只在真的要改 spec 时用）。",
    en: "When true, return the complete JSON of every spec (very large — use it only when you really are going to change a spec).",
  },
  "get_media_spec_reference": {
    "zh-CN":
      "读媒体适配协议的原文，或者当前内置的 spec 模板。\n" +
      "写 spec 之前先读它 —— spec 的字段名和映射语法以这份原文为准，不要凭印象写。\n" +
      "what=\"protocol\"：协议全文（很长，用 offset/limit 分段读，读到 nextOffset 就接着读下一段）。\n" +
      "what=\"templates\"：本部署内置的模板，一字不差的可套用副本。" +
      "list_media_providers 报 templateDrift 时用它取回完整模板值。\n" +
      "注意：模板不等于正确。已存的 spec 可能带着模板里没有的、故意的本地修正（ASR 的文件路径就是这样），" +
      "整份套用会把那些修正冲掉 —— 只按 templateDrift 列出的路径逐条改。",
    en:
      "Read the media adapter protocol itself, or the spec templates built into this deployment.\n" +
      "Read it before writing a spec — the field names and the mapping syntax are defined by this " +
      "text, not by your recollection.\n" +
      "what=\"protocol\": the full protocol (very long; read it in windows with offset/limit, and " +
      "when you reach nextOffset read the next window).\n" +
      "what=\"templates\": the templates built into this deployment, exact copies you can paste. Use " +
      "this to recover the full template value when list_media_providers reports templateDrift.\n" +
      "Note: a template is not the same as correct. A stored spec may carry deliberate local " +
      "corrections that the template does not have (the ASR file path is one of them), and pasting the " +
      "template over it wipes those corrections out — change only the paths templateDrift lists, one " +
      "by one.",
  },
  "get_media_spec_reference.what": {
    "zh-CN": "protocol = 协议原文；templates = 内置模板",
    en: "protocol = the protocol text; templates = the built-in templates",
  },
  "get_media_spec_reference.capability": {
    "zh-CN": "只取这个能力的模板，例如 audio.tts、image.generate、audio.stt。留空返回全部。",
    en: "Only the templates for this capability, for example audio.tts, image.generate, audio.stt. Leave it empty to get them all.",
  },
  "get_media_spec_reference.offset": {
    "zh-CN": "what=\"protocol\" 时的起始字符位置，从 0 开始。",
    en: "The starting character position when what=\"protocol\", counting from 0.",
  },
  "get_media_spec_reference.limit": {
    "zh-CN": "what=\"protocol\" 时这一次返回多少字符。",
    en: "How many characters this call returns when what=\"protocol\".",
  },
  "propose_provider_update": {
    "zh-CN":
      "提出一次聊天服务商配置变更。这不会立刻生效 —— 它生成一份 before/after 对比，" +
      "等管理员在界面上确认后才执行。可改：API 地址、上游格式（responses/chat）、请求头、优先级、" +
      "模型映射、两个协议面、启用开关、每个兼容接口的参数规则（textSpecs）。" +
      "只能改已存在的服务商，不能新建。",
    en:
      "Propose a change to a chat provider's configuration. It does not take effect immediately — " +
      "it produces a before/after comparison that runs once an administrator confirms it in the " +
      "interface. It can change: the API address, the upstream format (responses/chat), request " +
      "headers, priority, the model mapping, the two protocol surfaces, the enabled switch, and the " +
      "parameter rules for each compatible interface (textSpecs). It can only change a provider that " +
      "already exists; it cannot create one.",
  },
  "propose_provider_update.providerId": {
    "zh-CN": "要修改的服务商 id",
    en: "The id of the provider to change",
  },
  "propose_provider_update.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_provider_update.priority": {
    "zh-CN": "数值越小越优先被选中；并列时取第一个匹配的",
    en: "The smaller the number, the higher the priority; on a tie the first match wins",
  },
  "propose_provider_update.activeMode": {
    "zh-CN":
      "规则读哪一套：advanced 生效，simple 完全不执行。**配了 textSpecs 却留在这里没有切换，" +
      "等于规则一条都没跑** —— 界面上看得到，行为上不存在。" +
      "不确定就先查 list_providers：它会告诉你这个服务商现在存的是什么、" +
      "有几条规则、引擎实际读哪一套。",
    en:
      "Which set of rules the engine reads: advanced applies them, simple does not run them at all. " +
      "**Configuring textSpecs while leaving this at simple means not one rule ran** — visible in the " +
      "interface, absent in behaviour. Check list_providers if you are unsure: it tells you what " +
      "this provider stores, how many rules it has, and which set the engine actually reads.",
  },
  "propose_provider_update.modelMapping": {
    "zh-CN":
      "客户端模型名 → 上游模型名 的【完整】替换表。注意：整份替换，不是增量。" +
      "想只加一个映射就必须先用 list_providers 拿到现状、合并、再把整张表传回来 —— " +
      "只传新增的那一条会把其余所有模型删掉。\n" +
      "表里新增的模型会按「免费」创建（这个工具不设置价格），所以会撞上 free-model 闸门；" +
      "已经在表里的模型价格原样保留，不会被这次改动清零。",
    en:
      "The **complete** replacement table of client model name → upstream model name. Note: the " +
      "whole table is replaced, not merged. To add a single mapping you must first read the current " +
      "table with list_providers, merge, and send the whole thing back — sending only the new entry " +
      "deletes every other model.\n" +
      "Models that are new to the table are created as \"free\" (this tool does not set prices), so " +
      "they will hit the free-model gate; models already in the table keep their prices, which this " +
      "change does not zero out.",
  },
  "propose_provider_update.textSpecs": {
    "zh-CN":
      "上游协议文档列表，【按 protocol 合并】：同名的替换、没提到的保留、" +
      "传 null 清空全部。所以给某一个接口加规则不用重发另外两个。\n" +
      "不确定该选哪个 protocol，先调 list_text_protocols，不要凭印象写。\n" +
      "只有厂商确实和 OpenAI 兼容接口不一样时才需要写；'大多数厂商什么都不用配'。\n" +
      "protocol 只能取那三个接口之一，而且对应协议面必须是开的，否则规则不会生效。",
    en:
      "The list of upstream protocol documents, **merged by protocol**: same name replaces, " +
      "anything you do not mention is kept, and passing null clears them all. So adding a rule for " +
      "one interface does not mean resending the other two.\n" +
      "If you are not sure which protocol to use, call list_text_protocols first rather than writing " +
      "one from memory.\n" +
      "Only write them when the vendor really does differ from the OpenAI-compatible interface; " +
      "'most vendors need nothing configured'.\n" +
      "protocol can only be one of those three interfaces, and the matching protocol surface must " +
      "be on, otherwise the rules will not apply.",
  },
  "propose_provider_update.headers": {
    "zh-CN":
      "附在上游请求上的固定请求头，整份替换，传 null 清空。" +
      "例如 {\"api-version\": \"2024-08-01-preview\"}。只有 Azure 一类要求固定头的厂商才需要。",
    en:
      "Fixed headers attached to every upstream request; the whole set is replaced, and passing null " +
      "clears them. For example {\"api-version\": \"2024-08-01-preview\"}. Only vendors like Azure " +
      "that insist on a fixed header need this.",
  },
  "propose_provider_update.upstreamFormat": {
    "zh-CN":
      "OpenAI 侧上游说的是哪种协议：responses（原生，/v1/responses 原样透传）或 chat。" +
      "注意 chat→responses 没有请求转换：客户端调 /v1/chat/completions 时永远发往 " +
      "<API 地址>/chat/completions。",
    en:
      "Which protocol the upstream speaks on the OpenAI side: responses (native, /v1/responses " +
      "passed through untouched) or chat. Note that there is no chat→responses request conversion: " +
      "a client calling /v1/chat/completions always goes to <API address>/chat/completions.",
  },
  "propose_provider_update.confirmFindings": {
    "zh-CN":
      'free-model 闸门的确认清单，逐条模型写「code:模型名」，例如 all_zero:agnes-3.0-flash。' +
      "**不要原样重发一遍**，再说一次得到的是同一个拒绝。\n" +
      "只有当 modelMapping 里新增的模型确实免费（厂商文档或官方定价页明写）时才需要写。" +
      "已经在表里的模型这次不会被重新定价，所以不需要在这里声明它们的零价。",
    en:
      "The free-model gate's confirmation list, one model per entry in the form " +
      "\"code:model-name\", for example all_zero:agnes-3.0-flash. **Do not send the same thing " +
      "again** — saying it a second time gets the same refusal.\n" +
      "Only write it when a model newly added in modelMapping really is free (the vendor's " +
      "documentation or official pricing page says so). Models already in the table are not " +
      "repriced by this change, so their zero prices do not need to be declared here.",
  },
  "list_text_protocols": {
    "zh-CN":
      "列出可配置的文本协议预设和参数策略的六种模式，配使用建议。\n" +
      "配置服务商前如果不确定该选哪个协议、或者不知道某个参数该 passthrough 还是 clamp，先调这个 —— " +
      "不要凭印象写 protocol。\n" +
      "绝大多数 OpenAI 兼容中转选 openai-chat 就够了，什么都不用改。\n" +
      "**规则的确切语义**（模式、裁决顺序、协议字段）在协议原文里，" +
      "用 get_text_spec_reference(what=\"protocol\") 读。",
    en:
      "List the configurable text protocol presets and the six parameter-handling modes, with " +
      "advice on when to use each.\n" +
      "Before configuring a provider, call this if you are not sure which protocol to pick, or " +
      "whether a parameter should be passthrough or clamp — do not write a protocol from memory.\n" +
      "For almost every OpenAI-compatible relay, openai-chat is enough and nothing needs changing.\n" +
      "**The exact semantics of the rules** (modes, precedence, protocol fields) are in the " +
      "protocol text; read it with get_text_spec_reference(what=\"protocol\").",
  },
  "get_text_spec_reference": {
    "zh-CN":
      "读文本（普通服务商）适配协议的原文，或者当前内置的协议预设。\n" +
      "写 textSpecs 之前先读它 —— 字段名、参数模式的语义、裁决顺序以这份原文为准，不要凭印象写。\n" +
      "what=\"protocol\"：协议全文（很长，用 offset/limit 分段读，读到 nextOffset 就接着读下一段）。\n" +
      "what=\"presets\"：内置预设，一字不差的可套用副本；" +
      "preset 字段就是可以直接放进 propose_provider_update 的 textSpecs 数组里的那个对象。\n" +
      "该选哪个协议、用哪种模式，先调 list_text_protocols —— 那是建议；这里是原文和可套用的值。",
    en:
      "Read the text (ordinary provider) adapter protocol itself, or the protocol presets built in " +
      "today.\n" +
      "Read it before writing textSpecs — the field names, the meaning of each parameter mode and " +
      "the precedence order are defined by this text, not by your recollection.\n" +
      "what=\"protocol\": the full protocol (very long; read it in windows with offset/limit, and " +
      "when you reach nextOffset read the next window).\n" +
      "what=\"presets\": the built-in presets, exact copies you can paste; the preset field is the " +
      "object you can drop straight into the textSpecs array of propose_provider_update.\n" +
      "To see which protocol to use and which mode, call list_text_protocols first — that is the " +
      "advice; this is the source text and the values you can paste.",
  },
  "get_text_spec_reference.what": {
    "zh-CN": "protocol = 协议原文；presets = 内置预设",
    en: "protocol = the protocol text; presets = the built-in presets",
  },
  "get_text_spec_reference.protocol": {
    "zh-CN": "只取这个协议的预设，例如 openai-chat、anthropic-messages。留空返回全部可配置的协议。",
    en: "Only the presets for this protocol, for example openai-chat, anthropic-messages. Leave it empty to get every configurable protocol.",
  },
  "get_text_spec_reference.offset": {
    "zh-CN": "what=\"protocol\" 时的起始字符位置，从 0 开始。",
    en: "The starting character position when what=\"protocol\", counting from 0.",
  },
  "get_text_spec_reference.limit": {
    "zh-CN": "what=\"protocol\" 时这一次返回多少字符。",
    en: "How many characters this call returns when what=\"protocol\".",
  },
  "propose_model_config_update": {
    "zh-CN":
      "提出一次【单个模型】的配置变更，需要管理员确认才执行。\n" +
      "改的是网关真实生效的东西：上下文长度、最大输出、思考等级、积分价格、是否启用、显示名、" +
      "上游模型名。\n" +
      "思考等级是**本部署声明**的，不是自动检测出来的：查厂商官方文档确认这个模型接受哪几档，" +
      "再照原样写进 reasoningLevels；厂商文档里没有就留空数组。\n" +
      "文档里显示的上下文和价格读的就是这些值，所以改这里等于同时改文档。\n" +
      "媒体模型（图片/视频/语音）由 spec 驱动，这里改不了，请用 propose_media_provider_update。\n\n" +
      "**被拦下来的时候**：先判断是值真的错了、还是这条检查误伤了一个已经就对的配置。值错了就改值；" +
      "确实如此（比如厂商的定价页确写它免费）就在 confirmFindings 里写上「code:模型名」。" +
      "**不要原样重发一遍**，同样的内容会得到同样的拒绝。",
    en:
      "Propose a change to **a single model**, which runs only after an administrator confirms it.\n" +
      "What it changes is what the gateway actually applies: context length, maximum output, " +
      "thinking tiers, credit prices, whether it is enabled, the display name and the upstream " +
      "model name.\n" +
      "The thinking tiers are **declared by this deployment**, not detected automatically: check the " +
      "vendor's official documentation for which tiers the model accepts and write them into " +
      "reasoningLevels exactly as documented; if the documentation does not mention them, leave an " +
      "empty array.\n" +
      "The context and prices shown in the documentation read from these same values, so changing " +
      "them here changes the documentation too.\n" +
      "Media models (image/video/speech) are driven by their spec and cannot be changed here; use " +
      "propose_media_provider_update for those.\n\n" +
      "**When it is refused**: first work out whether the value really is wrong or whether the check " +
      "has caught a configuration that was already correct. If the value is wrong, fix the value; if " +
      "it really is that way (the vendor's pricing page says the model is free), write " +
      "\"code:model-name\" in confirmFindings. **Do not send the same thing again** — identical " +
      "content gets the identical refusal.",
  },
  "propose_model_config_update.providerId": {
    "zh-CN": "该模型所属的服务商 id，用 list_providers 查",
    en: "The id of the provider this model belongs to; look it up with list_providers",
  },
  "propose_model_config_update.clientId": {
    "zh-CN": "客户端在 model 字段里填的模型名",
    en: "The model name the client puts in the model field",
  },
  "propose_model_config_update.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_model_config_update.purpose": {
    "zh-CN":
      "这个模型是做什么用的：chat（对话）、embedding（向量）、rerank（重排）、moderation（审核）。\n" +
      "决定它在管理员给账号授权时归到哪一组 —— 设就是对话模型。",
    en:
      "What this model is for: chat (conversation), embedding (vectors), rerank (reranking), " +
      "moderation (moderation).\n" +
      "It decides which group the model falls into when an administrator grants an account access " +
      "— setting it makes the model a chat model.",
  },
  "propose_model_config_update.contextLength": {
    "zh-CN": "上下文长度（输入 token 上限）",
    en: "Context length (the input token limit)",
  },
  "propose_model_config_update.reasoningLevels": {
    "zh-CN":
      "这个模型接受的思考等级，照厂商文档的原样写，不要翻译也不要归一化。" +
      "例：MiniMax-M3.1-Flash-Preview 接受 low, medium, high, xhigh, max。空数组 = 这个模型不支持思考等级。" +
      "先查官方文档确认再写，不确定就别写。\n" +
      "注意：这个字段是**界面上给用户选的档位**，不是「能不能关思考」。" +
      "同一个模型可能档位写了五档、却一个都关不掉（发 disabled 直接 400），" +
      "也可能档位根本不调深度、真正的开关在另一个字段上。分不清就照文档写档位，别把开关混进来。",
    en:
      "The thinking tiers this model accepts, written exactly as the vendor's documentation has " +
      "them — do not translate them and do not normalise them. For example: " +
      "MiniMax-M3.1-Flash-Preview accepts low, medium, high, xhigh, max. An empty array means this " +
      "model does not support thinking tiers. Check the official documentation first, and write " +
      "nothing if you are not sure.\n" +
      "Note: this field is **the tiers the interface offers the user**, not \"whether thinking can " +
      "be turned off\". One model may list five tiers and still refuse every one of them (sending " +
      "disabled returns 400), or its tiers may not change the depth at all, with the real switch on " +
      "another field. If you cannot tell, write the tiers the documentation gives and do not mix " +
      "the switch in.",
  },
  "propose_model_config_update.reasoningEffortSupported": {
    "zh-CN":
      "这个模型是否支持 reasoning_effort 思考等级。\n" +
      "**厂商文档明确写了它不读这个参数，就填 false**（例：MiniMax-M3 只有 thinking 开关，" +
      "reasoning_effort 会被直接忽略）。填 false 之后，助手设置里对应的下拉会置灰——" +
      "因为那是一个选了、存了、发出去了、但完全不生效的控件。\n" +
      "不确定就**不要传**：没声明过和声明过「不支持」是两回事，只有传了才会置灰。",
    en:
      "Whether this model supports the reasoning_effort thinking tier.\n" +
      "**If the vendor's documentation says plainly that it ignores this parameter, set false** " +
      "(for example: MiniMax-M3 has only the thinking switch and reasoning_effort is ignored " +
      "outright). After setting false, the matching dropdown in the assistant settings is greyed " +
      "out — because it is a control that can be selected, stored and sent while doing nothing at " +
      "all.\n" +
      "If you are not sure, **do not send it**: never having declared it and declaring it " +
      "\"unsupported\" are two different things, and only sending it greys the control out.",
  },
  "propose_model_config_update.thinkingSwitchSupported": {
    "zh-CN":
      "这个模型是否接受 thinking 开关（关掉思考）。\n" +
      "**厂商会拒绝关闭请求时填 false**：M2.x 系列收下 disabled 却照样思考，" +
      "M3.1-Flash-Preview 直接返回 400。只有 MiniMax-M3 认这个开关。\n" +
      "填 false 之后助手设置里的「思考开关」会置灰。不确定就不要传。",
    en:
      "Whether this model accepts the thinking switch (turning thinking off).\n" +
      "**Set false when the vendor refuses to turn thinking off**: the M2.x series accepts disabled " +
      "and thinks anyway, and M3.1-Flash-Preview returns 400 outright. Only MiniMax-M3 honours this " +
      "switch.\n" +
      "After setting false the \"thinking switch\" in the assistant settings is greyed out. If you " +
      "are not sure, do not send it.",
  },
  "propose_model_config_update.inputCost": {
    "zh-CN": "每 100 万输入 token 的积分",
    en: "Credits per 1M input tokens",
  },
  "propose_model_config_update.outputCost": {
    "zh-CN": "每 100 万输出 token 的积分",
    en: "Credits per 1M output tokens",
  },
  "propose_model_config_update.cachedInputCost": {
    "zh-CN":
      "每 100 万「命中上游提示缓存」的输入 token 的积分。不填 = 按 inputCost 算" +
      "（安全默认，老模型不受影响）；填 0 = 缓存命中免费。读和写分开，因为厂商一个免费、一个加价。",
    en:
      "Credits per 1M input tokens that hit the upstream prompt cache. Leaving it out charges by " +
      "inputCost (the safe default, which does not affect older models); setting 0 makes cache hits " +
      "free. Read and write are separate because one vendor charges for one of them and not the " +
      "other.",
  },
  "propose_model_config_update.cacheWriteCost": {
    "zh-CN": "每 100 万「写入」上游提示缓存的输入 token 的积分。不填 = 按 inputCost 算。",
    en: "Credits per 1M input tokens written to the upstream prompt cache. Leaving it out charges by inputCost.",
  },
  "propose_model_config_update.enabled": {
    "zh-CN": "false = 网关不再路由到这个模型，客户端会 404",
    en: "false = the gateway stops routing to this model and clients get a 404",
  },
  "propose_model_config_update.confirmFindings": {
    "zh-CN":
      "你确认过、因而不再拦下来的检查项，格式「code:模型名」，例如 " +
      "\"all_zero:agnes-2.5-flash\"。**只在厂商文档或官方定价页确写它免费时才用。**\n" +
      "只有真正会被这次改动碰到的字段才会被拦；模型本来就是 0 价、而你只是在改上下文长度，" +
      "那样根本不会被拦，也不需要在这里声明。",
    en:
      "The checks you have confirmed and are therefore no longer blocked on, in the form " +
      "\"code:model-name\", for example \"all_zero:agnes-2.5-flash\". **Use it only when the " +
      "vendor's documentation or official pricing page says the model is free.**\n" +
      "Only the fields this change actually touches are blocked. A model that was already priced at " +
      "0 and that you are merely changing the context length for is not blocked at all, and needs " +
      "no mention here.",
  },
  "propose_doc_pages": {
    "zh-CN":
      "提出一次【参数指南页面】的变更，需要管理员确认才执行。\n" +
      "这些页面构成读者文档里的「参数指南」——和「接入指南」是并列的两本，" +
      "接入指南讲怎么接上，参数指南讲每个参数有哪些值。\n" +
      "适合写音色列表、尺寸与取值范围、字段含义这类要反复回来查的东西；" +
      "限流和使用约定不属于这里。\n" +
      "**写的是本部署映射之后的接口，不是上游厂商的原生接口。** 厂商文档用来确认上游的字段名和取值，\n" +
      "接口路径、我们转发和不转发什么、哪些转换是我们做的——这些必须来自 read_docs 和 list_providers。\n" +
      "把厂商原生接口照抄进来，用户照着调就会踩坑。\n" +
      "每页正文很长（一张音色表就三百多行），所以一页只写一类，别把整本塞进一页。\n" +
      "pages 是【完整】替换，不是增量：只发新加的那一页会把其余所有页面删掉。" +
      "想加一页必须先用 list_doc_pages 拿回现状、合并、再整份传回。\n" +
      "id 会变成读者能收藏的锚点，一旦发布就不要改；id 只能是小写字母、数字和中划线。",
    en:
      "Propose a change to a **parameter guide page**, which runs only after an administrator " +
      "confirms it.\n" +
      "These pages make up the reader documentation's \"parameter guide\" — a sibling of the " +
      "\"integration guide\": the integration guide explains how to connect, the parameter guide " +
      "lists which values each parameter takes.\n" +
      "They are the right home for things people come back to repeatedly — voice lists, sizes and " +
      "their ranges, what a field means. Rate limits and usage conventions do not belong here.\n" +
      "**You are writing about this deployment's mapped interface, not the vendor's native one.** " +
      "The vendor's documentation tells you the upstream's field names and values; the endpoint " +
      "paths, what this gateway forwards and what it does not, and which conversions it performs — " +
      "those have to come from read_docs and list_providers.\n" +
      "Copying the vendor's native API in verbatim leaves users tripping over it.\n" +
      "Each page's body is long (a single voice table runs to three hundred lines), so write one " +
      "kind of thing per page rather than the whole book into one.\n" +
      "pages is a **complete** replacement, not an increment: sending only the new page deletes " +
      "every other one. To add a page you must first read the current list with list_doc_pages, " +
      "merge, and send the whole thing back.\n" +
      "The id becomes an anchor readers can bookmark, so do not change it once published; it may " +
      "only contain lowercase letters, digits and hyphens.",
  },
  "propose_doc_pages.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_doc_pages.pages": {
    "zh-CN": "完整的页面列表。顺序就是读者看到的顺序。",
    en: "The complete list of pages. The order is the order the reader sees.",
  },
  "propose_doc_pages.pages.id": {
    "zh-CN": "URL 锚点，小写字母/数字/中划线，发布后不要改",
    en: "The URL anchor: lowercase letters, digits and hyphens; do not change it after publishing",
  },
  "propose_doc_pages.pages.body": {
    "zh-CN": "Markdown 正文",
    en: "The body, in Markdown",
  },
  "propose_doc_pages.pages.hidden": {
    "zh-CN": "true = 草稿，读者看不到",
    en: "true = a draft, which readers cannot see",
  },
  "list_doc_pages": {
    "zh-CN":
      "读回当前【参数指南】的页面。改之前必须先调这个 —— propose_doc_pages 是整份替换，" +
      "不知道现状就改会把页面全删掉。",
    en:
      "Read back the current **parameter guide** pages. You must call this before changing " +
      "anything — propose_doc_pages is a complete replacement, and changing it without knowing the " +
      "current state deletes every page.",
  },
  "propose_media_provider_update": {
    "zh-CN":
      "提出一次媒体服务商配置变更，同样需要管理员确认才执行。只能改已存在的媒体服务商，不能新建。\n" +
      "改已有 spec 的字段请用 specEdits（按下标指明、只写要改的字段），" +
      "不要把整个 specs 数组重发一遍 —— 数组有十几 KB，重发极易在传输中损坏。\n" +
      "只有新增或删除整个能力 spec 时才用 specs。",
    en:
      "Propose a change to a media provider's configuration, which likewise runs only after an " +
      "administrator confirms it. It can only change a media provider that already exists; it " +
      "cannot create one.\n" +
      "To change the fields of an existing spec use specEdits (name the index and write only the " +
      "fields you are changing); do not resend the whole specs array — it is over ten KB and " +
      "resending it is easily corrupted in transit.\n" +
      "Use specs only when adding or removing a whole capability spec.",
  },
  "propose_media_provider_update.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_media_provider_update.models": {
    "zh-CN":
      "模型表的【完整】替换。整份替换，不是增量：想加一个模型必须先 list_media_providers " +
      "取回现状、合并、再整份传回，否则其余模型会被删掉。",
    en:
      "The **complete** replacement of the model table. The whole table is replaced, not merged: to " +
      "add a model you must first read the current one with list_media_providers, merge, and send " +
      "the whole thing back, or the other models will be deleted.",
  },
  "propose_media_provider_update.specEdits": {
    "zh-CN":
      "推荐用法：按下标修改已有 spec 的字段。只写要改的字段，其余原样保留。" +
      "下标从 list_media_providers 返回的 specs 数组顺序数起（从 0 开始）。" +
      "这样你不需要重发整个 spec，也就不会把它写坏。\n" +
      "除下面列出的几个字段外，spec 上的**任何**顶层字段都可以作为键写进来 —— " +
      "transport、request、response、voices、errors、limits、metadata 等都算，" +
      "值就是完整的 JSON 对象。合并是逐条浅合并：你在某个键上写的值会整个替换那个键，" +
      "所以要改嵌套结构里的一处，就得把那个键的完整新值写出来（模板用 get_media_spec_reference 取）。",
    en:
      "The recommended way: change the fields of an existing spec by index. Write only the fields " +
      "you are changing and the rest are kept as they are. The index counts from 0 through the " +
      "specs array returned by list_media_providers. That way you do not have to resend the whole " +
      "spec, and so you cannot write it broken.\n" +
      "Besides the fields listed below, **any** top-level field of a spec can be used as a key — " +
      "transport, request, response, voices, errors, limits, metadata and so on — and the value is " +
      "the complete JSON object. The merge is a shallow merge per key: the value you write for a " +
      "key replaces that key entirely, so to change one part of a nested structure you have to " +
      "write the complete new value for that key (take the template from get_media_spec_reference).",
  },
  "propose_media_provider_update.specEdits.index": {
    "zh-CN": "要修改的 spec 在现有列表中的下标，从 0 开始",
    en: "The index of the spec to change in the existing list, counting from 0",
  },
  "propose_media_provider_update.specs": {
    "zh-CN":
      "【完整】替换整个 specs 数组。只在新增或删除整个能力 spec 时用；改字段请用 specEdits。" +
      "重发整个数组有十几 KB，在传输中损坏过（模型会写出 _request 这种不存在的字段），" +
      "而损坏的 JSON 解析出来是空对象，管理员只会看到一个没有理由的失败。",
    en:
      "A **complete** replacement of the whole specs array. Use it only when adding or removing a " +
      "whole capability spec; to change fields use specEdits. Resending the whole array is over ten " +
      "KB and has been corrupted in transit before (the model writes fields that do not exist, like " +
      "_request), and a corrupted JSON parses into an empty object, which leaves the administrator " +
      "with a failure and no reason for it.",
  },
  "propose_provider_create": {
    "zh-CN":
      "提出一次「新建聊天服务商」的变更，管理员在界面上确认并补填 API 密钥后才会真正创建。" +
      "这个工具不接收密钥，也不该向用户索取 —— 密钥由管理员在确认时自己填，" +
      "所以你提议的内容里绝不能包含任何密钥。同样需要管理员点确认。" +
      "**这个工具不能设置价格**：新建的每个模型都会以 0/0 写入，所以会被 free-model 闸门拦下。" +
      "如果这些模型其实收费，请在闸门提示里用 confirmFindings 逐条确认「确认就是免费」之前，" +
      "先问用户定价是多少 —— 定价要由管理员在确认界面上补，不要在这里编一个数字。",
    en:
      "Propose a \"create a new chat provider\" change; the provider is only really created once an " +
      "administrator confirms it in the interface and fills in the API key. This tool does not " +
      "accept a key and must not ask the user for one — the administrator fills it in at " +
      "confirmation time, so your proposal must never contain a key of any kind. It needs an " +
      "administrator confirmation like every other proposal. **This tool cannot set prices**: every " +
      "new model is written at 0/0, so the free-model gate will stop it.\n" +
      "If those models really do cost money, ask the user what the pricing is *before* using " +
      "confirmFindings to confirm \"confirmed, it is free\" at the gate prompt — the pricing is the " +
      "administrator's to fill in on the confirmation screen; do not make a number up here.",
  },
  "propose_provider_create.name": {
    "zh-CN": "服务商的显示名称",
    en: "The provider's display name",
  },
  "propose_provider_create.kind": {
    "zh-CN": "上游协议，默认 openai",
    en: "The upstream protocol, default openai",
  },
  "propose_provider_create.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_provider_create.baseUrl": {
    "zh-CN": "上游 base URL，例如 https://api.minimaxi.com/v1",
    en: "The upstream base URL, for example https://api.minimaxi.com/v1",
  },
  "propose_provider_create.upstreamFormat": {
    "zh-CN":
      "上游接口风格，默认 responses。anthropic 或 gemini 表示上游只说那种协议，" +
      "OpenAI 侧由网关转换。",
    en:
      "The upstream's interface style, default responses. anthropic or gemini means the upstream " +
      "only speaks that protocol and the gateway translates on the OpenAI side.",
  },
  "propose_provider_create.priority": {
    "zh-CN": "数值越小越优先",
    en: "The smaller the number, the higher the priority",
  },
  "propose_provider_create.modelMapping": {
    "zh-CN": "客户端模型名 → 上游模型名。新建时这张表就是全部，所以传完整的一份。",
    en: "Client model name → upstream model name. On creation this table is the whole thing, so send it complete.",
  },
  "propose_provider_create.openaiEnabled": {
    "zh-CN":
      "OpenAI 协议面。上游说 chat/responses 时是直连；上游说 anthropic/gemini 时表示由网关转换来服务。",
    en:
      "The OpenAI protocol surface. When the upstream speaks chat/responses this is a direct " +
      "connection; when it speaks anthropic/gemini it means the gateway translates to serve it.",
  },
  "propose_provider_create.anthropicEnabled": {
    "zh-CN": "Anthropic 协议面，上游说 /v1/messages 时开",
    en: "The Anthropic protocol surface; turn it on when the upstream speaks /v1/messages",
  },
  "propose_provider_create.anthropicMode": {
    "zh-CN":
      "Anthropic 协议面怎么服务：native = 厂商自己的 /v1/messages；translated = 厂商不说 Anthropic，" +
      "由网关转换。只说 OpenAI 兼容协议的厂商要用 translated，Anthropic 客户端才调得动它。",
    en:
      "How the Anthropic protocol surface is served: native = the vendor's own /v1/messages; " +
      "translated = the vendor does not speak Anthropic and the gateway translates. A vendor that " +
      "only speaks an OpenAI-compatible protocol needs translated, or Anthropic clients cannot " +
      "reach it.",
  },
  "propose_provider_create.anthropicBaseUrl": {
    "zh-CN": "Anthropic 面的 base URL。留空会根据 baseUrl 推导；上游两套形状不同域时才填。",
    en: "The base URL for the Anthropic surface. Leave it empty to derive it from baseUrl; fill it in only when the upstream's two shapes live on different domains.",
  },
  "propose_provider_create.headers": {
    "zh-CN": "附在上游请求上的固定请求头，例如 {\"api-version\": \"2024-08-01-preview\"}。",
    en: "Fixed headers attached to upstream requests, for example {\"api-version\": \"2024-08-01-preview\"}.",
  },
  "propose_provider_create.textSpecs": {
    "zh-CN":
      "每个兼容接口的参数规则，建库时一并写入。只有厂商和 OpenAI 兼容接口确实不同时才需要。" +
      "新建时留空 activeMode 会按「有规则就用」推断，规则会生效；" +
      "只有显式传 simple 才会让规则不执行。",
    en:
      "The parameter rules for each compatible interface, written into the row on creation. Only " +
      "needed when the vendor really does differ from the OpenAI-compatible interface.\n" +
      "Leaving activeMode empty on creation infers \"use them if there are any\" and the rules take " +
      "effect; only an explicit simple stops them running.",
  },
  "propose_provider_create.activeMode": {
    "zh-CN":
      "规则读哪一套：advanced 执行 textSpecs，simple 完全不执行。" +
      "新建时一般不用传 —— 留空会按有没有规则推断。" +
      "只有在明确要求「先存规则、暂不启用」时才传 simple。" +
      "没有规则时传 advanced 没有意义，会被拒绝。",
    en:
      "Which set of rules the engine reads: advanced runs textSpecs, simple does not run them at " +
      "all. You rarely need to send this on creation — leaving it empty infers from whether there " +
      "are rules. Send simple only when the point is explicitly \"store the rules but do not enable " +
      "them yet\". Sending advanced when there are no rules is meaningless and is refused.",
  },
  "propose_provider_create.confirmFindings": {
    "zh-CN":
      "free-model 闸门的确认清单，逐条模型写「code:模型名」，例如 all_zero:MiniMax-M2。" +
      "只有当用户明确说过这个模型确实免费时才写。不要原样重发一遍 —— 再说一次得到的是同一个拒绝。",
    en:
      "The free-model gate's confirmation list, one model per entry in the form " +
      "\"code:model-name\", for example all_zero:MiniMax-M2. Only write it when the user has said " +
      "plainly that this model really is free. Do not send the same thing again — saying it a second " +
      "time gets the same refusal.",
  },
  "propose_media_provider_create": {
    "zh-CN":
      "提出一次「新建媒体服务商」的变更，同样需要管理员确认并补填 API 密钥。" +
      "models 和 specs 是新建时的完整内容，传完整的一份。不要向用户索取密钥。",
    en:
      "Propose a \"create a new media provider\" change; it likewise needs an administrator " +
      "confirmation and an API key filled in. models and specs are the complete contents at " +
      "creation time, so send them complete. Do not ask the user for a key.",
  },
  "propose_media_provider_create.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_media_provider_create.models": {
    "zh-CN": "模型表，【完整】的一份。每个值至少要有 upstreamId。",
    en: "The model table, **complete**. Every value needs at least an upstreamId.",
  },
  "propose_media_provider_create.specs": {
    "zh-CN":
      "能力 spec 数组。【完整】的一份，并且必须与 list_media_providers 返回的形状逐字一致 —— " +
      "那才是校验器接受的形状。正确做法：先 list_media_providers 取回现有的 spec，整份复制，" +
      "再只改要改的字段。",
    en:
      "The array of capability specs, **complete**, and it must match the shape list_media_providers " +
      "returns exactly — that is the shape the validator accepts. The right way: read the existing " +
      "specs with list_media_providers, copy them whole, and change only the fields you are changing.",
  },
  "list_search_providers": {
    "zh-CN":
      "列出所有搜索提供商（网页搜索的后端），包括它们当前实际请求的地址、用的协议（spec）、" +
      "以及与内置模板的差异。\n" +
      "**地址那一行是最终生效的地址** —— 旧记录的地址按旧规则解释，新记录按协议解释，别自己推断。\n" +
      "改某一份 spec 前用 full=true 取回完整 JSON。",
    en:
      "List every search provider (the backend behind web search), including the address it is " +
      "actually requesting right now, the protocol it uses (its spec), and how it differs from the " +
      "built-in template.\n" +
      "**The address line is the address that takes effect** — an older row's address is read by the " +
      "old rules, a newer one by the protocol, so do not work it out yourself.\n" +
      "Use full=true to get the complete JSON before changing a spec.",
  },
  "list_search_providers.full": {
    "zh-CN": "true 时返回每条记录完整的 spec JSON（只在真的要改 spec 时用）。",
    en: "When true, return the complete spec JSON of every record (only when you really are going to change a spec).",
  },
  "get_search_spec_reference": {
    "zh-CN":
      "读搜索适配协议的原文，或者当前内置的协议模板。\n" +
      "写 spec 之前先读它 —— 字段名和语法以这份原文为准，不要凭印象写。\n" +
      "what=\"protocol\"：协议全文（用 offset/limit 分段读，读到 nextOffset 就接着读下一段）。\n" +
      "what=\"templates\"：本部署内置的模板，一字不差的可套用副本。\n" +
      "语法和媒体适配协议是同一套：值写成 \"$.query\" 是取作用域里的值，写成 \"{{…}}\" 是模板，" +
      "其余是字面量。",
    en:
      "Read the search adapter protocol itself, or the protocol templates built into this " +
      "deployment.\n" +
      "Read it before writing a spec — the field names and the syntax are defined by this text, " +
      "not by your recollection.\n" +
      "what=\"protocol\": the full protocol (read it in windows with offset/limit, and when you reach " +
      "nextOffset read the next window).\n" +
      "what=\"templates\": the templates built into this deployment, exact copies you can paste.\n" +
      "The syntax is the same as the media adapter protocol's: a value written as \"$.query\" takes " +
      "a value from the scope, one written as \"{{…}}\" is a template, and everything else is a literal.",
  },
  "get_search_spec_reference.what": {
    "zh-CN": "protocol = 协议原文；templates = 内置模板",
    en: "protocol = the protocol text; templates = the built-in templates",
  },
  "get_search_spec_reference.offset": {
    "zh-CN": "what=\"protocol\" 时的起始字符位置，从 0 开始。",
    en: "The starting character position when what=\"protocol\", counting from 0.",
  },
  "get_search_spec_reference.limit": {
    "zh-CN": "what=\"protocol\" 时这一次返回多少字符。",
    en: "How many characters this call returns when what=\"protocol\".",
  },
  "propose_search_provider_create": {
    "zh-CN":
      "提出一次「新建搜索提供商」的变更，管理员在界面上确认并补填 API 密钥后才会真正创建。\n" +
      "这个工具不接收密钥，也不该向用户索取 —— 密钥由管理员在确认时自己填。\n" +
      "**优先用内置模板**：kind 填 searxng / tavily / brave，工具会带上对应的默认协议；" +
      "只有在接一个没有模板的厂商时才自己写 spec。",
    en:
      "Propose a \"create a new search provider\" change; the provider is only really created once an " +
      "administrator confirms it in the interface and fills in the API key.\n" +
      "This tool does not accept a key and must not ask the user for one — the administrator fills " +
      "it in at confirmation time.\n" +
      "**Prefer the built-in templates**: put searxng / tavily / brave in kind and the tool brings " +
      "the matching default protocol; only write a spec yourself for a vendor that has no template.",
  },
  "propose_search_provider_create.name": {
    "zh-CN": "显示名称",
    en: "The display name",
  },
  "propose_search_provider_create.kind": {
    "zh-CN":
      "厂商标签。用内置模板时填 searxng / tavily / brave；" +
      "自带 spec 时可以填任何名字，spec.vendor 会写进用量统计。",
    en:
      "The vendor label. Use searxng / tavily / brave with the built-in templates; with your own " +
      "spec you may use any name, and spec.vendor is what the usage report records.",
  },
  "propose_search_provider_create.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_search_provider_create.baseUrl": {
    "zh-CN":
      "服务地址。**服务根地址**，不是完整端点 —— 端点路径由协议里的 transport.path 决定。" +
      "自带 spec 时如果 spec.baseUrl 有值，这一条优先。",
    en:
      "The service address. **The service root address**, not a full endpoint — the endpoint path " +
      "is decided by transport.path in the protocol. With your own spec, if spec.baseUrl has a " +
      "value it wins.",
  },
  "propose_search_provider_create.apiKeyHint": {
    "zh-CN": "一句话说明这个密钥是给哪个厂商的（例如「Tavily 的 key」）。不要写密钥本身。",
    en: "One sentence saying which vendor the key is for (for example \"the Tavily key\"). Do not write the key itself.",
  },
  "propose_search_provider_create.priority": {
    "zh-CN": "数值越小越优先",
    en: "The smaller the number, the higher the priority",
  },
  "propose_search_provider_create.creditsPerCall": {
    "zh-CN": "每次调用扣多少整数积分；0 表示免费。不填按 1。",
    en: "How many whole credits each call costs; 0 means free. Leave it out and it counts as 1.",
  },
  "propose_search_provider_create.spec": {
    "zh-CN":
      "可选的完整搜索协议。没有内置模板的厂商才需要写，" +
      "形状必须与 get_search_spec_reference 返回的模板逐字一致。",
    en:
      "An optional complete search protocol. Only needed for a vendor with no built-in template, " +
      "and the shape must match the template get_search_spec_reference returns exactly.",
  },
  "propose_search_provider_update": {
    "zh-CN":
      "提出一次搜索提供商配置变更，同样需要管理员确认才执行。只能改已存在的搜索提供商，不能新建。\n" +
      "只写要改的字段，其余原样保留。spec 是整份替换 —— " +
      "要改就先用 list_search_providers(full=true) 取回现状再改。",
    en:
      "Propose a change to a search provider's configuration, which likewise runs only after an " +
      "administrator confirms it. It can only change a search provider that already exists; it " +
      "cannot create one.\n" +
      "Write only the fields you are changing and the rest are kept as they are. spec is replaced " +
      "wholesale — to change it, read the current one with list_search_providers(full=true) first " +
      "and change that.",
  },
  "propose_search_provider_update.summary": {
    "zh-CN": "一句话说明这次变更的目的",
    en: "One sentence saying what this change is for",
  },
  "propose_search_provider_update.baseUrl": {
    "zh-CN": "服务根地址",
    en: "The service root address",
  },
  "propose_search_provider_update.spec": {
    "zh-CN": "整份替换的搜索协议。传 null 表示清掉这份协议，回到内置模板。",
    en: "The search protocol, replaced wholesale. Passing null clears the protocol and goes back to the built-in template.",
  },
  "list_users": {
    "zh-CN": "列出所有用户及其角色、配额和密钥数。",
    en: "List every user with their role, quota and number of keys.",
  },
};

/**
 * The wording of a tool description.
 *
 * A missing key returns itself rather than an empty string: an empty
 * description is invisible, and one that reads as its own key is a bug somebody
 * can see. A row that has no English yet falls back to the Chinese text, which
 * is the deployment's own language and always a truthful answer.
 */
export function toolDescription(locale: Locale | undefined, key: string): string {
  const entry = TOOL_DESCRIPTIONS[key];
  if (!entry) return key;
  return locale === "en" ? entry.en || entry["zh-CN"] : entry["zh-CN"];
}

/**
 * Every refusal the tool layer can produce.
 *
 * These are read by the person in front of the screen — in the tool card —
 * so they follow the reader's language rather than the deployment's. The
 * Chinese column is the wording that is running today, copied over unchanged.
 *
 * A few rows carry a `{name}` placeholder and are filled in with
 * `toolRefusal(locale, key, { name: value })`; the placeholder names are the
 * same on both sides.
 */
export const TOOL_REFUSALS: Record<string, ToolText> = {
  adminOnly: {
    "zh-CN": "这是管理员功能。",
    en: "This is an administrator feature.",
  },
  askUserNeedsQuestion: {
    "zh-CN": "ask_user 需要一个非空的 question。",
    en: "ask_user needs a non-empty question.",
  },
  unknownTool: {
    "zh-CN": "未知工具：{tool}",
    en: "Unknown tool: {tool}",
  },
  noCredential: {
    "zh-CN":
      "助手没有可用于本部署的凭据，无法发起真实调用。两种改法：在助手设置里开启「用我的账号身份调用」" +
      "（由系统签发一把只有助手能用、你看不到明文的凭据），或者自己填一把 sk-relay- 开头的网关密钥。",
    en:
      "The assistant has no credential it can use against this deployment, so it cannot make a " +
      "real call. Two ways to fix it: turn on \"call as my account\" in the assistant settings (the " +
      "system issues a credential only the assistant can use, and you never see the plaintext), or " +
      "paste in a gateway key that starts with sk-relay- yourself.",
  },
  missingModel: {
    "zh-CN": "缺少 model 参数。",
    en: "The model argument is missing.",
  },
  missingPrompt: {
    "zh-CN": "缺少提示词 / 输入文本。",
    en: "The prompt / input text is missing.",
  },
  missingQuery: {
    "zh-CN": "缺少 query。",
    en: "The query is missing.",
  },
  missingUrl: {
    "zh-CN": "缺少 url。",
    en: "The url is missing.",
  },
  missingName: {
    "zh-CN": "缺少 name。",
    en: "The name is missing.",
  },
  missingKind: {
    "zh-CN": "缺少 kind。",
    en: "The kind is missing.",
  },
  missingProviderId: {
    "zh-CN": "缺少 providerId。",
    en: "The providerId is missing.",
  },
  missingModels: {
    "zh-CN": "缺少 models。新建媒体服务商必须给出模型表。",
    en: "The models are missing. Creating a media provider requires the model table.",
  },
  providerIdRequired: {
    "zh-CN": "需要 providerId，先用 list_providers 查。",
    en: "providerId is required — look it up with list_providers first.",
  },
  providerAndClientIdRequired: {
    "zh-CN": "需要 providerId 和 clientId。",
    en: "providerId and clientId are required.",
  },
  providerIdAndBaseUrlRequired: {
    "zh-CN": "需要 providerId 和 baseUrl。",
    en: "providerId and baseUrl are required.",
  },
  providerNotFound: {
    "zh-CN": "找不到服务商 {providerId}。",
    en: "No provider with the id {providerId}.",
  },
  mediaProviderNotFound: {
    "zh-CN": "找不到媒体服务商 {providerId}。",
    en: "No media provider with the id {providerId}.",
  },
  searchProviderNotFound: {
    "zh-CN": "找不到搜索提供商 {providerId}。",
    en: "No search provider with the id {providerId}.",
  },
  noProviders: {
    "zh-CN": "没有任何服务商。",
    en: "There are no providers at all.",
  },
  modelNotInProvider: {
    "zh-CN":
      "服务商 {providerName} 里没有名为 {model} 的模型。" +
      "现有的：{existing}。" +
      "新增模型请用 propose_provider_update 改 modelMapping。",
    en:
      "The provider {providerName} has no model called {model}." +
      "The existing ones are: {existing}." +
      "To add a model, change modelMapping with propose_provider_update.",
  },
  modelConfigMissing: {
    "zh-CN":
      "服务商 {providerName} 里没有名为 {clientId} 的模型配置。" +
      "现有的：{existing}。" +
      "如果这是一个新模型，先用 propose_provider_update 改 modelMapping。",
    en:
      "The provider {providerName} has no model configuration called {clientId}." +
      "The existing ones are: {existing}." +
      "If this is a new model, change modelMapping with propose_provider_update first.",
  },
  modelConfigInvalid: {
    "zh-CN": "{model}：{error}",
    en: "{model}: {error}",
  },
  modelsNotObject: {
    "zh-CN": "models 必须是一个对象：模型名 → 该模型要设的字段。",
    en: "models must be an object: model name → the fields to set for that model.",
  },
  modelsEmpty: {
    "zh-CN": "models 是空的，没有要改的模型。",
    en: "models is empty — there is no model to change.",
  },
  mediaModelsEmpty: {
    "zh-CN": "models 是空的。",
    en: "models is empty.",
  },
  tooManyModels: {
    "zh-CN": "一次最多改 200 个模型。",
    en: "At most 200 models can be changed in one go.",
  },
  mediaModelNotObject: {
    "zh-CN": "模型 {modelId} 的配置不是对象。",
    en: "The configuration for model {modelId} is not an object.",
  },
  mediaModelMissingUpstreamId: {
    "zh-CN": "模型 {modelId} 缺少 upstreamId。",
    en: "Model {modelId} has no upstreamId.",
  },
  modelMappingEmpty: {
    "zh-CN": "modelMapping 是空的。",
    en: "modelMapping is empty.",
  },
  noFieldsToChange: {
    "zh-CN": "没有提供任何要修改的字段。",
    en: "No field to change was provided.",
  },
  noSearchFieldsToChange: {
    "zh-CN": "没有要改的字段。",
    en: "There is no field to change.",
  },
  upstreamFormatInvalid: {
    "zh-CN": 'upstreamFormat 只能是 "chat"、"responses"、"anthropic" 或 "gemini"。',
    en: 'upstreamFormat can only be "chat", "responses", "anthropic" or "gemini".',
  },
  headersNotObject: {
    "zh-CN":
      'headers 必须是一个字符串键值对对象，例如 {"api-version": "2024-08-01-preview"}。',
    en:
      'headers must be an object of string key/value pairs, for example {"api-version": ' +
      '"2024-08-01-preview"}.',
  },
  textSpecsNotArray: {
    "zh-CN": "textSpecs 必须是数组，每一项是一份协议文档。",
    en: "textSpecs must be an array, each entry being one protocol document.",
  },
  textSpecInvalid: {
    "zh-CN": "这份协议不能用，已列出问题：\n- {errors}",
    en: "This protocol cannot be used. The problems are listed:\n- {errors}",
  },
  textSpecsConflict: {
    "zh-CN": "这组协议不能同时生效：\n- {errors}",
    en: "These protocols cannot all apply at once:\n- {errors}",
  },
  protocolNoPreset: {
    "zh-CN":
      "协议「{protocols}」没有可用预设：本部署没有它对应的客户端端点，配了也不会被任何请求选中。" +
      "可配置的是：{available}。",
    en:
      "There is no preset for the protocol(s) \"{protocols}\": this deployment has no matching " +
      "client endpoint, so a rule for it would never be selected by any request. The configurable " +
      "ones are: {available}.",
  },
  textProtocolUnreadable: {
    "zh-CN": "读不到文本适配协议原文。",
    en: "The text adapter protocol document could not be read.",
  },
  mediaProtocolUnreadable: {
    "zh-CN": "读不到媒体适配协议原文。",
    en: "The media adapter protocol document could not be read.",
  },
  searchProtocolUnreadable: {
    "zh-CN": "读不到搜索适配协议原文。",
    en: "The search adapter protocol document could not be read.",
  },
  mediaTemplateMissingCapability: {
    "zh-CN": "没有哪个模板含能力「{capability}」。可用能力：{capabilities}",
    en: "No template contains the capability \"{capability}\". The available capabilities are: {capabilities}",
  },
  noMediaTemplates: {
    "zh-CN": "本部署没有内置任何媒体模板。",
    en: "This deployment has no built-in media templates.",
  },
  specEditsNotArray: {
    "zh-CN": "specEdits 不是数组",
    en: "specEdits is not an array",
  },
  specEditsIndexOutOfRange: {
    "zh-CN": "specEdits[{index}].index 越界：现在是 {value}，而当前只有 {count} 个 spec",
    en: "specEdits[{index}].index is out of range: it is {value}, and there are only {count} specs",
  },
  apiKeyInArguments: {
    "zh-CN":
      "不要在工具参数里放 API 密钥。这个工具不接收它，管理员会在确认界面上自己填。" +
      "你也不该向用户索取密钥。",
    en:
      "Do not put an API key in the tool arguments. This tool does not accept one — the " +
      "administrator fills it in on the confirmation screen. You should not ask the user for a " +
      "key either.",
  },
  pagesNotArray: {
    "zh-CN": "pages 必须是数组。",
    en: "pages must be an array.",
  },
  pagesInvalid: {
    "zh-CN": "这些页面不能用：\n- {problems}",
    en: "These pages cannot be used:\n- {problems}",
  },
  actionIdRequired: {
    "zh-CN": "要撤回哪一条？给我 actionId。",
    en: "Which one should be withdrawn? Give me the actionId.",
  },
  proposalNotFound: {
    "zh-CN": "找不到提案 {actionId}，它可能不属于当前账号，或者已经被清理了。",
    en: "No proposal with the id {actionId}; it may not belong to this account, or it may already have been cleaned up.",
  },
  actionNotWithdrawableApplied: {
    "zh-CN":
      "提案 {actionId} 撤不了：当前状态是 {status}，{how}。" +
      "要改回去请重新提一条，管理员确认后才会生效。",
    en:
      "The proposal {actionId} cannot be withdrawn: its status is {status}, and {how}. " +
      "To change it back, propose a new one — it only takes effect once an administrator " +
      "confirms it.",
  },
  actionNotWithdrawableHandled: {
    "zh-CN": "提案 {actionId} 撤不了：当前状态是 {status}，{how}。",
    en: "The proposal {actionId} cannot be withdrawn: its status is {status}, and {how}.",
  },
  withdrawStatusApplied: {
    "zh-CN": "它已经生效了，撤回不会把配置改回去",
    en: "it has already taken effect, so withdrawing will not change the configuration back",
  },
  withdrawStatusHandled: {
    "zh-CN": "它已经被处理过了",
    en: "it has already been processed",
  },
  actionWithdrawRace: {
    "zh-CN":
      "提案 {actionId} 撤不掉了——状态在查询和撤回之间变了（可能刚被确认）。" +
      "用 list_my_proposals 重新看一眼。",
    en:
      "The proposal {actionId} can no longer be withdrawn — its status changed between the lookup " +
      "and the withdrawal (it may have just been confirmed). Look again with list_my_proposals.",
  },
  statusNotString: {
    "zh-CN": "status 只能是字符串。",
    en: "status can only be a string.",
  },
  statusInvalid: {
    "zh-CN": "status 只能是 pending / applied / rejected / failed 之一。",
    en: "status can only be one of pending / applied / rejected / failed.",
  },
  adminDocsOnly: {
    "zh-CN": "admin: 文档只有管理员能读。你是普通用户看不到这一页。",
    en: "admin: only administrators can read these docs. As a regular user you cannot see this page.",
  },
  docTopicUnavailable: {
    "zh-CN": "{reason}\n可用：{available}",
    en: "{reason}\nAvailable: {available}",
  },
  docReadFailed: {
    "zh-CN": "{reason}",
    en: "That documentation page could not be read: {reason}",
  },
  referenceImageEmpty: {
    "zh-CN": "image 是空的。",
    en: "image is empty.",
  },
  referenceImageForms: {
    "zh-CN":
      "image 只接受三种写法：attachment（用用户这一条消息里附的图片）、" +
      "一个 http(s) 图片网址、或者一个 data URL。",
    en:
      "image accepts three forms only: attachment (the picture attached to this message), an " +
      "http(s) image URL, or a data URL.",
  },
  referenceAudioEmpty: {
    "zh-CN": "audio 是空的。",
    en: "audio is empty.",
  },
  referenceAudioForms: {
    "zh-CN":
      "audio 只接受三种写法：attachment（用用户这一条消息里附的音频）、" +
      "一个 http(s) 音频网址、或者一个 data URL。",
    en:
      "audio accepts three forms only: attachment (the audio attached to this message), an " +
      "http(s) audio URL, or a data URL.",
  },
  noAttachedImage: {
    "zh-CN": "这一条消息里没有附上图片，所以没有可用的参考图。",
    en: "No picture was attached to this message, so there is no reference image to use.",
  },
  noAttachedAudio: {
    "zh-CN":
      "这一条消息里没有附上音频。" +
      "请让他用输入框旁边的回形针（添加图片、音频或视频）挑一个音频文件，连同这条消息一起发过来。",
    en:
      "No audio was attached to this message. " +
      "Ask them to use the paperclip next to the input box (add an image, audio or video) to pick " +
      "an audio file and send it along with this message.",
  },
  attachmentUnreadable: {
    "zh-CN": "附件 {name} 已经读不出来了，请重新发一次。",
    en: "The attachment {name} can no longer be read; please send it again.",
  },
  attachmentTooLarge: {
    "zh-CN": "附件 {name} 有 {size}MB，超过 {limit}MB 的参考图上限。",
    en: "The attachment {name} is {size}MB, over the {limit}MB limit for a reference image.",
  },
  callFailed: {
    "zh-CN": "调用失败：{message}",
    en: "The call failed: {message}",
  },
  fetchFailed: {
    "zh-CN": "抓取失败：{message}",
    en: "The fetch failed: {message}",
  },
  webFetchRefused: {
    "zh-CN": "{message}",
    en: "That page could not be read: {message}",
  },
  searchFailed: {
    "zh-CN": "搜索失败：{message}",
    en: "The search failed: {message}",
  },
  searchUserBackendFailed: {
    "zh-CN": "{message}（这是你自己的搜索服务。在「AI 助手 → 设置」里可以切回站点的搜索服务。）",
    en: "{message} (this is your own search service. In \"AI Assistant → Settings\" you can switch back to the site's search service.)",
  },
  searchOffByAdmin: {
    "zh-CN":
      "网页搜索已被管理员关闭（管理台 → 搜索）。" +
      "请直接告诉用户，不要凭记忆补搜索结果。",
    en:
      "Web search has been switched off by the administrator (Admin console → Search). " +
      "Say so to the user directly; do not fill in search results from memory.",
  },
  searchNoBackend: {
    "zh-CN":
      "这个部署没有配置任何搜索后端。" +
      "请告诉用户：请在「AI 助手 → 设置」里配置他自己的" +
      "OpenAI 兼容搜索服务，或请管理员在「管理台 → 搜索」里添加一个提供商。" +
      "不要凭记忆补搜索结果。",
    en:
      "This deployment has no search backend configured. " +
      "Tell the user: configure their own OpenAI-compatible search service in " +
      "\"AI Assistant → Settings\", or ask the administrator to add a provider under " +
      "\"Admin console → Search\". Do not fill in search results from memory.",
  },
  searchOffThisTurn: {
    "zh-CN": "本轮已关闭网页搜索。需要联网时请让用户在输入框旁边打开开关。",
    en: "Web search is off for this turn. When you need the network, ask the user to turn the switch on next to the input box.",
  },
  searchBackendMissing: {
    "zh-CN":
      "没有可用的搜索后端。请在「AI 助手 → 设置」里配置你自己的搜索服务" +
      "（OpenAI 兼容的搜索接口），或请管理员在「管理台 → 搜索」里添加一个提供商" +
      "——网页搜索也可以由管理员用 TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_URL 配置。" +
      "没配置之前不要声称自己「搜索过」。",
    en:
      "There is no search backend available. Configure your own search service (an " +
      "OpenAI-compatible search interface) in \"AI Assistant → Settings\", or ask the administrator " +
      "to add a provider under \"Admin console → Search\" — web search can also be configured by " +
      "the administrator with TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_URL. Until one is " +
      "configured, do not claim that you \"searched\".",
  },
  searchNeedsCredential: {
    "zh-CN":
      "站点的搜索服务需要「用我的账号身份」：请先在「AI 助手 → 设置」里创建并打开助手凭据" +
      "（不需要填任何密钥，系统签发、你看不到明文）；" +
      "或者改用你自己的搜索服务（用自己的密钥，不经过本中转站计费）。",
    en:
      "The site's search service needs \"call as my account\": create and switch on an assistant " +
      "credential in \"AI Assistant → Settings\" first (you do not fill in any key — the system " +
      "issues one and you never see the plaintext); or use your own search service instead (your " +
      "own key, not billed through this relay).",
  },
  searchNoApiKey: {
    "zh-CN":
      "这个账号还没有密钥，无法记账 —— 请先在「我的密钥与额度」里创建一把；" +
      "或者在「AI 助手 → 设置」里配置你自己的搜索服务（那种不经过本中转站计费）。",
    en:
      "This account has no key yet, so it cannot be billed — create one under \"My keys and " +
      "quota\" first; or configure your own search service in \"AI Assistant → Settings\" (that one " +
      "is not billed through this relay).",
  },
  accountNotFound: {
    "zh-CN": "找不到当前账号。",
    en: "The current account could not be found.",
  },
  noSttModel: {
    "zh-CN":
      "这个网关还没有配置语音识别模型。" +
      "请在「媒体服务商」里给某个服务商加一个 audio.stt 的协议（例如 MiniMax 的 asr-1.0）。",
    en:
      "This gateway has no speech recognition model configured yet. Add an audio.stt protocol to " +
      "one of the providers under \"Media providers\" (for example MiniMax's asr-1.0).",
  },
  sttModelRequired: {
    "zh-CN": "请指定语音识别模型。可选：{models}。",
    en: "Please name a speech recognition model. The options are: {models}.",
  },
  findingsBlocked: {
    "zh-CN": "{details}",
    en: "The configuration checks refused this proposal:\n{details}",
  },
  proposalRejected: {
    "zh-CN": "{reason}",
    en: "The proposal was refused by the shared validation:\n{reason}",
  },
  modelConfigPurposeInvalid: {
    "zh-CN": "用途必须是 {purposes} 之一。",
    en: "purpose must be one of {purposes}.",
  },
  modelConfigLevelsNotArray: {
    "zh-CN": "思考等级必须是一个字符串数组。",
    en: "The thinking levels must be an array of strings.",
  },
  modelConfigLevelsNotStrings: {
    "zh-CN": "思考等级必须是一个非空字符串组成的数组。",
    en: "The thinking levels must be an array of non-empty strings.",
  },
  modelConfigLevelsTooMany: {
    "zh-CN": "思考等级最多 24 个。",
    en: "At most 24 thinking levels are allowed.",
  },
  modelConfigNotANumber: {
    "zh-CN": "{field}必须是一个非负数字。",
    en: "{field} must be a non-negative number.",
  },
  modelConfigNotAnInteger: {
    "zh-CN": "{field}必须是整数。",
    en: "{field} must be a whole number.",
  },
  modelConfigFieldContextLength: {
    "zh-CN": "上下文长度",
    en: "Context length",
  },
  modelConfigFieldMaxOutputTokens: {
    "zh-CN": "最大输出",
    en: "Maximum output",
  },
  modelConfigFieldInputPrice: {
    "zh-CN": "输入价格",
    en: "Input price",
  },
  modelConfigFieldOutputPrice: {
    "zh-CN": "输出价格",
    en: "Output price",
  },
  modelConfigFieldCacheReadPrice: {
    "zh-CN": "缓存读价格",
    en: "Cache read price",
  },
  modelConfigFieldCacheWritePrice: {
    "zh-CN": "缓存写价格",
    en: "Cache write price",
  },
};

/**
 * The wording of a refusal.
 *
 * The same fallback rules as {@link toolDescription}: a missing key returns
 * itself so the gap is visible, and a row with no English yet falls back to
 * the Chinese text. `{name}` placeholders are filled from `vars`, exactly the
 * way the dictionary's `translate` does it.
 */
export function toolRefusal(
  locale: Locale | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const entry = TOOL_REFUSALS[key];
  if (!entry) return key;
  const template = locale === "en" ? entry.en || entry["zh-CN"] : entry["zh-CN"];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}
