# 部署到 Debian 服务器完整指南

> 本文覆盖自托管部署。逐步操作手册见 **[`deploy/README.md`](../../deploy/README.md)**，
> 本文件解释每一步「为什么这么做」以及部署后的验收标准。
>
> 假设你已经：
> - 有一台 Debian 12/13 服务器
> - 一个 A 记录指向该服务器的域名

---

## 1. 架构概览

```
                 ┌──────────────────────────────────────────┐
   互联网        │  nginx  :443                              │
   ────────────▶ │   ├─ TLS 终止（Let's Encrypt）            │
                 │   ├─ 反代到 127.0.0.1:3000                │
                 │   └─ SSE 免缓冲设置                        │
                 └────────────────┬─────────────────────────┘
                                  │
                 ┌────────────────▼─────────────────────────┐
                 │  RelayAB  (systemd, node)                │
                 │   next start，WorkingDirectory=仓库根      │
                 │   /v1/*  /anthropic/*  /api/*  管理台      │
                 └────────────────┬─────────────────────────┘
                                  │  TCP (ioredis)
                 ┌────────────────▼─────────────────────────┐
                 │  Valkey 8.1  127.0.0.1:6379               │
                 │   用户 / 密钥 / 余额 / 用量流水            │
                 └──────────────────────────────────────────┘
```

三个要点：

1. **Valkey 只监听 `127.0.0.1`**，不对外暴露。防火墙也不用开 6379。
2. **nginx 必须关掉响应缓冲**，否则 SSE 流式输出会变成「卡住然后一次性全吐」。
3. **RelayAB 必须从仓库根目录启动**，管理台有两个页面在运行时读仓库里的文件。

---

## 2. 环境变量

**必填 3 个：**

| 名称 | 来源 | 备注 |
|---|---|---|
| `RELAY_AUTH` | 手动：`openssl rand -hex 32` | 主密码，同时承担管理员登录密码 + 会话密钥派生种子 |
| `REDIS_URL` | 手动：`redis://:<密码>@127.0.0.1:6379` | 自建 Valkey 的连接串 |
| `RELAY_BUILD_ID` | 手动：版本号或 commit sha | 显示在 `/healthz` 的 `revision` 字段 |

**强烈建议：**

| 名称 | 备注 |
|---|---|
| `RELAY_PUBLIC_URL` | 设为 `https://你的域名`。不设时依赖 nginx 转发的 `X-Forwarded-*` 头，能工作但多一层隐式依赖 |
| `NODE_ENV` | `production` |
| `EMULATE_VERCEL_LOCAL` | 必须为 `0`（或留空），否则数据不落盘 |

**自动派生**（无需设置）：
- 会话密钥 — 从 `RELAY_AUTH` 派生（HMAC-SHA256）
- `RELAY_MASTER_KEY_HEX` — 默认从 `RELAY_AUTH` 派生（可显式覆盖以独立轮换）

**可选：**
- `OPENAI_KEYS` / `ANTHROPIC_KEYS` — 逗号分隔的多 key，首次启动自动创建 Provider
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — 覆盖默认端点（Azure / 自建代理）
- `RELAY_ADMIN_USERNAME` — 管理员用户名（默认 `admin`）
- `RELAY_DEFAULT_LOCALE` — `zh-CN`（默认）或 `en`
- `RELAY_MASTER_KEY_HEX` — 显式主密钥（**独立于 RELAY_AUTH 轮换时设置**）

> **为什么 `RELAY_BUILD_ID` 值得单独强调：** 之前跑在 Vercel 上时，
> `/healthz` 的 `revision` 取自 `VERCEL_GIT_COMMIT_SHA`，平台自动注入。自托管没有
> 这个变量，如果不设 `RELAY_BUILD_ID`，`/healthz` 的 `revision` 会是 `null` ——
> 你将无法回答「线上跑的到底是哪一版」，而这正是排查部署问题最常用的信息。
> 建议部署脚本自动写入：`git rev-parse --short HEAD`。

完整模板见 [`deploy/env.production.example`](../../deploy/env.production.example)。

---

## 3. 数据库选型

### 3.1 Valkey（推荐，自托管默认）

Debian 13 (trixie) 官方源直接内置 `valkey-server`：

```bash
sudo apt install -y valkey-server valkey-tools
```

Valkey 是 Redis 7.2.4 的社区分支（Linux 基金会，BSD 许可），**协议与命令完全兼容**，
ioredis 无需任何改动。Debian 官方源里 `redis-server 8.x` 也可选，许可证差异对自建自用
无实际影响（AGPL 的网络条款只在「修改后作为服务对外提供」时触发）。

配置要点见 [`deploy/valkey.conf.example`](../../deploy/valkey.conf.example)。其中最关键的一条：

```conf
maxmemory-policy noeviction
```

**为什么必须是 noeviction：** RelayAB 用 Redis 存的是**权威数据**——用户、API 密钥、
余额、用量流水、配额。Valkey 是内存库，一旦 `maxmemory` 触顶，`allkeys-lru` 之类
的策略会**静默淘汰**这些记录：不报错、接口照常返回，但配额和流水凭空消失。
`noeviction` 的行为是「写不进去就明确报错」，这比悄悄丢数据安全得多。

### 3.2 继续用 Upstash 托管版

代码仍然支持：设置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 即可，
走 HTTP REST 通道。`REDIS_URL` 存在时优先走 TCP。

适合暂时不想自己运维、或应用与数据库要分开部署的场景。代价是每个 Redis 命令都是一次
HTTP 请求（代码里已用 pipeline 做了批量合并，见 `hgetallMany`）。

---

## 4. 首次启动与引导

引导是**惰性**的：第一个真正碰到应用的请求（提交登录、访问需要读 session 的页面/接口、
或用 Key 调代理接口）会触发一次 bootstrap；之后再也不会重复执行（失败会在下个请求重试）。

访问 `https://你的域名/login` 时你会看到：

- **管理员账号已自动创建**
  - 用户名：`admin`（或 `RELAY_ADMIN_USERNAME`）
  - 密码：你的 `RELAY_AUTH` 值

- **Upstream Provider 已自动创建**（如果设置了 `OPENAI_KEYS` / `ANTHROPIC_KEYS`）
  - 多个 key 会创建多个 provider 实体（启用 rotation）

**首次登录后建议立即**：
1. 在 `/admin/users` 给自己改密码
2. 在 `/admin/users` 创建普通用户
3. 在 `/admin/keys` 为每个用户创建 API Key（明文仅显示一次！）
4. 在 `/admin/providers` 确认/添加 Upstream Provider
5. 把客户 Key 分发给用户

### 手动创建 admin

```bash
cd /opt/relayab
pnpm bootstrap-admin --username admin --password <your-password>
```

### 验证配置

```bash
curl -s https://你的域名/healthz | jq
```

期望看到 `{"ok":true,"status":"ok","storage":"redis",...}`。

`storage` 字段是这次迁移新增的，用来确认走的是哪条通道：

| 值 | 含义 |
|---|---|
| `redis` | 走 `REDIS_URL` 的 TCP 通道（自托管正常情况） |
| `upstash` | 走 REST 通道——如果你本意是自建 Valkey，说明 `REDIS_URL` 没被读到 |
| `memory` | 内存模式，**生产环境不应出现**，说明 `EMULATE_VERCEL_LOCAL` 配错了 |

---

## 5. 真实上游 API Key 接入

1. 登录 RelayAB → **/admin/providers → New Provider**。
2. 填：
   - Name：`OpenAI Production`
   - Kind：`openai`
   - API Key：`sk-...`
   - Model Mapping：`{ "gpt-4o-mini": "gpt-4o-mini-2024-07-18" }`
3. Save。

明文 Key **不会持久化**——RelayAB 用 `RELAY_MASTER_KEY_HEX` 即时加密后存入 Redis。

### 走网关型上游

如果需要通过第三方网关（AI Gateway、统一代理等）访问上游，**不需要任何环境变量**：
在 `/admin/providers` 把 API base URL 填成网关地址、上游 key 填成网关的 key 即可，
和其他上游一视同仁。它和普通 Provider 一样会被 AES-256-GCM 加密后存储。

---

## 6. 冒烟测试清单（部署后请逐项打勾）

### 6.1 基础
- [ ] `curl https://你的域名/healthz` 返回 `{"ok":true,...}`，且 `storage` 是 `redis`
- [ ] `revision` 字段显示你设置的 `RELAY_BUILD_ID`（不是 `null`）
- [ ] 访问 `/login` 页面正常渲染
- [ ] 用引导 admin 账号登录成功
- [ ] 登录后跳转到 `/admin`

### 6.2 管理
- [ ] 在 `/admin/users` 新建一个测试用户
- [ ] 给该用户新建一把 Key（设置 `quotaType=credits`，`quotaLimit=100000`）
- [ ] 复制明文 Key（仅显示一次）
- [ ] 禁用该 Key，再启用，确认状态正确切换

### 6.3 Provider
- [ ] 在 `/admin/providers` 添加一个真实上游 Provider
- [ ] 保存后在 `/admin/media-providers` 确认媒体供应商配置（若用到图片/音视频）

### 6.4 代理调用
- [ ] 非流式调用：
  ```bash
  curl -X POST https://你的域名/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"say hi"}]}'
  ```
- [ ] 响应里包含 `usage.total_tokens`
- [ ] **流式调用要逐字返回**（不是一次性吐出）：
  ```bash
  curl -N -X POST https://你的域名/v1/chat/completions \
    -H "Authorization: Bearer sk-relay-xxx" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"数到20"}]}'
  ```
  > `-N` 关闭 curl 自己的缓冲。如果这里看着正常但浏览器里是卡顿的，说明是 nginx 缓冲
  > 没配对，见 §8.1。
- [ ] 再次访问 `/admin/usage`，确认消耗增加

### 6.5 用户面板
- [ ] 用测试用户账号登录（不是 admin）
- [ ] 进入 `/dashboard`，能看到自己名下的 Key
- [ ] 查看 Key 用量明细

### 6.6 安全
- [ ] 直接访问 `/api/admin/users`（无 cookie）→ 401
- [ ] 用 disabled 的 Key 调 `/v1/chat/completions` → 403 `key_disabled`
- [ ] 用过期的 Key 调 → 403 `key_expired`
- [ ] 用额度耗尽的 Key 调 → 403 `quota_exceeded_credits`
- [ ] 确认 6379 没有暴露到公网：`ss -tlnp | grep 6379` 应只显示 `127.0.0.1:6379`
- [ ] 用 `valkey-cli -a '<密码>' hgetall relay:user:<某用户id>` 确认 `passwordHash` 是 bcrypt 散列
- [ ] 用 `valkey-cli -a '<密码>' hgetall relay:provider:<某id>` 确认 `encryptedApiKey` 是 base64 密文

---

## 7. 数据备份

RelayAB 的全部状态都在标准 `relay:*` 键的命名空间里，所以备份就是备份 Redis 本身：

```bash
valkey-cli -a '<密码>' --rdb /var/backups/relayab-$(date +%F).rdb
```

建议加一条日备 cron。用量流水属于业务账目，值得单独留档。

从旧的 Upstash 实例迁移时，用同样方式导出 RDB 再导入即可——**无需任何转换**。
存进 Redis 的本来就是普通字符串，Upstash 那个自动 `JSON.parse` 是客户端行为而非数据行为。

> **不存在导出/导入脚本。** 早先版本的文档让你运行 `scripts/export-data.ts` 和
> `scripts/import-data.ts`；这两个文件都不存在。

---

## 8. 故障排查

### 8.1 流式输出卡住，然后一次性全吐
nginx 响应缓冲。确认站点配置里有：
```nginx
proxy_buffering off;
proxy_cache off;
proxy_set_header X-Accel-Buffering no;
proxy_set_header Connection "";
```
改完 `sudo nginx -t && sudo systemctl reload nginx`。

### 8.2 文档页显示 `http://127.0.0.1:3000`
nginx 没转发 `X-Forwarded-Proto` / `X-Forwarded-Host`，或者没设 `RELAY_PUBLIC_URL`。
前者是根因，后者是省事的兜底。

### 8.3 管理台两个文档页显示「读取失败」
systemd 的 `WorkingDirectory` 不在仓库根，或部署时只拷了 `.next`。
`src/components/docs/ProtocolReference.tsx` 和 `SpecCheckReference.tsx`
用 `process.cwd()` 读仓库里的文件，必须保留完整检出。

### 8.4 `/healthz` 报 ok 但接口 500
先看 `storage` 字段。`unconfigured` 说明 `REDIS_URL` 没被读到——检查是不是写成了
`http://` 开头（只有 `redis://` / `rediss://` 才走 TCP），或 `.env.production` 没有被
systemd 加载（`journalctl -u relayab | grep -i env`）。

### 8.5 接口 500，日志里是 Redis 连接错误
```bash
valkey-cli -a '<密码>' ping          # 密码对不对
sudo systemctl status valkey-server  # 服务起来没
```
ioredis 配了 `maxRetriesPerRequest: 3`，Valkey 重启期间的请求会快速失败而不是挂住。

### 8.6 启动即退出
```bash
sudo journalctl -u relayab -n 100 --no-pager
```
最常见是 `.env.production` 路径不对（systemd 要求绝对路径），或 `RELAY_AUTH` 长度不足 8 位。

### 8.7 调用返回 `model_not_mapped`
检查 `/admin/providers` 的 model mapping 是否包含请求的 model，以及 Provider 是否 enabled。

### 8.8 长响应被截断
代理路由设了 `maxDuration = 300`，nginx 侧要 `proxy_read_timeout 600s` 留出余量。

---

## 9. 升级 / 维护

### 9.1 升级
```bash
cd /opt/relayab
git pull
corepack pnpm install --frozen-lockfile
corepack pnpm build
sudo systemctl restart relayab
```

升级后**务必更新 `RELAY_BUILD_ID`**，否则 `/healthz` 的 revision 还是旧值，
你会误以为没升级成功。

### 9.2 主密钥轮换（重要）
1. 生成新主密钥：`openssl rand -hex 32`
2. 运行 `pnpm rotate-key`（把旧密钥以 `OLD_RELAY_MASTER_KEY_HEX` 提供，
   新密钥以 `RELAY_MASTER_KEY_HEX` 提供）
3. 用新主密钥重新加密每个 `relay:provider:*` 的 `encryptedApiKey`
4. 更新 `.env.production` 里的 `RELAY_MASTER_KEY_HEX`
5. `sudo systemctl restart relayab`

> ⚠️ **丢失主密钥 = 永久丢失所有上游 Key** —— 它们以该密钥为种的 AES-256-GCM 密文
> 存储，没有恢复途径。轮换前请备份到安全的地方。

> 改 `RELAY_AUTH` 也会导致同样后果（会失效所有会话）。如果只想轮换上游密钥的加密，
> 请显式设置 `RELAY_MASTER_KEY_HEX`，把两件事解耦。
