# RelayAB — Debian 自托管部署

从 Vercel Serverless 迁到一台自己的 Debian 机器。本文只覆盖部署，应用侧的
适配改动在 `server` 分支的代码里。

## 两种路线，先选一条

| 路线 | 文档 | 适合 |
|---|---|---|
| **原生** | 本文 | 想完全掌控进程：systemd + nginx |
| **Dokku** | [`dokku.md`](./dokku.md) | 想要单机 PaaS：Docker + 托管 nginx + SSH 部署 + CI 自动发布 |

**两条路线都不需要数据库服务。** RelayAB 用 Node 24 内置的 `node:sqlite`，
数据库就是一个文件 —— 没有 Redis/Valkey、没有端口、没有密码，备份就是复制文件。
**没有特殊偏好就选原生** —— 组件更少，出问题时能查的地方更直接。

---

## 前置

- Debian 11+（Node 24 对系统没有特别要求）
- 一个 A 记录指向服务器公网 IP 的域名
- **Node.js 24** —— `node:sqlite` 是 Node 24 内置的，版本不够会直接报模块找不到

```bash
sudo apt install -y nodejs npm
sudo npm install -g corepack
corepack enable
node -v        # 必须是 v24.x
```

## 1. 放代码

```bash
sudo useradd -r -m -d /opt/relayab -s /usr/sbin/nologin relayab
sudo -u relayab git clone <repo> /opt/relayab
cd /opt/relayab
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

> 必须保留完整的仓库检出，不能只拷 `.next`。`src/components/docs/`
> 下两个组件在请求时用 `node:fs` 从 `process.cwd()` 读
> `docs/模型适配协议/README.md` 和 `scripts/spec-check.ts`。

## 2. 数据库目录

SQLite 不需要服务，但**文件要放在发布目录之外**，否则 `git pull` 和重新构建
可能碰到它：

```bash
sudo mkdir -p /var/lib/relayab
sudo chown relayab:relayab /var/lib/relayab
```

## 3. 环境变量

```bash
cd /opt/relayab
sudo -u relayab cp deploy/env.production.example .env.production
sudo -u relayab openssl rand -hex 32          # 填入 RELAY_AUTH
sudo -u relayab chmod 600 .env.production
```

至少要设两项：`RELAY_AUTH` 和 `RELAY_DB_PATH`。数据库本身不需要任何密码。

## 4. systemd

```bash
sudo cp deploy/relayab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relayab
sudo systemctl status relayab
curl -s localhost:3000/healthz | jq
```

`/healthz` 的 `storage` 应该是 `sqlite`，`revision` 显示 `RELAY_BUILD_ID` 的值。
**每次发布都要更新 `RELAY_BUILD_ID`** —— 这个字段是你判断「线上跑的到底是哪一版」
的唯一依据。

## 5. nginx + TLS

```bash
sudo apt install -y nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/relayab
sudo ln -s /etc/nginx/sites-available/relayab /etc/nginx/sites-enabled/relayab
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.aasim.l.cd
```

改完 `server_name` 和证书路径。

## 6. 防火墙

只开 80/443。**没有数据库端口要挡** —— 这是选 SQLite 最大的运维收益：
少一个监听端口、少一个密码、少一个失败模式。

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

## 7. 切 DNS

先把本地 hosts 指到新服务器，用真实域名完整验一遍再改正式解析：

```bash
# 在自己机器上
echo "<服务器IP> api.aasim.l.cd" >> /etc/hosts
bash 上下文/verify-cloud.sh
RELAY_KEY=sk-relay-xxx node 上下文/oo-parse-check.mjs
```

确认无误后再改 A 记录，TTL 提前调小（建议 300）以便快速回滚。

## 8. 从旧的 Vercel / Redis 部署迁移数据（可选）

仓库里**没有自动迁移工具**。两个实用路线：

**A. 干净起点（多数情况够用）**
全新启动，然后到管理台重新添加上游 Provider。用户、密钥、余额从零开始，
反而没有历史包袱 —— 而且旧余额本来就是 0.001 积分单位的内部表示，
手工搬容易搬错。

**B. 必须保留历史数据**
从旧实例导出，再按 [../docs/zh/data-model.md](../docs/zh/data-model.md) 的列名
逐表写入新的 `.db`。两侧形态不同，逐项核对：

| 旧（Redis） | 新（SQLite） |
|---|---|
| Hash 里字段是字符串 | 列有类型：整数列必须是整数 |
| 布尔存 `1` / `2` | 布尔存 `1` / `0` |
| `allowedModels` 是 CSV | `allowed_models` 是 JSON 数组文本 `'["a","b"]'` |
| 时间戳是 epoch 毫秒 | 时间戳是 ISO 字符串 `'2026-09-21T08:00:00.000Z'` |
| `relay:user:by-username:*` 反查索引 | 不需要，`username` 自带 UNIQUE |
| `relay:apikey:hash:*` 反查索引 | 不需要，`key_hash` 自带 UNIQUE |

写完先验证再上线：

```bash
sudo systemctl stop relayab
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db "PRAGMA integrity_check;"
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db "SELECT count(*) FROM users;"
sudo systemctl start relayab
curl -s localhost:3000/healthz | jq   # storage 应为 sqlite
```

## 常见问题

**流式输出卡住不动，然后一次性全部吐出**
nginx 缓冲。确认 `proxy_buffering off` 和 `proxy_set_header
X-Accel-Buffering no` 都在（见 `nginx.conf`）。

**管理台两个文档页显示"读取失败"**
systemd 的 `WorkingDirectory` 不在仓库根，或部署时只拷了 `.next`。

**文档页和 `/healthz` 显示 `http://127.0.0.1:3000`**
nginx 没转发 `X-Forwarded-Proto` / `X-Forwarded-Host`，或者没设
`RELAY_PUBLIC_URL`。

**`/healthz` 报 ok 但接口 500**
先确认 `/healthz` 的 `storage` 字段。报 `sqlite` 却 500，通常是**数据库文件
不可写**：检查 `/var/lib/relayab` 是否存在、文件与目录属主是不是 `relayab`。

**日志里是 `SQLITE_CANTOPEN` / `SQLITE_READONLY`**
目录不存在或属主不对。见第 2 节的 `mkdir -p` 与 `chown`。
`/var/lib/relayab` 要对服务用户可写，数据库文件本身建议 `chmod 600`。

**日志里是 `SQLITE_BUSY`**
另一个进程占着写锁。WAL 下 `busy_timeout` 会等 5 秒再报错，偶发一次可以忽略；
持续出现说明你可能同时跑着两个实例。

**忘了 RELAY_AUTH**
管理员密码就是 `RELAY_AUTH` 的值。忘了就用
`pnpm reset-password --username admin` 重置。

**想看数据库里现在有什么**
```bash
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db ".tables"
sudo -u relayab sqlite3 /var/lib/relayab/relayab.db "SELECT username, quota_used, quota_limit FROM users;"
```
