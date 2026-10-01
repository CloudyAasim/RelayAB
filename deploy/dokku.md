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
dokku apps:create relay-ab

# 关键：仓库里 Debian 的改动在 server 分支上，不在 main。
# 不设这一条，Dokku 会去找 master，构建的是错误的代码。
dokku git:set relay-ab deploy-branch server
```

## 3. 准备数据库目录

容器里每次构建都会换一层，**数据库文件必须放在挂载卷上**，否则重建即丢。

### 3.1 建目录并挂载

```bash
dokku storage:ensure-directory relay-ab
dokku storage:mount relay-ab /home/dokku/data/relay-ab:/data
```

`app.json` 已经把 `RELAY_DB_PATH` 设成 `/data/relayab.db`，正好落在挂载点上。
**如果不做这一步，重建会得到一个空数据库**（用户和密钥全没了，但主密钥还在，
所以加密后的上游 Key 永久解不开 —— 这一步别省）。

### 3.2 把属主改成容器里应用用户的 uid（必做）

`storage:ensure-directory` 建出来的目录属主是 `dokku` 用户，但 **herokuish
镜像里的应用进程不是以它运行的** —— 实际是 `herokuishuser`（uid 32767）。
两边对不上，于是 SQLite 建库时 `EACCES`，表现为：

- 登录页等静态页面**完全正常**（它们不碰数据库）
- 任何碰数据库的接口 500，Dokku 把它转成
  "Server is not ready. Please try again shortly."
- `/healthz` 报 `"ok": false` 且 `data.error` 是 `unable to open database file`

先问出应用实际的 uid，别硬编码：

```bash
CID=$(docker ps -q --filter name=relay-ab)
APP_UID=$(docker exec $CID id -u)
APP_GID=$(docker exec $CID id -g)

sudo chown -R "$APP_UID:$APP_GID" /home/dokku/data/relay-ab
dokku ps:restart relay-ab
```

确认：

```bash
docker exec $(docker ps -q --filter name=relay-ab) touch /data/probe \
  && echo "可写 ✓" && docker exec $(docker ps -q --filter name=relay-ab) rm /data/probe
```

> **每次重建后都要重新确认一次。** 不同 Dokku/构建镜像版本下
> `herokuishuser` 的 uid 可能不同（32767 是当前 herokuish 的常见值，不是保证），
> 所以脚本里先 `id -u` 读出来再用。
>
> 另一个思路是在建 app 时就固定用户：`dokku apps:create relay-ab --user 1000`，
> 但那只影响新建的 app。

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
- 只有 Dokku 知道，落在 `$DOKKU_LIB_ROOT/config/relay-ab/ENV`，权限 `0600`

> ⚠️ **主密钥丢了 = 所有上游 Provider Key 永久无法解密。** 它们是以该密钥为种
> 的 AES-256-GCM 密文存储的，没有恢复途径。部署完成后立刻把
> `dokku config:get relay-ab RELAY_AUTH` 的值备份到安全的地方。

## 5. 绑域名 + 签证书

Dokku 全局域名只决定**子域名规则**，应用本身还要单独绑定：

```bash
dokku domains:set relay-ab api.aasim.l.cd
```

确保 DNS 的 A 记录已指向这台服务器。签 Let's Encrypt 证书：

```bash
sudo dokku plugin:install https://github.com/dokku/dokku-letsencrypt.git
sudo dokku letsencrypt:enable relay-ab api.aasim.l.cd you@email.com
sudo dokku letsencrypt:cron-job --add
```

没有证书的话 `/healthz` 会返回 http，`RELAY_PUBLIC_URL` 也会被推导成 http，
ONLYOFFICE 那边可能拒绝连接。

顺便打开部署追踪。`/healthz` 的 `revision` 字段默认拿不到值 —— Dokku 不主动
注入 git SHA，得显式告诉它注入到哪个变量名：

```bash
dokku git:set relay-ab rev-env-var DOKKU_GIT_REV
```

`/healthz` 的回退链是 `VERCEL_GIT_COMMIT_SHA` → `DOKKU_GIT_REV` →
`RELAY_BUILD_ID`。这条命令只对**之后的**部署生效，所以改完要再推一次。
在那之前 `revision` 是 `null`，不影响功能，只影响「线上跑的是哪一版」的可追溯性。

## 6. 调 nginx 的两个默认值

Dokku 自带 nginx 有两个默认值**会直接打断这个应用的功能**，装完就改：

| 配置项 | Dokku 默认 | 后果 |
|---|---|---|
| `proxy-read-timeout` | **60s** | 长响应被切成 504。代理路由的 `maxDuration` 是 300 秒 |
| `client-max-body-size` | **1m** | `/v1/images/edits` 收 base64 图片直接 413。应用侧允许 2MB，nginx 先拒 |

```bash
dokku nginx:set relay-ab proxy-read-timeout 600s
dokku nginx:set relay-ab client-max-body-size 10m
dokku proxy:build-config relay-ab
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
| `GIT_REMOTE_URL` | `dokku@<服务器IP>:relay-ab` |
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
dokku ps:report relay-ab          # 容器跑起来了吗
dokku logs relay-ab --tail 100    # 构建/运行日志
ls -la /home/dokku/data/relay-ab  # 数据库文件生成了吗
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
dokku nginx:show-config relay-ab > /tmp/relayab.sigil
# 在 location 块内加：
#   proxy_buffering off;
#   proxy_cache off;
#   proxy_set_header X-Accel-Buffering no;
#   proxy_set_header Connection "";
sed -i 's|proxy_pass |proxy_buffering off;\n        proxy_cache off;\n        proxy_set_header X-Accel-Buffering no;\n        proxy_set_header Connection "";\n        proxy_pass |' /tmp/relayab.sigil
dokku nginx:set relay-ab /tmp/relayab.sigil
dokku nginx:validate-config relay-ab     # 先验证，没写坏再继续
dokku proxy:build-config relay-ab
```

模板是 sigil 语法（`{{ }}` 插值），sed 时不要破坏原有的插值标记。

## 11. 补全服务商配置（新建后必做）

在管理台新建服务商时通常只填了密钥，base URL、模型映射、媒体 spec 都是空的 ——
这样的服务商**不会报错，但一个模型也路由不出去**。

仓库自带补全脚本。聊天侧它**向上游要真实的模型列表**（而不是猜），并把
`src/lib/media/seeds.ts` 里已有的 MiniMax 图片 / 视频 / 语音 / STT spec 装进去。

两侧都会**探测密钥属于哪个区域**（`api.minimax.io` / `api.minimaxi.com` /
旧域名 `api.minimax.cn`）并把 base URL 写成真正能认证的那个 —— MiniMax 的密钥
跨区域不通用，填错主机的话每次请求都会 401，而服务商在管理台里看起来完全正常。

```bash
# 先看会改成什么，不写入
dokku exec relay-ab web.1 pnpm configure-minimax --dry-run

# 确认后执行
dokku exec relay-ab web.1 pnpm configure-minimax
```

多个服务商时用 `--chat <id>` / `--media <id>` 指定。执行完会打印补全后的
模型映射、spec 列表，并**回读上游核对**：媒体侧会真的发一次鉴权请求，
如果 base URL 与密钥区域不匹配会直接报出来，而不是打一个假的 ✓。

> **密钥无效时脚本会拒绝写入**（三个主机全部 401/403 就中止），不会留下一份
> 永远路由不通的假配置。聊天侧和媒体侧都如此，且两侧各用自己的密钥分别探测。

> **`--dry-run` 确实不写库。** 写入是真的执行的（这样预览的就是合并后的真实
> 结果，而不是一份会走样的模拟），但整个过程包在一个必定回滚的事务里。

想先看它长什么样而不碰任何数据：

```bash
pnpm configure-minimax --seed-demo --skip-upstream
```

`--seed-demo` 会在内存库里造两个只有密钥的假服务商再补全，跑完即消失。

## 12. 备份数据库

数据库就是一个文件，备份也是：

```bash
sudo mkdir -p /home/dokku/backups
# 用 sqlite3 的在线备份，不要直接 cp（正在写的时候 cp 可能拿到不一致的快照）
sudo -u dokku sqlite3 /home/dokku/data/relay-ab/relayab.db \
  ".backup '/home/dokku/backups/relayab-$(date +%F).db'"
```

加一条日备 cron。用量流水是业务账目，值得单独留档。

**备份文件里包含加密后的上游 Key —— 它必须和主密钥一起保管。** 主密钥单独存在
别处、数据库单独存在别处，都没有意义；两个都要。

## 常见问题

**登录页正常，但一提交就跳 "Server is not ready. Please try again shortly."**

这是 Dokku 把应用返回的 500 转成的提示页。**静态页面不碰数据库所以照常渲染，
只有真正读写数据的接口在失败** —— 绝大多数情况是数据库目录属主不对，见 §3.2。
先看 `/healthz`：

```bash
curl -s https://你的域名/healthz | jq .data.error
```

报 `unable to open database file` 就是权限或挂载问题：

```bash
CID=$(docker ps -q --filter name=relay-ab)
docker exec $CID sh -c 'touch /data/probe' \
  && echo "可写" || { sudo chown -R $(docker exec $CID id -u):$(docker exec $CID id -g) /home/dokku/data/relay-ab; \
                     dokku ps:restart relay-ab; }
```

如果 `touch` 本来就成功却仍然报错，看应用日志里 SQLite 的具体错误码：
`SQLITE_CANTOPEN` 是路径/权限，`SQLITE_READONLY` 是文件系统只读，
`SQLITE_IOERR` 通常意味着该文件系统不支持 WAL 需要的锁 —— 换挂载点或用
`journal_mode=DELETE`。

**重启后数据没了**

数据库没落在挂载卷上。`dokku storage:mount relay-ab /home/dokku/data/relay-ab:/data`
建好后重启容器再 `ls -la /data/`，文件应该还在。

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
