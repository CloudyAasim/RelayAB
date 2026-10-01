# RelayAB — Debian 自托管部署

从 Vercel Serverless 迁到一台自己的 Debian 机器。本文只覆盖部署，应用侧的
适配改动在 `server` 分支的代码里。

## 前置

- Debian 13 (trixie)（Debian 12 也能用，见下方 Valkey 说明）
- 一个 A 记录指向服务器公网 IP 的域名
- Node.js 24、pnpm 10

```bash
sudo apt install -y nodejs npm
sudo npm install -g corepack
corepack enable
```

## 1. 装 Valkey

Debian 13 官方源自带 valkey-server，直接装即可：

```bash
sudo apt install -y valkey-server valkey-tools
```

> Debian 12 上 Valkey 只在 bookworm-backports 里；直接 `apt install
> valkey-server`，或改用 `redis-server`（Redis 协议完全兼容，ioredis
> 无需任何改动），或用官方 Docker 镜像。

把 [`valkey.conf.example`](./valkey.conf.example) 里的关键项合并进
`/etc/valkey/valkey.conf`。其中 **`maxmemory-policy noeviction` 必须确认** ——
RelayAB 存的余额、配额和用量流水是权威数据，配成 `allkeys-lru` 会静默丢记录。

```bash
sudo systemctl enable --now valkey-server
valkey-cli -a '<密码>' ping    # 期望 PONG
```

## 2. 放代码

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

## 3. 环境变量

```bash
cd /opt/relayab
sudo -u relayab cp deploy/env.production.example .env.production
sudo -u relayab openssl rand -hex 32          # 填入 RELAY_AUTH
sudo -u relayab chmod 600 .env.production
```

至少要设三项：`RELAY_AUTH`、`REDIS_URL`、`RELAY_BUILD_ID`。

## 4. systemd

```bash
sudo cp deploy/relayab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relayab
sudo systemctl status relayab
curl -s localhost:3000/healthz | jq
```

`/healthz` 的 `revision` 字段应显示 `RELAY_BUILD_ID` 的值。**每次发布都要更新
它** —— 自托管环境没有 `VERCEL_GIT_COMMIT_SHA`，这个字段是你判断「线上跑的
到底是哪一版」的唯一依据。

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

只开 80/443。**6379 绝不能暴露到公网**（Valkey 已限制监听 127.0.0.1，这里是
第二道保险）：

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

## 8. 从 Upstash 迁移历史数据（可选）

存进 Redis 的本来就是普通字符串 —— Upstash 那个自动 `JSON.parse` 是**客户端
行为，不是数据行为**。所以导出后直接导入即可，不需要任何转换：

```bash
# 从 Upstash 导出（在有凭据的机器上）
upstash_redis_url=... upstash_redis_token=... \
  redis-cli --u "rediss://default:<token>@<host>" --rdb /tmp/dump.rdb

# 导入到本机
sudo systemctl stop valkey-server
sudo cp /tmp/dump.rdb /var/lib/valkey/dump.rdb
sudo chown valkey:valkey /var/lib/valkey/dump.rdb
sudo systemctl start valkey-server
valkey-cli -a '<密码>' dbsize
```

> 数据量不大时，更省事的做法是全新启动后用管理台重新添加上游提供商 ——
> 用户、密钥、余额这些从零开始反而干净。

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
先确认 `/healthz` 的 `storage` 字段。若为 `upstash` 而你以为配了
`REDIS_URL`，检查是否写成了 `http://` 开头的值 —— 只有 `redis://` 和
`rediss://` 会走 TCP 通道。

**Valkey 连不上**
`bind 127.0.0.1` 下确认密码正确：`valkey-cli -a '<密码>' ping`。
