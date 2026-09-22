# RelayAB

> 一个自托管的 AI API 网关（API 中转站），用于将上游 AI 服务的 API Key
> 安全、可控地分享给少数人，并实现精细的权限和用量管理。
> 一键部署到 Vercel。

## 一键部署到 Vercel

点下面按钮，Vercel 在 "Add Environment Variables" 区**只让你填 1 个变量** —— `RELAY_AUTH`。Upstash 的两个变量**不在这填**，等部署成功后再用 Vercel Marketplace 一键装；公网地址由 `VERCEL_URL` 自动推导，不用填。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCloudyAasim%2FRelayAB&env=RELAY_AUTH&envDescription=Master%20password%20%2B%20first%20admin%20login%20password&envLink=https%3A%2F%2Fgithub.com%2FCloudyAasim%2FRelayAB%23readme)

### 步骤（每一步该点什么）

1. **点击按钮** → 打开 `vercel.com/new/clone`。Vercel 先让你点 "Continue with GitHub" 完成授权（已登录会自动跳过）。
2. **New Project 页** 出现，向下滚动到 "Add Environment Variables" 区 — **只有一个输入框 `RELAY_AUTH`**。填一个**高熵字符串**（32+ 字节的随机字符；具体值由你定，这是 root secret）。点 **Deploy**。
3. 等 `Ready` 出现，记下 `*.vercel.app` URL。
4. **Storage → Create Database → Upstash** → Free → Create。
5. **Deployments** → 顶部最新一条 → **⋯** → **Redeploy** —— 这次 Upstash 凭证就生效了。

> ⚠️ **Vercel Upstash Marketplace 注入的变量名是 `KV_REST_API_URL` / `KV_REST_API_TOKEN`**（Vercel KV 时代遗留命名），不是 `UPSTASH_REDIS_REST_*`。RelayAB 的代码和 `/healthz` 同时认这两套名字——`UPSTASH_*` 优先，`KV_*` 兜底。所以不管 Vercel 注入哪套，部署都成功。

### 验证

```bash
curl -s https://<your-app>.vercel.app/healthz
```

期望：

```json
{"ok":true,"data":{"status":"ok","env":{"required":3,"configured":3}}}
```

如果 `status` 是 `"degraded"`，响应里 `env.missing` 告诉你哪些还没填：

- 只有 Upstash 缺 → 还没装 Marketplace，跳回 Step 4
- `RELAY_AUTH` 也缺 → Deploy Button 步骤里没填，回去填

### 如果你已经在 Vercel 里有这个项目了

Deploy Button 走的是 "新建项目" 路径；现有项目**不会自动获得**表单。两种处理：

- **(干净)** Vercel Dashboard → Settings → General → **Delete Project** → 再点 Deploy Button 走新建流程
- **(实用)** 现有项目 → **Settings → Environment Variables** → 手动加 3 个 key（Upstash 两个先填任意占位字符串也行，缺 URL 校验就在 URL 那栏填 `https://placeholder.upstash.io`）→ 装 Upstash Marketplace → Redeploy

更多细节（部署保护绕过、自托管密钥轮换、备份策略）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

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
| 数据 | Upstash for Redis（Vercel Marketplace 一键安装） |
| 认证 | iron-session 8 + bcryptjs（work factor 12） |
| 加密 | AES-256-GCM（Node `crypto`）+ bcryptjs |
| 上游 AI | Vercel AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic`) |
| Vercel API | `@vercel/sdk` |
| 测试 | Vitest + Playwright |
| 本地 mock | `@emulators/adapter-next` 嵌入式 |
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

**只有 1 个必填，另外 2 个在 Vercel 上会自动注入：**

```bash
# 必填：主密码（也是管理员登录密码）
RELAY_AUTH="<openssl rand -hex 32>"

# Vercel 上由 Marketplace 自动注入；自托管时才手动填
UPSTASH_REDIS_REST_URL="https://<your-db>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="<your-token>"
```

**公网地址不用配。** `/dashboard/docs` 和欢迎页里展示的接口地址会自动取
`VERCEL_URL`，取不到时读当前请求的 Host 头。只有在自定义域名 / 反向代理
场景下（用户应该调用的地址 ≠ 他们实际访问到的地址）才需要显式设置
`RELAY_PUBLIC_URL` 覆盖。

**可选：自动 bootstrap 上游 Provider（首次启动时生效）**

```bash
# 多个 key 用逗号分隔 → 自动创建 OpenAI provider（启用 key rotation）
OPENAI_KEYS="sk-xxx,sk-yyy"
OPENAI_BASE_URL="https://api.openai.com/v1"   # 覆盖 Azure/代理

ANTHROPIC_KEYS="sk-ant-xxx"
ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

SESSION_PASSWORD 和 RELAY_MASTER_KEY_HEX 都从 RELAY_AUTH 自动派生（HMAC-SHA256），**无需手动生成**。

### 3. 安装 Upstash（推荐）

Vercel Dashboard → 项目 → **Storage** → **Create Database** → **Upstash**
会自动注入 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`。

### 4. 启动开发服务器

```bash
pnpm dev          # → http://localhost:3000
```

### 5. 第一个管理员已自动创建！

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
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-上游-provider-与模型映射)。

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
│       ├── vercel/       Vercel SDK 封装
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

| 文档 | 说明 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整架构 + 数据模型 + 业务决策 |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Redis 键命名 + 字段定义 |
| [docs/API_ROUTES.md](docs/API_ROUTES.md) | API 路由完整规范 |
| [docs/TESTING.md](docs/TESTING.md) | 测试金字塔 + 工具 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署到 Vercel + 部署保护绕过 + 冒烟测试清单 |

## 安全要点

1. **用户密码**：bcryptjs 单向散列（work factor 12），**不可能反推原文**
2. **客户 API Key**：仅存 `sha256(明文)` + 前后缀展示，**明文仅创建时返回一次**
3. **上游 Provider Key**：AES-256-GCM 加密存 Redis，**主密钥 = `RELAY_MASTER_KEY_HEX`**，丢失即不可恢复
4. **Session Cookie**：iron-session 加密（HttpOnly + Secure + SameSite=Lax）
5. **数据库单独泄漏不致命**：拿到 Redis 但拿不到 env var → 无法解密上游 Key

## 完整部署到 Vercel

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。最关键的环境变量：

| 名称 | 来源 |
|---|---|
| `RELAY_AUTH` | `openssl rand -hex 32`（管理员登录密码 + 密钥派生种子） |
| `UPSTASH_REDIS_REST_URL` | Vercel Marketplace 自动注入 |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel Marketplace 自动注入 |
| `RELAY_ADMIN_USERNAME` | 可选，默认 `admin` |
| `RELAY_DEFAULT_LOCALE` | 可选，界面默认语言 `zh-CN`（默认）或 `en` |
| `RELAY_PUBLIC_URL` | 可选，仅当用户应调用的地址 ≠ 实际访问地址时设置（自定义域名 / 反向代理）。默认从 `VERCEL_URL` 或请求 Host 头推导 |
| `RELAY_MASTER_KEY_HEX` | 可选，默认从 `RELAY_AUTH` 派生 |

`SESSION_PASSWORD` 与（默认情况下的）`RELAY_MASTER_KEY_HEX` 都由 `RELAY_AUTH`
派生，无需手动设置。

## 许可证

MIT
