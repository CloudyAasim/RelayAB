/**
 * src/lib/assistant/deployment-notes.ts
 *
 * The deployment reference the assistant answers "how do I deploy this" from.
 *
 * It is a module rather than free-form model knowledge on purpose: the answers
 * have to match what this codebase actually does — the real env var names, the
 * real Dokku commands, the real failure modes that have bitten this deployment.
 * A model asked to recite deployment steps from memory will produce plausible
 * commands that do not exist here.
 */

interface Note {
  topic: string;
  keywords: string[];
  body: string;
}

const NOTES: Note[] = [
  {
    topic: "总览",
    keywords: ["部署", "deploy", "安装", "开始", "overview"],
    body: [
      "RelayAB 是一个自托管的 AI API 网关，对外提供 OpenAI 兼容的 /v1/* 与 Anthropic 兼容的 /anthropic/v1/* 接口。",
      "",
      "存储用 Node 24 内置的 node:sqlite，不需要装任何数据库服务，也没有端口和密码。",
      "整套需要配置的环境变量只有一个：RELAY_AUTH。",
      "",
      "常见部署方式有两种：",
      "  · Dokku（本项目当前的部署方式，见 topic=dokku）",
      "  · 原生 systemd + nginx（见 topic=systemd）",
    ].join("\n"),
  },
  {
    topic: "环境变量",
    keywords: ["环境变量", "env", "配置", "RELAY_AUTH", "变量"],
    body: [
      "必填（唯一一个）：",
      "  RELAY_AUTH            主密码。它同时派生出会话密钥和 AES 主密钥。",
      "                       改它等于同时废掉所有会话和所有已加密的上游密钥 —— 这是有意的。",
      "",
      "可选：",
      "  RELAY_DB_PATH         数据库路径。生产环境必须放在挂载卷上，不能放容器自身文件系统，",
      "                       否则每次重建镜像数据就没了。容器内通常写 /data/relayab.db。",
      "  RELAY_PUBLIC_URL      对外展示的公网地址。",
      "  RELAY_MASTER_KEY_HEX  显式指定 32 字节十六进制主密钥；不设则由 RELAY_AUTH 派生。",
      "  RELAY_DEFAULT_LOCALE  默认语言（zh / en）。",
      "",
      "陷阱：.npmrc 里不要钉死 store-dir，换机器会直接报 ERR_PNPM_UNEXPECTED_STORE。",
    ].join("\n"),
  },
  {
    topic: "dokku",
    keywords: ["dokku", " Dokku", "部署到 dokku", "建站"],
    body: [
      "在已经装好 Dokku 的服务器上：",
      "",
      "  dokku apps:create relay-ab",
      "  dokku git:set relay-ab deploy-branch server",
      "  dokku storage:mount relay-ab /home/dokku/data/relay-ab:/data",
      "  dokku config:set RELAY_AUTH=... RELAY_DB_PATH=/data/relayab.db",
      "  dokku letsencrypt:enable relay-ab",
      "",
      "挂载卷的属主必须改成容器里应用用户的 uid，否则应用会 Permission denied：",
      "  CID=$(dokku ps:relay-ab web.1 -q) && docker exec $CID id -u",
      "  sudo chown -R <上一步输出的uid>:<gid> /home/dokku/data/relay-ab",
      "",
      "注意 app 名字是 relay-ab（带连字符），而 app.json 里写的 name 也要跟它一致。",
    ].join("\n"),
  },
  {
    topic: "nginx",
    keywords: ["nginx", "超时", "timeout", "body", "sse", "流式", "缓冲"],
    body: [
      "Dokku 的 nginx 默认值对长响应和图片编辑都不够，需要调：",
      "",
      "  dokku nginx:set relay-ab proxy-read-timeout 600s",
      "  dokku nginx:set relay-ab client-max-body-size 10m",
      "  dokku proxy:build-config relay-ab",
      "",
      "60 秒读超时会切断长回答，1m body 限制会拒绝 /v1/images/edits 里的 base64 图片。",
      "流式本身是正常的：应用侧已经带 Cache-Control: no-transform，实测 25 秒的流式回答是",
      "每 300-350 毫秒到达一块，没有被缓冲。",
    ].join("\n"),
  },
  {
    topic: "备份",
    keywords: ["备份", "backup", "恢复", "restore", "数据"],
    body: [
      "数据库就是一个文件，但正在写的时候直接 cp 可能拿到不一致的快照，用 SQLite 的在线备份：",
      "",
      "  sqlite3 /home/dokku/data/relay-ab/relayab.db \\",
      "    \".backup '/home/dokku/backups/relayab-$(date +%F).db'\"",
      "",
      "加一条日备 cron。备份文件里包含加密后的上游密钥，必须和主密钥（RELAY_AUTH）一起保管：",
      "只有文件没有主密钥是解不开的，只有主密钥没有文件也什么都没用。",
    ].join("\n"),
  },
  {
    topic: "排错",
    keywords: ["排错", "故障", "排查", "debug", "不对", "失败", "为什么"],
    body: [
      "常见问题与真实原因：",
      "",
      "  /healthz 说 ok 但功能全崩   → 早期版本只检查环境变量存在、从不打开数据库。",
      "                             现已改为真查库，失败会在 data.error 里给出原因。",
      "",
      "  限流静默失效                → login_throttle 表曾经用懒加载标志建表，数据库重置后标志没清。",
      "                             现已并入主 schema。",
      "",
      "  只填密钥建的服务商路由不出去 → 供应商不会报错，但 baseUrl 和模型映射是空的。",
      "                             跑补全脚本：dokku exec relay-ab web.1 pnpm configure-minimax",
      "",
      "  /healthz 的 revision 是 null  → Dokku 默认不注入 git SHA，需要：",
      "                             dokku git:set relay-ab rev-env-var DOKKU_GIT_REV",
      "",
      "  上游跨区域 401              → MiniMax 的密钥分区域，.io 和 .minimaxi.com 的密钥不能互换。",
      "                             用 probe_provider_host 探测，不要猜。",
    ].join("\n"),
  },
  {
    topic: "服务商",
    keywords: ["服务商", "provider", "上游", "minimax", "供应商", "添加"],
    body: [
      "添加一个服务商，OpenAI 兼容面最少需要四样东西：base URL、密钥、模型映射、上游格式。",
      "",
      "最容易出错的两点：",
      "",
      "  1. baseUrl 写错区域。MiniMax 有三个可用主机：",
      "       api.minimax.io      全球版，密钥来自 platform.minimax.io",
      "       api.minimaxi.com    中国大陆，密钥来自 platform.minimaxi.com",
      "       api.minimax.cn      旧域名，仍可用但官方文档已不再列出",
      "     三个主机对未认证请求返回一模一样的错误封套，光看报错分不出来，必须拿真密钥去探。",
      "",
      "  2. 模型映射。客户端看到的名字要映射到上游真实名字，推荐恒等映射。",
      "     同时要填 modelConfigs 的上下文窗口：填错会让网关以为模型能吃 1M，",
      "     实际上游只吃 200k，然后在超出时以一个很难看懂的方式失败。",
      "",
      "改这些可以让助手来做：propose_provider_update 会生成 before/after 对比，",
      "你确认之后才会真正生效，而且不会碰密钥。",
      "",
      "单个模型的上下文、最大输出、积分价格、是否启用：propose_model_config_update。",
      "改的是网关真实生效的值，文档里显示的也是同一份。",
      "",
      "上游协议（这个服务商说什么协议、每个请求参数怎么处理）：",
      "先调 list_text_protocols 看三个可选接口，绝大多数 OpenAI 兼容中转选 openai-chat 就够了，",
      "什么都不用配 —— 不配协议时客户端的请求体原样送到上游。",
      "厂商确实不一样时才在 propose_provider_update 里传 textSpecs（按 protocol 合并，漏掉的保留）。",
      "写规则前先看该接口所属的协议面开没开：面关着规则会保存但不会有请求走到它。",
      "六种模式：passthrough（默认，没列出的参数一律转发）、drop、default、clamp、force、rename。",
      "",
      "上游格式（OpenAI 侧厂商说的是 responses 还是 chat）：",
      "responses 时客户端调 /v1/responses 原样透传；但调 /v1/chat/completions 仍然发往",
      "<API 地址>/chat/completions —— 网关没有 chat→responses 的请求转换，",
      "厂商不提供该端点就会 404。",
      "",
      "用户文档的「站长补充」那一章：list_doc_pages 先读，propose_doc_pages 再写。",
      "propose_doc_pages 是整份替换，只发新加的那一页会把其余页面全删掉。",
    ].join("\n"),
  },
];

/**
 * Pick the notes that match a topic, or return the overview when nothing does.
 *
 * A keyword match rather than an exact-topic match, because the model will
 * usually pass a free-form phrase like "nginx 超时怎么配" rather than a slug.
 */
export function DEPLOYMENT_NOTES(topic?: unknown): {
  matched: string[];
  notes: Array<{ topic: string; body: string }>;
} {
  const query = typeof topic === "string" ? topic.trim().toLowerCase() : "";
  if (!query) {
    return { matched: ["总览"], notes: NOTES.slice(0, 1) };
  }

  const scored = NOTES.map((note) => {
    let score = 0;
    const normalizedTopic = note.topic.toLowerCase();
    if (normalizedTopic === query) score += 100;
    for (const kw of note.keywords) {
      const k = kw.toLowerCase();
      if (query.includes(k)) score += 10;
      else if (k.includes(query)) score += 5;
    }
    return { note, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      matched: [],
      notes: NOTES.map((n) => ({
        topic: n.topic,
        body: n.body,
      })),
    };
  }

  return {
    matched: scored.map((s) => s.note.topic),
    notes: scored.map((s) => ({ topic: s.note.topic, body: s.note.body })),
  };
}
