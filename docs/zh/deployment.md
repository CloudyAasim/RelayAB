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
                                  │  node:sqlite（进程内）
                 ┌────────────────▼─────────────────────────┐
                 │  /var/lib/relayab/relayab.db              │
                 │   users / api_keys / providers            │
                 │   usage_logs / settings / meta            │
                 └──────────────────────────────────────────┘
```

三个要点：

1. **数据库是一个文件，没有监听端口、没有密码、没有服务要守护。** 防火墙不需要为它开任何东西。
2. **nginx 必须关掉响应缓冲**，否则 SSE 流式输出会变成「卡住然后一次性全吐」。
3. **RelayAB 必须从仓库根目录启动**，管理台有两个页面在运行时读仓库里的文件。

---

## 2. 环境变量

**必填 1 个：**

| 名称 | 来源 | 备注 |
|---|---|---|
| `RELAY_AUTH` | 手动：`openssl rand -hex 32` | 主密码，同时承担管理员登录密码 + 会话密钥派生种子 |

**强烈建议：**

| 名称 | 备注 |
|---|---|
| `RELAY_DB_PATH` | 数据库文件路径。不设则默认 `./data/relayab.db`（在工作目录下）。**生产环境应显式指定**，放在发布目录之外，这样 `git pull` 和重新构建都碰不到它 |
| `RELAY_BUILD_ID` | 手动：版本号或 commit sha。显示在 `/healthz` 的 `revision` 字段。不设就没有它（见下方说明） |
| `RELAY_PUBLIC_URL` | 设为 `https://你的域名`。不设时依赖 nginx 转发的 `X-Forwarded-*` 头，能工作但多一层隐式依赖 |
| `NODE_ENV` | `production` |

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

### 3.1 SQLite（自托管默认）

存储就是**一个文件**，由 Node 24 内置的 `node:sqlite` 驱动，没有任何 npm 依赖：

```bash
# 建目录并把数据库放出去（发布目录之外）
sudo mkdir -p /var/lib/relayab
sudo chown relayab:relayab /var/lib/relayab
echo 'RELAY_DB_PATH="/var/lib/relayab/relayab.db"' >> /opt/relayab/.env.production
```

**为什么这样最省事：**

- **没有服务要装。** 不需要 `apt install valkey-server`、不需要 systemd unit、
  不需要端口、不需要密码。少一个监听端口、少一个密码、少一个失败模式。
- **备份就是复制文件**（见 §7），恢复就是复制回去。
- **约束由数据库保证。** 用户名唯一、Key 唯一、删用户连带删 Key，这些以前要在
  应用层小心维护，现在是 `UNIQUE` 和 `ON DELETE CASCADE`。
- 写并发用 WAL + `BEGIN IMMEDIATE` 串行化，`busy_timeout = 5000` 让锁冲突变成短暂
  等待而不是立刻抛 `SQLITE_BUSY`。

代价是单机单文件：没有内置的高可用，也没有网络可访问性——**这是自托管单机的合理
取舍**，但也意味着备份要靠自己（见 §7 和 §10 风险表）。

### 3.2 继续用 Upstash 托管版

代码仍然支持：设置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 即可，
走 HTTP REST 通道。

适合应用与数据库要分开部署、或不想让状态留在本机磁盘的场景。代价是每个 Redis 命令
都是一次 HTTP 请求。**两个变量必须成对设置**——只设一个不会静默回落到本地文件，
`/healthz` 会报 `degraded` 并点名缺哪个。

> 本机 TCP（`REDIS_URL` / `ioredis`）通道**已经随这次迁移一并移除**。旧文档里
> `REDIS_URL` 优先于 Upstash 的说法不再成立，配置它不会有任何效果。

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

期望看到：

```json
{"ok":true,"data":{"status":"ok","storage":"sqlite","env":{"required":1,"configured":1},"revision":"v179"}}
```

注意字段是**嵌套在 `data` 下的**，`required` / `configured` 再嵌一层在 `data.env` 里。

`storage` 字段是这次迁移后新增的，用来确认走的是哪条通道：

| 值 | 含义 |
|---|---|
| `sqlite` | 本地 SQLite 文件（自托管正常情况）。不需要任何配置 |
| `upstash` | 走 REST 通道——**只在你显式设置了 `UPSTASH_REDIS_REST_*` 时才会出现**。没打算用托管版却看到它，说明环境变量被读到了 |
| `memory` | 非生产环境下的默认内存模式，**生产环境不应出现** |

`required` 会跟着 `storage` 走：SQLite 只需要 `RELAY_AUTH`（1 个），Upstash 通道
还需要 URL + token 一对（3 个）。

---

## 5. 真实上游 API Key 接入

1. 登录 RelayAB → **/admin/providers → New Provider**。
2. 填：
   - Name：`OpenAI Production`
   - Kind：`openai`
   - API Key：`sk-...`
   - Model Mapping：`{ "gpt-4o-mini": "gpt-4o-mini-2024-07-18" }`
3. Save。

明文 Key **不会持久化**——RelayAB 用 `RELAY_MASTER_KEY_HEX` 即时加密后写入数据库。

### 走网关型上游

如果需要通过第三方网关（AI Gateway、统一代理等）访问上游，**不需要任何环境变量**：
在 `/admin/providers` 把 API base URL 填成网关地址、上游 key 填成网关的 key 即可，
和其他上游一视同仁。它和普通 Provider 一样会被 AES-256-GCM 加密后存储。

---

## 6. 冒烟测试清单（部署后请逐项打勾）

### 6.1 基础
- [ ] `curl https://你的域名/healthz` 返回 `{"ok":true,...}`，且 `storage` 是 `sqlite`
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
- [ ] 确认数据库文件存在且在发布目录之外：`ls -l /var/lib/relayab/relayab.db`
- [ ] 数据库文件权限收紧（只有服务用户可读）：`chmod 600 /var/lib/relayab/relayab.db`
- [ ] 用 `sqlite3 /var/lib/relayab/relayab.db "SELECT password_hash FROM users LIMIT 1;"` 确认是 bcrypt 散列
- [ ] 用 `sqlite3 /var/lib/relayab/relayab.db "SELECT encrypted_api_key FROM providers LIMIT 1;"` 确认是 base64 密文

---

## 7. 数据备份

全部状态都在一个文件里，所以备份就是复制文件：

```bash
sudo cp /var/lib/relayab/relayab.db /var/backups/relayab-$(date +%F).db
```

WAL 模式下另有 `-wal` / `-shm` 两个附属文件。**运行中直接 `cp` 可能拿到不一致的
快照**，两种稳妥做法：

```bash
# 方案 A：用 sqlite3 的在线备份 API（服务不用停）
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db \
  ".backup /var/backups/relayab-$(date +%F).db"

# 方案 B：停服务再复制
sudo systemctl stop relayab
sudo cp /var/lib/relayab/relayab.db /var/backups/relayab-$(date +%F).db
sudo systemctl start relayab
```

建议加一条日备 cron。用量流水属于业务账目，值得单独留档。

> **不存在导出/导入脚本。** 早先版本的文档让你运行 `scripts/export-data.ts` 和
> `scripts/import-data.ts`；这两个文件都不存在。库文件本身就是完整备份。

### 从旧的 Redis 部署迁移过来

旧版 RelayAB 的数据存在 Redis 键里（`relay:user:*` 那种）。**仓库里没有自动迁移工具**，
两个实用路线：

- **数据量不大、且在意干净起点**：全新启动，在管理台重新添加上游 Provider，用户与
  余额从零开始。
- **必须保留历史数据**：从旧 Redis 实例导出 dump，在一台装了 Redis/Valkey 的机器上
  读出来，按 [data-model.md §1–§4](data-model.md) 的列名逐表写入新的 `.db`。
  注意两侧的形态差异：布尔是 `0/1` 还是 `1/2`、`allowed_models` 是 CSV 还是 JSON 文本、
  时间戳是 epoch 还是 ISO 字符串，都要按目标表的类型转换。这一步没有捷径。

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
先看 `storage` 字段。

- 报 `sqlite` 却 500 → 多半是**数据库文件不可写**：`ls -l` 看权限和属主是不是
  `relayab`，目录 `/var/lib/relayab` 是否存在。
- 报 `upstash` 而你本意是本地文件 → 查环境变量里有没有残留的
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`。
- `missing` 数组点名了变量 → `.env.production` 没被 systemd 加载
  （`journalctl -u relayab | grep -i env`）。

### 8.5 日志里是 SQLite 错误
```bash
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db "PRAGMA integrity_check;"  # 文件损坏？
df -h /var/lib                                          # 磁盘满会报 SQLITE_FULL
sudo journalctl -u relayab -n 100 --no-pager | grep -i sqlite
```

最常见的是 `SQLITE_CANTOPEN`（目录不存在或属主不对）和 `SQLITE_READONLY`
（文件权限没给到服务用户）。`SQLITE_BUSY` 说明有另一个进程占着写锁——
WAL 下 `busy_timeout` 会等 5 秒再报错，所以偶发一次可以先忽略，持续出现要查
是不是跑了两个实例。

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

只要 `RELAY_DB_PATH` 指向 `/opt/relayab` **之外**，`git pull` 和重新构建就碰不到
你的数据——这正是 §3.1 里强调要显式设置它的原因。

### 9.2 主密钥轮换（重要）
1. 生成新主密钥：`openssl rand -hex 32`
2. 运行 `pnpm rotate-key`（把旧密钥以 `OLD_RELAY_MASTER_KEY_HEX` 提供，
   新密钥以 `RELAY_MASTER_KEY_HEX` 提供）
3. 用新主密钥重新加密 `providers` 表里每一行的 `encrypted_api_key`
4. 更新 `.env.production` 里的 `RELAY_MASTER_KEY_HEX`
5. `sudo systemctl restart relayab`

> ⚠️ **丢失主密钥 = 永久丢失所有上游 Key** —— 它们以该密钥为种的 AES-256-GCM 密文
> 存储，没有恢复途径。轮换前请备份到安全的地方。

> 改 `RELAY_AUTH` 也会导致同样后果（会失效所有会话）。如果只想轮换上游密钥的加密，
> 请显式设置 `RELAY_MASTER_KEY_HEX`，把两件事解耦。
