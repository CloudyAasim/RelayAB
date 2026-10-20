# 搜索适配协议（网页搜索 · specVersion 1）

> 新增或调整 **搜索后端** 时，只改后台里的 JSON，**不改代码、不重新部署**。
>
> 后台路径：`/admin/search`　协议全文：本文　示例模板：后台表单里的模板按钮

**这个协议只有一个版本（`specVersion: 1`）——这是第一个也是唯一的版本。** 没有分支版本、没有厂商专用字段。

它和[媒体适配协议](../模型适配协议/README.md)是同一套写法：同样的路径语法、同样的模板语法、同样的「不认识的字段一律报错」原则。媒体那边能贴一份 JSON 就接一个厂商，搜索这边现在也能。

---

## 0. 给 AI 的操作说明

> **如果你在配搜索后端：读 §0 就够了——§0.3 是引擎的精确语义，§0.4 是完整契约表。** §1–§7 是给人看的详细解释和排查手册，拿不准再回来查。
> **不要跳过 §0.2 的翻译流程**——历史上所有线上事故都出在漏抄厂商文档的某一项（参数名、字段名、状态码）。

### 0.1 你要产出什么

**一个 JSON 对象**，就是一份 spec：

```json
{
  "specVersion": 1,
  "displayName": "Tavily",
  "vendor": "tavily",
  "baseUrl": "https://api.tavily.com",
  "transport": {
    "method": "POST",
    "path": "/search",
    "headers": { "content-type": "application/json" },
    "body": {
      "query": "$.query",
      "max_results": "$.limit",
      "search_depth": "basic"
    }
  },
  "auth": { "type": "bearer" },
  "response": {
    "items": "$.results",
    "fields": {
      "title": "$.title",
      "url": "$.url",
      "snippet": "$.content"
    }
  },
  "limits": { "timeoutMs": 15000 }
}
```

放进后台「搜索提供商」表单的 **协议（spec）** 框里保存即可。

### 0.2 翻译流程（照着厂商文档做，别凭印象）

1. **读厂商的搜索接口文档**，确认三件事：
   - **端点**：方法（GET/POST）+ 路径（相对服务根地址，例如 `/search`）；
   - **参数**：查询词叫什么（`q`？`query`？）、条数叫什么、在 query string 里还是在 body 里；
   - **结果**：结果数组在返回 JSON 的哪一层（`$.results`？`$.web.results`？），标题/网址/摘要三个字段分别叫什么。
2. **按 §0.4 的字段表把厂商的名字换成协议里的名字**。
3. **逐条核对**：路径少一段就 404，参数名写错就静默返回 0 条。
4. **先套模板**：SearXNG / Tavily / Brave 已经有内置模板，套上去改，比从零写稳。

> 厂商文档里的**默认值不要抄进 spec**。厂商会改默认值，抄进来就等于把「跟随厂商」变成「永远用这个旧值」。
> 厂商文档里的**枚举值也不等于真实可用**——要保留映射，让失败显式暴露（删掉一个枚举值会让它回落到别的档，那比 400 更难查）。

### 0.3 引擎的精确语义

**值的三种写法**（`transport.query` / `transport.body` 里的每个值）：

| 写法 | 含义 |
| --- | --- |
| `"$.query"` / `"$.limit"` | 取作用域里的值。**保留类型**：`$.limit` 是数字 `6`，不是字符串 `"6"`。 |
| `"{{$.query}}"` | 模板替换。**整个值就是一个占位符时同样保留类型**（`"{{$.limit}}"` 是数字 `6`）；前后还带别的文字时结果是字符串。 |
| 其它 | 字面量，原样发出去。 |

作用域只有两个值：`$.query`（搜索词，字符串）和 `$.limit`（要几条结果，数字）。
**只能用这两个**——写了第三个，保存时就报错，不会等到请求时才发出去一个 `{{$.foo}}` 给厂商。

> **嵌套的键也会被替换。** `body` 里的对象和数组会被逐层解析，所以
> `{"opts": {"q": "{{$.query}}"}}` 里的查询词真的会发出去 —— 而不是把
> `{{$.query}}` 这七个字符原样寄给厂商。

**请求怎么发出去**：

```
URL      = <服务根地址，去掉尾部斜杠> + <transport.path>
           （transport.path 为空时，URL 就是地址本身，一个字符都不加）
method   = transport.method
query    = transport.query 里的每一项，按写下来的顺序拼到 URL 上
body     = transport.body（POST 才有），序列化成 JSON
```

- **服务根地址**只有一个意思：`https://api.tavily.com` 这种「服务根」，不是完整端点。端点路径写在 `transport.path` 里。
- **路径是「加上去」的，不是「换掉」的**：地址 `https://api.example.com/v1` + 路径 `/search` = `https://api.example.com/v1/search`。
  地址里带不带前缀都没关系，前缀会留着。
- **`transport.path` 写空字符串**表示「地址就是完整端点」：你填什么就请求什么，不加任何东西。
  协议之前写的 Tavily / Brave 记录就是按这个意思读的（它们的地址存的是完整端点），
  助手设置里的「用自己的搜索服务」也是这个意思。
- **地址里不能带 `?query` 或 `#fragment`**：`https://host?x=1` 加上 `/search` 会变成
  `https://host?x=1/search`，端点被吞掉，所以保存时就报错。
- **鉴权**（`auth`）：
  - `bearer` → 请求头 `authorization: <prefix><密钥>`，`prefix` 默认 `Bearer `（带一个空格）。
  - `header` → 请求头 `<name>: <prefix><密钥>`，`prefix` 默认空。
  - `query` → 查询参数 `<name>=<prefix><密钥>`。
  - `none` → 不带凭据。
  - **没有密钥就一个都不发**——不会发一个空的请求头。`auth.required` 默认 `true`（没有密钥就是配错了，保存时直接报错）；自建实例不需要密钥就写 `"required": false`。
- **POST 的 content-type** 默认 `application/json`，spec 里写了 `headers` 就以 spec 为准。

**结果怎么读出来**：

```
items   = response.items 指向的数组
每一条：title = response.fields.title，url = response.fields.url，snippet = response.fields.snippet
```

- **URL 不合格的条目直接丢掉**：`javascript:`、`file://`、空地址、带账号密码的地址、相对地址。剩下的条目按 URL 去重，保留厂商给的顺序。
- 标题和摘要里的 HTML 标签会被去掉，实体（`&amp;` 之类）会解码，长度分别截到 200 / 320 字符。
- **`response.fields` 的某个字段可以写成 `{"$firstPresent": ["$.content", "$.snippet"]}`**：取第一个厂商真的填了的。厂商对「摘要」这个字段的名字不统一（`content` / `snippet` / `description`），用这个写法就不必猜。

### 0.4 完整契约表

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `specVersion` | number | ✅ | 必须是 `1`。 |
| `displayName` | string | | 给人看的名字。 |
| `vendor` | string | | 厂商标签，会写进用量统计。 |
| `baseUrl` | string | | 服务根地址，http(s)。**记录里填的地址优先于这个。** |
| `transport.method` | `"GET"` \| `"POST"` | ✅ | |
| `transport.path` | string | ✅ | 相对服务根地址，必须以 `/` 开头；**空字符串**表示地址就是完整端点。 |
| `transport.headers` | object | | 固定请求头。**不要把密钥写在这里** —— 密钥走 `auth`。 |
| `transport.query` | object | | 查询参数。值是路径 / 模板 / 字面量。 |
| `transport.body` | object | | JSON body。**只有 POST 能有。** |
| `auth.type` | `"bearer"` \| `"header"` \| `"query"` \| `"none"` | | 不写就是不带凭据。 |
| `auth.name` | string | | `header` / `query` 时必填：请求头名或参数名。 |
| `auth.prefix` | string | | 密钥前面加什么。`bearer` 默认 `Bearer `。 |
| `auth.required` | boolean | | 默认 `true`。`false` 表示没密钥也照发。 |
| `response.items` | string | ✅ | 结果数组的路径，如 `$.results`、`$.web.results`。 |
| `response.fields.title` | 路径 或 `$firstPresent` | ✅ | |
| `response.fields.url` | 路径 或 `$firstPresent` | ✅ | |
| `response.fields.snippet` | 路径 或 `$firstPresent` | ✅ | |
| `limits.timeoutMs` | number | | 请求超时，1–600000，默认 15000。 |
| `limits.maxResults` | number | | 厂商能接受的最大条数，1–100。**会真的生效**：请求条数被它压住（发给厂商的条数也是压过之后的那个数）。 |

**路径的写法**：`$` 开头，`.` 分层，`[0]` 这种**只认数字下标**。`$.web.results` 读得到，`$.web.results[0].title` 也读得到；`$.web.*` 读不到。

---

## 1. 为什么有这份协议

搜索后端以前是三段手写代码（`src/lib/assistant/web-search.ts`）：SearXNG、Tavily、Brave，各有一套拼请求和读结果的办法。

带来的问题都是同一个形状的：

- **加一个厂商要改代码、要重新部署。** 媒体服务商那边贴一份 JSON 就能接一个，搜索这边不行。
- **厂商自己的能力够不着。** Tavily 的 `search_depth`、Brave 的 `country` / `freshness` / `safesearch`、SearXNG 的 `engines` / `categories` 全都写死在代码里，运营商想改一个参数就得改代码。
- **同一个字段名有不同意思。** 地址这一列，Tavily / Brave 存的是**完整端点**，SearXNG 存的是**服务根地址**（后面还要拼 `/search`）。填错没有任何东西拦得住，只在发请求时才发现。
- **语言写死成中文。** `language=zh-CN` / `search_lang=zh-hans` 写在代码里，英文检索和内容策略都改不了。

现在这些全是 spec 里的字段。

## 2. 地址只有一个意思

**服务根地址**。`https://api.tavily.com` 是一种，`http://relay-search.web:8080` 是另一种，`https://api.search.brave.com` 是第三种。端点路径写在 `transport.path` 里。

后台表单会在地址下面直接显示**最终生效的地址**（根地址 + 路径），不用自己推。

> **唯一的例外**：`transport.path` 写空字符串时，地址就是完整端点，一个字符都不加。
> 协议之前写的 Tavily / Brave 记录就是这个意思（它们存的地址本来就是完整端点），
> 助手里「用自己的搜索服务」也是这个意思。

> **老记录怎么办**：协议之前写的记录，地址仍按老规则解释（Tavily / Brave 当作完整端点，SearXNG 当作服务根地址），**一个请求都不会变**。
> 想换成新规则，在表单里点一次模板名即可 —— 那会把协议和地址一起写成新的语义。

## 3. 校验：保存时就报错

这份协议**不认识的字段一律报错**，每一层都是：

- 顶层多一个键 → `spec.respones: unknown field (typo?)`
- `transport` 里多一个键 → `transport.contntType: unknown field (typo?)`
- 路径写错 → `response.items: "$.result" is not a path …`
- 用了第三个占位符 → `{{$.page}}: unknown placeholder …`
- 没有任何参数带 `$.query` → `transport: no parameter carries $.query …`
- POST 带了 body 之外的 GET 参数 → 报错

**为什么这么严**：一个被静默忽略的拼写错误，比一个当场报错的拼写错误贵得多 —— 前者让运维以为设置生效了，其实没有。媒体协议因为同样的原因走过这条路，这里不重复。

## 4. 内置模板

| id | 名称 | 说明 |
| --- | --- | --- |
| `searxng` | SearXNG | 自建/自托管实例，需要在实例配置里开启 JSON 输出。 |
| `tavily` | Tavily | 官方 API，结果偏向给大模型用。 |
| `brave` | Brave Search | 官方搜索 API。 |
| `openai-compatible` | OpenAI 兼容搜索 | 任何说 OpenAI 兼容搜索形状的接口：**地址就是完整端点**（`path` 是空的），POST + Bearer，`{query, limit}` 进、`{results:[{title,url,snippet}]}` 出。指向另一个 RelayAB 实例的 `/v1/search` 也用这个。 |

模板里的参数就是**以前代码里写死的那些**（中文优先的语言、当前的 `search_depth`、当前的 `safesearch`）—— 升级不会悄悄改变任何一次检索的结果。它们是**可改的**，这才是重点；它们**不是新的**。

后台列表里会显示每条记录与模板的差异（`templateDrift`）。差异是**模板变了而已**，不代表哪边对：**已存的协议可能比模板更对**（本地修正）。所以要改就按差异列出的路径逐条改，不要整份套用。

## 5. 怎么验一份协议

1. **保存时**：协议校验器会跑一遍，不合法直接拒绝，错误逐条列出。
2. **后台「测试」按钮**：拿这个后端真发一次查询，**按真实价格计费、写用量**（和 `/v1/search` 同一个结算路径），停用状态下也能测。
   测试是一次真的搜索：厂商照样收钱，所以账号照样付钱 —— 不计费的测试是在白嫖厂商的付费 API，
   而这笔账只会在厂商的发票上出现。**失败的搜索不扣费**（没拿到东西就没有可计费的东西）。
   账号余额不够时直接被拒（429），请求**不会**发到厂商。
3. **判官脚本**：`pnpm search-spec-check <file.json>`，离线跑，不联网。

## 6. 排查

| 现象 | 多半是 |
| --- | --- |
| 报 `upstream returned HTTP 401/403` | 密钥错了、没启用，或填到了别的厂商那一行。 |
| 报 `upstream returned HTTP 404` | `transport.path` 少了一段或多了一段。 |
| 返回 200 但一条结果都没有 | `response.items` 指错了地方（数组在 `$.web.results` 而不是 `$.results`），或者 `$.query` 根本没发出去。 |
| 结果的标题/摘要全是空的 | `response.fields` 里的字段名和厂商对不上。 |
| 每次搜索都超时 | 厂商慢，或者 `limits.timeoutMs` 太小。 |
| 中文检索正常、英文检索很糟 | `language` / `search_lang` 还是模板里的中文值。 |
| 换了厂商就不行了 | `auth.type` 和厂商实际要凭据的方式对不上（`bearer` vs `header`）。 |

## 7. 自查表

写完一份协议，提交前逐条过一遍：

- [ ] 端点的方法和路径**逐字符对照过**厂商文档？（路径拼接错一段就 404）
- [ ] 查询词参数的名字**逐字符对照过**？（写错了不会报错，只会返回 0 条）
- [ ] 结果数组的路径**逐字符对照过**？（`$.results` 和 `$.web.results` 差一个层级）
- [ ] 标题 / 网址 / 摘要三个字段名都核对过？
- [ ] 鉴权方式和厂商文档一致？（`bearer` 还是 `header`？请求头叫什么？）
- [ ] 没有把密钥写进 `transport.headers`？
- [ ] 厂商文档里的默认值**没有**抄进 spec？
- [ ] 每一层都没有多余的键？（多一个键就是一次报错）
- [ ] 至少有一个参数带 `$.query`？
