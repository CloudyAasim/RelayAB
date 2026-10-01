<div align="center">

# ⏸ 停更公告 · A Long Pause, Not a Farewell

</div>

> **中文为原版声明，英文采用机器翻译，实际公告内容以中文版本为准，英文版本仅供参考。**
>
> **The Chinese text below is the original announcement. The English text is a
> machine translation, provided for reference only — in case of any discrepancy,
> the Chinese version prevails.**

## 中文（原版）

很遗憾，这个基于 Vercel 开发的开源项目，要停更很长、很长一段时间了。

开发过程中，额度消耗远超预期；而我本人并没有一份正式工作。我所在的地区，大家普遍挣得少，平时花得也少。Vercel 的 Pro 月费按美元全球统一收取，就我所知，并没有针对不同地区的价格折扣；从我们这边的收入来看，它就像是按挣得多的地方来定价。超出免费额度后的用量费用虽然会因地区而异，但对我这样连每月 20 美元都难以承担的人来说，并无实质帮助。每月 20 美元，实在过于昂贵。

所以，这个项目只能先搁置下来，停更很久、很久。这里并不是说它一定不再做了，也不是就此别过，只是眼下不得不按下暂停键，归期未定。感谢大家一直以来的关注和支持，后会有期。

**免责声明**：上面说“我的地区这边挣得少，平时花得也少”，只是对我个人情况和感受的描述，并不是一个绝对结论，也不代表这个地区的所有人都收入低、消费低，更不是说这里所有东西都便宜。请不要把它当成对整个地区的概括或刻板印象。

## English (machine translation, for reference only)

It is with regret that I have to say this Vercel-based open-source project will be paused for a long, long time.

During development, usage ran far beyond what I had expected. I do not have a full-time job. In my region, people generally earn little and spend little. Vercel's Pro plan, as far as I know, is billed at a flat $20 per month in USD, with no regional discount; against local incomes here, it feels priced for places where people earn much more. Usage fees beyond the free allowance may vary by region, but that is little comfort to someone who cannot afford the $20 base fee. Twenty dollars a month is simply too much for me.

So the project has to be set aside for a long, long time. This is not to say it will never be developed again, nor that this is a final goodbye. It only means I must press pause, with no date set for its return. Thank you all for your past interest and support. Until then—see you down the road.

**Disclaimer**: My statement that “people around here earn little and spend little” is only a description of my own situation and impressions. It is not an absolute conclusion, nor does it mean everyone in my region has low income or low spending, or that everything here is cheap. Please do not take it as a generalization or stereotype about the whole region.

## Vercel 官方通知原文

> **Deployments Paused**
>
> Your team exceeded the Hobby fair use limits. Upgrade to Pro to resume service.

---

# RelayAB

> 一个自托管的 AI API 网关（API 中转站），用于将上游 AI 服务的 API Key
> 安全、可控地分享给少数人，并实现精细的权限和用量管理。
> 部署到自己的 Debian 服务器（Valkey + systemd + nginx），**无平台月费**。
>
> **语言 / Language：中文（本页）· [English](README.en.md)**　——切换只在此处，正文内部不会自动跳语言

## 部署到 Debian 服务器

> ⚠️ **本项目已停更，作者不再维护**（见开头《停更公告》）。你仍然可以自行 fork 并部署使用，但不会再有修复、更新或答疑；遇到问题请自行排查，代码与协议文档都在仓库里。

原先的一键部署到 Vercel 的路径已移除——Vercel Pro 每月 20 美元正是《停更公告》里
提到的原因。RelayAB 现在可以直接跑在自己的机器上，没有平台月费，也没有请求
数上限。

**完整分步手册：[deploy/README.md](deploy/README.md)**

快速概览：

```bash
# 1. 数据库（Debian 13 官方源直接内置，无需加第三方仓库）
sudo apt install -y valkey-server
#    配置 /etc/valkey/valkey.conf：requirepass + maxmemory-policy noeviction
sudo systemctl enable --now valkey-server

# 2. 代码与构建
sudo useradd -r -m -d /opt/relayab -s /usr/sbin/nologin relayab
sudo -u relayab git clone <repo> /opt/relayab
cd /opt/relayab && corepack pnpm install --frozen-lockfile && corepack pnpm build

# 3. 环境变量
cp deploy/env.production.example .env.production   # 填 RELAY_AUTH / REDIS_URL / RELAY_BUILD_ID
chmod 600 .env.production

# 4. 常驻服务
sudo cp deploy/relayab.service /etc/systemd/system/
sudo systemctl enable --now relayab

# 5. 反向代理与 TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/relayab
sudo ln -s /etc/nginx/sites-available/relayab /etc/nginx/sites-enabled/relayab
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.your-domain.com
```

`deploy/` 目录里有全部现成配置：systemd unit、nginx 站点、Valkey 配置说明、
环境变量模板。

### 三个容易配错的地方

1. **nginx 必须关掉响应缓冲**（`proxy_buffering off` + `X-Accel-Buffering no`），
   否则 SSE 流式输出会变成「卡住然后一次性全吐」。
2. **systemd 的 `WorkingDirectory` 必须在仓库根**。管理台有两个页面在运行时读
   仓库里的文件（`docs/模型适配协议/README.md`、`scripts/spec-check.ts`），
   只拷 `.next` 会让它们显示「读取失败」。
3. **Valkey 的 `maxmemory-policy` 必须是 `noeviction`**。余额、配额和用量流水
   都存在 Redis 里，配成 `allkeys-lru` 会在内存触顶时**静默淘汰**这些记录。

### 验证

```bash
curl -s https://<your-domain>/healthz
```

期望：

```json
{"ok":true,"status":"ok","storage":"redis","required":2,"configured":2,"revision":"v179"}
```

`storage` 字段用来确认走的是哪条数据库通道（`redis` = 本机 Valkey / TCP），
`revision` 来自你设置的 `RELAY_BUILD_ID`——自托管没有 Vercel 自动注入的
commit SHA，**不设置它就无法判断线上跑的是哪一版**。

### 仍然可以用 Upstash 托管版

设置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 即可走 HTTP REST
通道，代码零改动。`REDIS_URL` 存在时优先走 TCP。

配置细节（架构、选型理由、冒烟测试清单、故障排查、主密钥轮换）见
[docs/zh/deployment.md](docs/zh/deployment.md)。

## 功能

- **多用户 + 角色**（admin / user），密码 bcrypt 散列存储（**单向不可逆**）
- **欢迎页**：`/` 是公开的介绍页——说明服务是什么、给出可复制的接口地址、一个按钮进入控制台。未登录访客不再被直接弹到登录页
- **积分属于账号**（admin 控制）：管理员给账号分配积分总量与可访问模型；
  该账号下的**所有 Key 共用这一份积分**，用完即全部停止。
  多建 Key 不会多拿额度
- **普通用户自助管理**：在 `/dashboard` 自己创建 / 重命名 / 启用停用 / 删除 Key，无需管理员介入
- **普通用户自助改密**：`/dashboard/settings`，需先输入原密码，再输入两次新密码进行验证
- **用户友好的文档页**：`/dashboard/docs`，把公网 URL 与 OpenAI / Anthropic 兼容示例以可复制代码块形式呈现
- **每用户多把 API Key**，每把可独立配置：
  - 过期时间（绝对时间戳）
  - 启用/禁用（随时切换）
  - 模型收窄（可选，只能在账号白名单基础上收窄，不能放宽）
- **客户 Key 格式** 兼容 OpenAI：`sk-relay-...`，HTTP `Authorization: Bearer sk-relay-...`
- **上游 Provider Key** 用 AES-256-GCM 加密后存 Redis，**主密钥丢失 = 数据永久不可用**
- **兼容协议**：
  - OpenAI Chat Completions（`/v1/chat/completions`）
  - OpenAI Responses API（`/v1/responses`，含 Chat / Anthropic 协议自动转换）
  - Anthropic Messages（`/anthropic/v1/messages`）
  - 模型映射（客户端模型 → 上游真实模型，推荐恒等映射）
- **管理后台** + **用户面板** + 用量统计
- **界面多语言**：中文（默认）/ English，页脚一键切换，偏好记在 `relayab_locale` cookie
- **本地开发闭环**：嵌入式 Vercel REST API emulator（无需独立进程、无需网络）

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 15 App Router + React 19 + TypeScript 5 |
| 数据 | Redis 协议（Valkey 8.1 / ioredis 走 TCP，或 Upstash 走 REST） |
| 认证 | iron-session 8 + bcryptjs（work factor 12） |
| 加密 | AES-256-GCM（Node `crypto`）+ bcryptjs |
| 上游 AI | 自写协议转换层（`src/lib/proxy/*`，基于 `fetch`） |
| 部署 | systemd + nginx（配置见 `deploy/`） |
| 测试 | Vitest + Playwright |
| UI | Tailwind CSS 3 + 自写组件 |

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
```

**只有 1 个必填，另外需要一台数据库：**

```bash
# 必填：主密码（也是管理员登录密码）
RELAY_AUTH="<openssl rand -hex 32>"

# 数据库（二选一）。自建 Valkey 走 TCP，是自托管场景的默认选择：
REDIS_URL="redis://:<密码>@127.0.0.1:6379"

# 或者用 Upstash 托管版，走 HTTP REST，代码零改动：
# UPSTASH_REDIS_REST_URL="https://<your-db>.upstash.io"
# UPSTASH_REDIS_REST_TOKEN="<your-token>"
```

**本地开发不需要数据库。** 不设置上面任何一个变量直接 `pnpm dev` 即可——
非生产环境下默认启用内存存储，重启即清空。

**公网地址建议显式设置。** `/dashboard/docs` 和欢迎页里展示的接口地址会依次尝试
数据库设置、`RELAY_PUBLIC_URL`、请求头里的 `x-forwarded-proto` / `x-forwarded-host`。
自托管在 nginx 后面时最后那一档能工作，但那是隐式依赖——nginx 一旦漏转发，
页面就会显示 `http://127.0.0.1:3000`。装好代理后直接把 `RELAY_PUBLIC_URL`
设成你的域名更稳妥。

**可选：自动 bootstrap 上游 Provider（首次启动时生效）**

```bash
# 多个 key 用逗号分隔 → 自动创建 OpenAI provider（启用 key rotation）
OPENAI_KEYS="sk-xxx,sk-yyy"
OPENAI_BASE_URL="https://api.openai.com/v1"   # 覆盖 Azure/代理

ANTHROPIC_KEYS="sk-ant-xxx"
ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

SESSION_PASSWORD 和 RELAY_MASTER_KEY_HEX 都从 RELAY_AUTH 自动派生（HMAC-SHA256），**无需手动生成**。

### 3. 启动开发服务器

本地开发不需要数据库——不设 `REDIS_URL` / `UPSTASH_*` 时默认走内存存储
（`EMULATE_VERCEL_LOCAL=1`，仅在 `NODE_ENV !== "production"` 时生效，重启即清空）。

```bash
pnpm dev          # → http://localhost:3000
```

要连真实的数据库做本地调试，就把 `REDIS_URL` 指到本机 Valkey 或 Upstash。

### 4. 第一个管理员已自动创建！

首次启动时，RelayAB 自动用 `RELAY_AUTH` 作为密码创建 admin 用户。

**登录**：
- 访问 `/login`
- 用户名：`admin`（或自定义 `RELAY_ADMIN_USERNAME`）
- 密码：你的 `RELAY_AUTH` 值

首次登录后建议立即在 `/admin/users` 给自己改密码，或重置一个新的强密码。

## 上游 Provider 配置

在 `/admin/providers` 添加 Provider。三个字段职责不同，别互相替代：

| 字段 | 作用 |
|---|---|
| **kind** | 协议家族（模板决定）。`anthropic` = 这条 Provider 说 Anthropic Messages 协议 |
| **API 请求地址**（baseUrl） | 上游根地址，代理在其后拼端点路径 |
| **上游格式**（upstreamFormat） | 上游原生协议：`responses` / `chat` / `anthropic` |

`baseUrl` 必须和端点配对，这是最常见的配置错误：

| 端点 | `baseUrl` 必须是 |
|---|---|
| `/v1/chat/completions`、`/v1/responses` | 上游的 OpenAI 兼容基址，如 `https://api.minimax.cn/v1` |
| `/anthropic/v1/messages` | 上游的 Anthropic 兼容基址，如 `https://api.minimax.cn/anthropic` |

**同一家上游的两套基址不通用。** 想让三个端点都能用，就建两条 Provider：

```
MiniMax            kind=openai     baseUrl=https://api.minimax.cn/v1        上游格式=Responses（原生）
MiniMaxAnthropic   kind=anthropic  baseUrl=https://api.minimax.cn/anthropic 上游格式=Anthropic Messages
```

### 模型映射怎么写

**用恒等映射**：客户端名和上游名填一样的，例如 `MiniMax-M3` → `MiniMax-M3`。

左列会原样出现在 `GET /v1/models` 并被写进用量日志，所以不要为了迁就某个客户端
而写成 `claude-sonnet-4-6` 指向 `MiniMax-M3` —— 这对使用者是误导。如果客户端
支持指定模型（例如 Claude Code 的 `ANTHROPIC_MODEL`），改客户端配置即可。

完整规则（含 `upstreamFormat` 与协议转换、Anthropic Provider 的分步配置）见
[docs/zh/architecture.md §7](docs/zh/architecture.md#7-上游-provider-与模型映射)。

## 测试

```bash
pnpm test                # 跑所有单元 + 集成测试（无需网络）
pnpm test:unit           # 仅单元测试
pnpm test:integration    # 仅集成测试
pnpm smoke               # 端到端冒烟：真实 dev server + 内存 Redis + mock 上游
pnpm type-check          # TypeScript 编译检查
pnpm build               # Next.js 生产构建
```

## 项目结构

```
RelayAB/
├── deploy/              自托管部署配置（systemd / nginx / Valkey / env 模板）
├── docs/                技术文档
├── scripts/             运维脚本（bootstrap / reset / rotate）
├── src/
│   ├── app/             Next.js App Router 页面与路由
│   │   ├── (auth)/login 登录页
│   │   ├── (user)/dashboard 用户面板
│   │   ├── (admin)/admin  管理员后台
│   │   └── api/          后端 API
│   ├── components/       UI 组件
│   └── lib/              核心库
│       ├── auth/         认证（session / api key）
│       ├── crypto/       加密（secrets / hashing / password）
│       ├── db/           持久化（users / keys / providers / usage）
│       ├── proxy/        上游代理（openai / anthropic）
│       ├── quota/        配额（credits / rates / calculator）
│       └── config.ts     环境变量
├── tests/               unit / integration / e2e
└── 配置文件
```

## 运维命令

```bash
pnpm bootstrap-admin --username <name> [--password <pw>]
pnpm reset-password --username <name>          # 生成新密码并打印
pnpm rotate-key                                # 主密钥轮换（需 OLD_/RELAY_MASTER_KEY_HEX）
pnpm list-usage [--user <name>] [--days N]     # 用量摘要
```

## 文档

入口：[docs/zh/README.md](docs/zh/README.md)（中文文档索引）。

| 文档 | 说明 |
|---|---|
| [docs/zh/architecture.md](docs/zh/architecture.md) | 完整架构 + 数据模型 + 业务决策 |
| [docs/zh/data-model.md](docs/zh/data-model.md) | Redis 键命名 + 字段定义 |
| [docs/zh/api-routes.md](docs/zh/api-routes.md) | API 路由完整规范 |
| [docs/zh/testing.md](docs/zh/testing.md) | 测试金字塔 + 工具 |
| [docs/zh/admin.md](docs/zh/admin.md) | 管理员操作指南（用户/Key/Provider 管理） |
| [docs/zh/deployment.md](docs/zh/deployment.md) | 自托管架构 + 数据库选型 + 冒烟测试清单 + 故障排查 |
| [deploy/README.md](deploy/README.md) | Debian 分步部署手册 |

> **注意**：媒体供应商协议（图片 / 视频 / 语音 / 音乐供应商的声明式 JSON spec 格式，
> 及其离线校验器「判官」）**仅有中文版**：
> [docs/模型适配协议/README.md](docs/模型适配协议/README.md)。

## 安全要点

1. **用户密码**：bcryptjs 单向散列（work factor 12），**不可能反推原文**
2. **客户 API Key**：仅存 `sha256(明文)` + 前后缀展示，**明文仅创建时返回一次**
3. **上游 Provider Key**：AES-256-GCM 加密存 Redis，**主密钥 = `RELAY_MASTER_KEY_HEX`**，丢失即不可恢复
4. **Session Cookie**：iron-session 加密（HttpOnly + Secure + SameSite=Lax）
5. **数据库单独泄漏不致命**：拿到 Redis 但拿不到 env var → 无法解密上游 Key

## 生产部署

分步手册见 [deploy/README.md](deploy/README.md)，设计与配置说明见
[docs/zh/deployment.md](docs/zh/deployment.md)。最关键的环境变量：

| 名称 | 来源 |
|---|---|
| `RELAY_AUTH` | `openssl rand -hex 32`（管理员登录密码 + 密钥派生种子） |
| `REDIS_URL` | 自建 Valkey/Redis 连接串，如 `redis://:<密码>@127.0.0.1:6379` |
| `RELAY_BUILD_ID` | 版本号或 commit sha，显示在 `/healthz` 的 `revision` |
| `RELAY_PUBLIC_URL` | 建议设为 `https://你的域名` |
| `NODE_ENV` | `production`（`EMULATE_VERCEL_LOCAL` 随之默认为 `0`） |
| `RELAY_ADMIN_USERNAME` | 可选，默认 `admin` |
| `RELAY_DEFAULT_LOCALE` | 可选，界面默认语言 `zh-CN`（默认）或 `en` |
| `RELAY_MASTER_KEY_HEX` | 可选，默认从 `RELAY_AUTH` 派生 |

`SESSION_PASSWORD` 与（默认情况下的）`RELAY_MASTER_KEY_HEX` 都由 `RELAY_AUTH`
派生，无需手动设置。

不想自己运维数据库时，改设 `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
走托管版，代码零改动。

## 许可证

MIT
