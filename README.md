<div align="center">

# RelayAB · Debian 自托管分支

</div>

> **本分支（`server`）的目标：把 `main` 的 RelayAB 从 Vercel Serverless 移植到 Debian 服务器。**
>
> 停更的真正原因原本是 Vercel Pro 每月 20 美元的固定月费叠加 Hobby 额度上限。
> 自托管直接消掉了这两项成本：SQLite + systemd + nginx，**没有平台月费，也没有请求数上限**。
>
> **与 `main` 的关系**：两者目前视为**相互独立的项目**。`main` 是原 Vercel 版本
> （停在 v178），保留待后续恢复；本分支只负责 Debian 自托管，不依赖 `main`，也暂不与它合并。
> 本分支尚在真机验收阶段，克隆本仓库默认拿到的是本分支。

---

# RelayAB

> 一个自托管的 AI API 网关（API 中转站），用于将上游 AI 服务的 API Key
> 安全、可控地分享给少数人，并实现精细的权限和用量管理。
> 部署到自己的 Debian 服务器（SQLite + systemd + nginx），**无平台月费**。
>
> **语言 / Language：中文（本页）· [English](README.en.md)**　——切换只在此处，正文内部不会自动跳语言

## 部署到 Debian 服务器

原先的一键部署到 Vercel 的路径已移除。RelayAB 现在可以直接跑在自己的机器上，
没有平台月费，也没有请求数上限。

**完整分步手册：[deploy/README.md](deploy/README.md)**

快速概览：

```bash
# 1. 数据库目录（SQLite 不需要装任何服务，只要一个可写的目录）
sudo useradd -r -m -d /opt/relayab -s /usr/sbin/nologin relayab
sudo mkdir -p /var/lib/relayab
sudo chown relayab:relayab /var/lib/relayab

# 2. 代码与构建
sudo -u relayab git clone <repo> /opt/relayab
cd /opt/relayab && corepack pnpm install --frozen-lockfile && corepack pnpm build

# 3. 环境变量
cp deploy/env.production.example .env.production   # 填 RELAY_AUTH / RELAY_DB_PATH / RELAY_BUILD_ID
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

`deploy/` 目录里有全部现成配置：systemd unit、nginx 站点、环境变量模板。
数据库本身不用装、不用起、不用配密码。

### 密钥不用你手写

根目录的 `app.json` 声明了主密钥由平台自动生成：

```json
"RELAY_AUTH": { "generator": "secret" }
```

Dokku 会在首次部署时生成一个 64 字符的加密安全随机串。所以这个密钥
**不需要你写下来、不进 shell 历史、不进 GitHub Secrets、不需要复制到任何地方** ——
只有 Dokku 知道。

原生部署则用 `openssl rand -hex 32` 自己生成一次，存进 `chmod 600` 的
`.env.production` 即可。

完整的 Dokku 路线见 [`deploy/dokku.md`](deploy/dokku.md)。

### 三个容易配错的地方

1. **nginx 必须关掉响应缓冲**（`proxy_buffering off` + `X-Accel-Buffering no`），
   否则 SSE 流式输出会变成「卡住然后一次性全吐」。
2. **systemd 的 `WorkingDirectory` 必须在仓库根**。管理台有两个页面在运行时读
   仓库里的文件（`docs/模型适配协议/README.md`、`scripts/spec-check.ts`），
   只拷 `.next` 会让它们显示「读取失败」。
3. **数据库文件必须放在发布目录之外**（`RELAY_DB_PATH` 指到 `/var/lib/relayab/relayab.db`）。
   否则 `git pull` 和重新构建会碰到它。而且目录与文件的属主必须是 `relayab`，
   否则第一次查询会报 `SQLITE_CANTOPEN` / `SQLITE_READONLY`。

### 验证

```bash
curl -s https://<your-domain>/healthz
```

期望：

```json
{"ok":true,"data":{"status":"ok","storage":"sqlite","env":{"required":1,"configured":1},"revision":"v179"}}
```

`storage` 字段用来确认走的是哪条数据库通道（`sqlite` = 本地文件，**默认**）。
`revision` 来自你设置的 `RELAY_BUILD_ID`——自托管没有 Vercel 自动注入的
commit SHA，**不设置它就无法判断线上跑的是哪一版**。

### 数据库不需要任何服务

数据存在一个 SQLite 文件里，由 Node 24 内置的 `node:sqlite` 管理 —— 没有
Redis/Valkey，没有端口，没有密码，没有内存淘汰导致数据消失的可能。备份就是复制文件。

唯一的必填环境变量是 `RELAY_AUTH`（主密钥）。数据库路径可选，不设就用
`<工作目录>/data/relayab.db`；生产环境建议显式指定到发布目录之外。

> 原先的 Upstash REST 通道和本机 TCP 通道都已随存储迁移一并移除，
> 现在只有 SQLite 一条路。

配置细节（架构、冒烟测试清单、故障排查、主密钥轮换）见
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
- **上游 Provider Key** 用 AES-256-GCM 加密后存数据库，**主密钥丢失 = 数据永久不可用**
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
| 数据 | SQLite（Node 24 内置 `node:sqlite`，一个文件，无外部服务） |
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

**只有 1 个必填，而且不需要任何数据库服务：**

```bash
# 必填：主密码（也是管理员登录密码）
RELAY_AUTH="<openssl rand -hex 32>"

# 可选：数据库文件位置，不设则默认 ./data/relayab.db
RELAY_DB_PATH="./data/relayab.db"
```

SQLite 由 Node 24 内置的 `node:sqlite` 驱动，**没有 npm 依赖，也没有服务要装**。
不设 `RELAY_DB_PATH` 直接 `pnpm dev` 就会在仓库下建 `data/relayab.db`；
想每次重启从零开始，设 `RELAY_DB_PATH=":memory:"` 即可。

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

默认就用仓库下的 SQLite 文件 `./data/relayab.db`，不设任何环境变量也能跑：

```bash
pnpm dev          # → http://localhost:3000
```

想每次重启从零开始，加 `RELAY_DB_PATH=":memory:"`（测试就是这么做的）。

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
pnpm smoke               # 端到端冒烟：真实 dev server + mock 上游（本地 SQLite）
pnpm type-check          # TypeScript 编译检查
pnpm build               # Next.js 生产构建
```

## 项目结构

```
RelayAB/
├── deploy/              自托管部署配置（systemd / nginx / env 模板）
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
| [docs/zh/data-model.md](docs/zh/data-model.md) | 表结构 + 列名 + 索引 + 字段定义 |
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
3. **上游 Provider Key**：AES-256-GCM 加密后入库，**主密钥 = `RELAY_MASTER_KEY_HEX`**，丢失即不可恢复
4. **Session Cookie**：iron-session 加密（HttpOnly + Secure + SameSite=Lax）
5. **数据库文件单独泄漏不致命**：拿到 `.db` 但拿不到 env var → 无法解密上游 Key
6. **但数据库文件本身要收紧权限**：`chmod 600` + 属主 `relayab`。文件里存着
   用户名、`sha256(key)`、明文 `keyPrefix`、以及加密后的上游 Key。

## 生产部署

分步手册见 [deploy/README.md](deploy/README.md)，设计与配置说明见
[docs/zh/deployment.md](docs/zh/deployment.md)。最关键的环境变量：

| 名称 | 来源 |
|---|---|
| `RELAY_AUTH` | `openssl rand -hex 32`（管理员登录密码 + 密钥派生种子）**← 唯一必填** |
| `RELAY_DB_PATH` | 建议显式指定，如 `/var/lib/relayab/relayab.db`。不设则默认 `./data/relayab.db` |
| `RELAY_BUILD_ID` | 版本号或 commit sha，显示在 `/healthz` 的 `revision` |
| `RELAY_PUBLIC_URL` | 建议设为 `https://你的域名` |
| `NODE_ENV` | `production` |
| `RELAY_ADMIN_USERNAME` | 可选，默认 `admin` |
| `RELAY_DEFAULT_LOCALE` | 可选，界面默认语言 `zh-CN`（默认）或 `en` |
| `RELAY_MASTER_KEY_HEX` | 可选，默认从 `RELAY_AUTH` 派生 |

`SESSION_PASSWORD` 与（默认情况下的）`RELAY_MASTER_KEY_HEX` 都由 `RELAY_AUTH`
派生，无需手动设置。

数据默认落在 `<工作目录>/data/relayab.db`。生产环境建议显式设 `RELAY_DB_PATH`
把它放到发布目录之外，这样 `git pull` 和重新构建都碰不到它。

## 许可证

MIT
