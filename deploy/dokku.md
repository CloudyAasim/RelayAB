# RelayAB — Dokku 部署

Dokku 是一个单机的自托管 PaaS：它接管 Docker、nginx 路由和 SSH 部署，
应用以容器方式运行。这份文档覆盖 Dokku 路线；原生（systemd + nginx）路线见
[`README.md`](./README.md)。两条路线互不依赖。

**数据库不需要任何服务。** RelayAB 用 Node 24 内置的 `node:sqlite`，
数据库就是一个文件 —— 没有 Redis/Valkey，没有端口，没有密码，
备份就是复制文件。

---

## 1. 服务器前提

- Debian 11+（Dokku 官方支持范围），amd64 或 arm64
- **≥ 1GB 内存** —— Docker 调度器的最低要求
- 已装好 Dokku 并配好全局域名：

```bash
dokku version
dokku domains:set-global aasim.l.cd
```

## 2. 建 app 并设定部署分支

```bash
dokku apps:create relayab

# 关键：仓库里 Debian 的改动在 server 分支上，不在 main。
# 不设这一条，Dokku 会去找 master，构建的是错误的代码。
dokku git:set relayab deploy-branch server
```

## 3. 准备数据库目录

容器里每次构建都会换一层，**数据库文件必须放在挂载卷上**，否则重建即丢：

```bash
sudo mkdir -p /home/dokku/data/relayab
sudo chown -R dokku:dokku /home/dokku/data/relayab
dokku storage:ensure-directory relayab
dokku storage:mount relayab /home/dokku/data/relayab:/data
```

`app.json` 已经把 `RELAY_DB_PATH` 设成 `/data/relayab.db`，正好落在挂载点上。
**如果不做这一步，重建会得到一个空数据库**（用户和密钥全没了，但主密钥还在，
所以加密后的上游 Key 永久解不开 —— 这一步别省）。

## 4. 密钥是怎么来的

`app.json`（仓库根目录）声明了 `RELAY_AUTH` 用 `"generator": "secret"`：

```json
"RELAY_AUTH": { "generator": "secret" }
```

Dokku 会在**首次部署时自动生成一个 64 字符的加密安全随机十六进制串**。
所以这个主密钥：

- 不需要你手写，不会进 shell 历史
- 不需要复制到密码管理器、备忘录、聊天窗口
- 不需要放进 GitHub Secrets
- 只有 Dokku 知道，落在 `$DOKKU_LIB_ROOT/config/relayab/ENV`，权限 `0600`

> ⚠️ **主密钥丢了 = 所有上游 Provider Key 永久无法解密。** 它们是以该密钥为种
> 的 AES-256-GCM 密文存储的，没有恢复途径。部署完成后立刻把
> `dokku config:get relayab RELAY_AUTH` 的值备份到安全的地方。

## 5. 绑域名 + 签证书

Dokku 全局域名只决定**子域名规则**，应用本身还要单独绑定：

```bash
dokku domains:set relayab api.aasim.l.cd
```

确保 DNS 的 A 记录已指向这台服务器。签 Let's Encrypt 证书：

```bash
sudo dokku plugin:install https://github.com/dokku/dokku-letsencrypt.git
sudo dokku letsencrypt:enable relayab api.aasim.l.cd you@email.com
sudo dokku letsencrypt:cron-job --add
```

没有证书的话 `/healthz` 会返回 http，`RELAY_PUBLIC_URL` 也会被推导成 http，
ONLYOFFICE 那边可能拒绝连接。

## 6. 调 nginx 的两个默认值

Dokku 自带 nginx 有两个默认值**会直接打断这个应用的功能**，装完就改：

| 配置项 | Dokku 默认 | 后果 |
|---|---|---|
| `proxy-read-timeout` | **60s** | 长响应被切成 504。代理路由的 `maxDuration` 是 300 秒 |
| `client-max-body-size` | **1m** | `/v1/images/edits` 收 base64 图片直接 413。应用侧允许 2MB，nginx 先拒 |

```bash
dokku nginx:set relayab proxy-read-timeout 600s
dokku nginx:set relayab client-max-body-size 10m
dokku proxy:build-config relayab
```

**第三个问题：`proxy_buffering` 没有 `nginx:set` 选项**，nginx 默认是 `on`，
会让 SSE 流式输出变成「卡住然后一次性全吐」。等第一次真机部署后实测一下
（见 §9），不正常再改 —— 改它要手写 sigil 模板，先别提前动。

## 7. 挂上自动部署

```bash
ssh-keygen -t ed25519 -C "relayab-dokku-deploy" -N ""
cat ~/.ssh/id_ed25519.pub
```

把公钥内容填到 GitHub 仓库 **Settings → Secrets and variables → Actions**：

| Secret | 内容 |
|---|---|
| `GIT_REMOTE_URL` | `dokku@<服务器IP>:relayab` |
| `SSH_PRIVATE_KEY` | `~/.ssh/id_ed25519` **私钥全文**（含 `-----BEGIN...` 和 `-----END...`） |

```powershell
# 本地
git add -A
git commit -m "v179 commit" -m "Switch persistence from Redis to built-in SQLite"
git push origin server
```

`server` 分支的每次 push 都会触发 [`deploy.yml`](../../.github/workflows/deploy.yml)。

## 8. 看部署结果

```bash
dokku ps:report relayab          # 容器跑起来了吗
dokku logs relayab --tail 100    # 构建/运行日志
ls -la /home/dokku/data/relayab  # 数据库文件生成了吗
```

或本地用 GitHub CLI：

```powershell
gh run list --repo CloudyAasim/RelayAB
gh run watch
```

## 9. 部署后必须确认的三件事

```bash
curl -s https://api.aasim.l.cd/healthz
```

```json
{"ok":true,"data":{"status":"ok","storage":"sqlite","env":{"required":1,"configured":1},"revision":"abc1234"}}
```

| 字段 | 期望 | 不对说明什么 |
|---|---|---|
| `storage` | `sqlite` | 若是 `memory`，说明 `NODE_ENV` 没生效，**重启即丢数据** |
| `revision` | 有值 | Dokku 自动注入 `DOKKU_GIT_REV`，为空说明部署追踪断了 |

**第三件事：实测流式输出。**

```bash
curl -N -X POST https://api.aasim.l.cd/v1/chat/completions \
  -H "Authorization: Bearer sk-relay-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","stream":true,"messages":[{"role":"user","content":"数到20"}]}'
```

必须逐字返回。**如果卡住不动、最后一次性全吐，就是 nginx 在缓冲响应**，
需要关掉 `proxy_buffering`：

```bash
dokku nginx:show-config relayab > /tmp/relayab.sigil
# 在 location 块内加：
#   proxy_buffering off;
#   proxy_cache off;
#   proxy_set_header X-Accel-Buffering no;
#   proxy_set_header Connection "";
sed -i 's|proxy_pass |proxy_buffering off;\n        proxy_cache off;\n        proxy_set_header X-Accel-Buffering no;\n        proxy_set_header Connection "";\n        proxy_pass |' /tmp/relayab.sigil
dokku nginx:set relayab /tmp/relayab.sigil
dokku nginx:validate-config relayab     # 先验证，没写坏再继续
dokku proxy:build-config relayab
```

模板是 sigil 语法（`{{ }}` 插值），sed 时不要破坏原有的插值标记。

## 10. 备份数据库

数据库就是一个文件，备份也是：

```bash
sudo mkdir -p /home/dokku/backups
# 用 sqlite3 的在线备份，不要直接 cp（正在写的时候 cp 可能拿到不一致的快照）
sudo -u dokku sqlite3 /home/dokku/data/relayab/relayab.db \
  ".backup '/home/dokku/backups/relayab-$(date +%F).db'"
```

加一条日备 cron。用量流水是业务账目，值得单独留档。

**备份文件里包含加密后的上游 Key —— 它必须和主密钥一起保管。** 主密钥单独存在
别处、数据库单独存在别处，都没有意义；两个都要。

## 常见问题

**构建报找不到 pnpm**
`package.json` 的 `packageManager: "pnpm@10.28.0"` 决定 buildpack 装哪个 pnpm。
`Procfile` 里必须写 `pnpm start`。

**Node 版本不对**
`package.json` 的 `engines.node: ">=24 <25"` 决定 buildpack 用哪个 Node。
Node 24 才内置 `node:sqlite`，版本不够会直接报模块找不到。

**部署完数据库是空的**
`storage:mount` 没做。容器每次构建换一层，没挂载的话重建就丢。

**管理台两个文档页显示"读取失败"**
那两页在运行时从仓库读 `docs/模型适配协议/README.md` 和 `scripts/spec-check.ts`。
Dokku 的 slug 包含完整的裁剪后源码树（只移除 devDependencies），文件本来会在。
如果还是失败，检查是不是用了 `.slugignore` 把它们排掉了。

**Debian 12 升级到 13**
Debian 13 (trixie) 官方源内置 Valkey。但既然用的是 SQLite，**不需要装**。
