# 模型适配协议（媒体能力 · specVersion 2）

> 新增或调整 **图片 / 视频 / 语音 / 音乐** 供应商时，只改后台里的 JSON，**不改代码、不重新部署**。
>
> 后台路径：`/admin/media-providers`　协议全文：本文　示例模板：后台的「导入模板」按钮

**本协议只有一个版本（`specVersion: 2`）。** 没有分支版本、没有厂商专用字段。
下面 §2 会说明它是怎么被反复实测出来的，以及每个字段为什么长这样。

---

## 0. 给 AI 的操作说明

> **如果你在写 spec：读 §0 就够了——§0.3 是引擎的精确语义，§0.4 是完整契约表。** §1–§18 是给人看的详细解释和排查手册，
> 拿不准时再回来查。**不要跳过 §0.2 的翻译流程**——历史上所有线上事故都出在漏抄厂商文档的
> 某一项（必填参数、状态码、状态枚举）。

### 0.1 你要产出什么

**两个独立的 JSON 块**，顺序固定，对应后台上下两个输入框：

````text
【第一块：models —— 扁平对象，key 是客户端模型名】
{ "minimax-image-01": { "upstreamId": "image-01", "pricePerItem": 100, "enabled": true } }

【第二块：specs —— 一个平铺数组，6 份 spec 就是 6 个元素】
[ { "capability": "image.generate", … }, { "capability": "video.generate", … } ]
````

**硬性格式要求**（违反其中任何一条，运营者还得手工改）：

1. **两个块必须分开**，不要合成 `{"models": {…}, "specs": […]}`。
2. **`specs` 是一个数组**，里面直接放 N 个 spec 对象。
3. **不要按能力分节/分组/嵌套**。不要写成
   `{"image": [...], "video": [...]}`，也不要分六段给六个数组——
   一份 spec 一个数组元素，靠 `capability` 字段自描述。
4. `models` 是**扁平对象**：`{ "<客户端模型名>": {upstreamId, pricePerItem, enabled} }`。
5. 每份 spec 的 `specVersion` 固定为 `2`。
6. 所有 JSON 必须是**严格合法**的（不带注释、不带尾逗号）。

### 0.2 翻译流程：从厂商文档到 spec

**按顺序走完这 8 步。每一步都要真的回到厂商文档里抄，不要凭印象。**

| # | 步骤 | 在厂商文档里找什么 | 写到 spec 的哪里 |
| --- | --- | --- | --- |
| 1 | **端点** | HTTP 方法、路径、`contentType` | `transport.method` / `.path` / `.contentType` |
| 2 | **鉴权** | key 放哪（头？query？自定义头名？） | `auth` |
| 3 | **必填参数** ⭐ | 请求 schema 的 `required:` 列表 | 逐个确认我们有没有对应入参；**没有的必须用 `$firstPresent` 兜默认值**（§6.3） |
| 4 | **枚举参数** ⭐ | 每个枚举字段的合法值（`enum:`） | `$mapSize.table` / `$enum.map` / `$const`，**只写合法值，一个都不能编** |
| 5 | **响应结构** | 产物在哪、件数在哪、错误码和文案在哪 | `response.items` / `.successCount` / `.errorCode` / `.errorMessage` |
| 6 | **错误响应** ⭐ | `responses:` 里**每一个**状态码 | `errors[]`，用 `httpStatus` 或 `when`（§8.2） |
| 7 | **异步状态机** ⭐ | 任务状态的全部取值 | `async.poll.statusMap`（**必须写 `""` 兜底**）或 `successValues`/`failureValues` |
| 8 | **二次请求** | 产物是不是只给 id？要不要再调一次接口换？ | 是则用 `$fetch`（§7.3） |

⭐ = 历史上最容易漏、且**保存时不会报错**的三项。

最后再回头做两件事：

- **`metadata.modes` 只写你真的映射了的**。写了 `image-to-video` 却没映射首帧参数，
  运营者会在目录里看到「支持图生视频」，实际传图进来被当文生视频跑。
- **`limits.timeoutMs` 不要超过 300000**（serverless 上限，超过会在保存时直接报错）。

### 0.3 引擎怎么跑的（精确语义）

本节是**引擎行为的规范说明**，不是概述。判官脚本（§0.7）按这段实现，两者必须一致——
`tests/unit/media-protocol-doc.test.ts` 会做逐项比对。

#### 0.3.0 一次调用的完整顺序

```
1. 校验 n ≤ limits.maxN                       否则 400 n_too_large
2. 构造作用域 buildMediaScope(input)           见 0.3.9
3. 求值 request  → 上游 body                   见 0.3.10
4. 拼 URL：origin = spec.baseUrl ?? provider.baseUrl
           path  = base.pathname(去掉尾斜杠) + transport.path（内含 {{model}} 替换）
           再叠加 transport.query 里能求值的项、auth.type=query 的 key
           断言 url.origin === origin          否则 500 bad_spec
5. 组 header：Content-Type（multipart 除外）→ transport.headers（能求值的）→ auth 覆盖
6. 编码 body：multipart → FormData；x-www-form-urlencoded → URLSearchParams；否则 JSON
7. GET 不带 body
8. responseMode = binary|stream 时：非 2xx → 502 upstream_error；否则原样回传字节，结束
9. 读 body 为文本，JSON.parse（失败则 null）
10. 错误判定（顺序固定）：
      a. errors[].httpStatus 命中上游 HTTP 状态
      b. errors[].when  对**原始响应体**求值为 true
      c. 以上都没命中且 !response.ok → 502 upstream_error
11. async：取 response.taskId；没有 → 502 no_task_id；进入轮询
12. 求值 response → resolveFetches 展开 $fetch
13. 收集 items（做 encoding 归一）→ 若 0 产物且无 text 且未 allowEmpty → 502 upstream_contract_mismatch
14. 结算：credits = pricePerItem × successCount
```

#### 0.3.1 映射求值 `applyMapping(node, scope)`

按下列顺序判断，**先匹配先生效**：

| 顺序 | 条件 | 行为 |
| --- | --- | --- |
| 1 | `undefined` | 返回 `undefined`（键被丢弃） |
| 2 | `null` | 返回 `null`（键保留为 null） |
| 3 | 字符串 | `"$"` → 整个 scope；`"$.a.b"` → 路径取值（取不到 → `undefined`）；含 `{{ }}` → 模板替换；否则字面量 |
| 4 | 数字 / 布尔 | 原样返回（**`false` 和 `0` 不会被丢弃**） |
| 5 | 数组 | 逐项求值 |
| 6 | `{"$const": v}` | 返回 `v` |
| 7 | `{"$ifPresent": …}` | 单分支：`{"$.k": m}`，`$.k` 为 `undefined` 就返回 `undefined`；多分支：按顺序取第一个 `$.k` 存在的分支，都不存在返回 `undefined` |
| 8 | `{"$enum": …}` | 读 `path`；取不到 → `default`；`map` 命中 → 映射值；否则 `default` ?? 原始值 |
| 9 | `{"$mapSize": …}` | 同 `$enum`，但没命中时返回 `default` ?? 原始值 |
| 10 | `{"$dataUrl": p}` | 已是 `data:` 或 `http(s)://` → 原样；否则包成 `data:image/png;base64,<值>` |
| 11 | `{"$file": …}` | data URL → `{__file, filename, contentType, base64}`；取不到 → `undefined` |
| 12 | `{"$from": p, "$to": m}` | `p` 必须是**数组**，否则 `undefined`；每项以该项为新 scope 求值 `m`（缺省 `"$"`） |
| 13 | `{"$merge": [...]}` | 逐个求值后浅合并 |
| 14 | `{"$fetch": …}` | 返回 marker（不发网络请求），由第 12 步之后展开 |
| 15 | `{"$eq": [a, b]}` | 深度相等 |
| 16 | `{"$firstPresent": [...]}` | 第一个求值结果**非 `undefined` 且非 `null`** 的 |
| 17 | `{"$toString": m}` | 转字符串；`undefined`/`null` → `undefined` |
| 18 | 普通对象 | 逐键求值，**`undefined` 的键直接不写进结果** |

#### 0.3.2 两个容易踩的原语差异

- **`$firstPresent` 只对标量可靠。** 候选是对象时（如 `{kind, value}`），
  即使内部路径全取不到，结果也是 `{}` 之外的非 `undefined` 对象，
  于是**第一个分支永远命中**。要按条件选分支请用 `$ifPresent` 多分支。
- **`$ifPresent` 的存在性判断只看那个键**（`getPath !== undefined`），
  不看分支求值结果。

#### 0.3.3 键被丢弃的规则

| 情况 | 结果 |
| --- | --- |
| 路径取不到（客户端没传） | 键**不存在**于结果中 |
| `$ifPresent` 未命中 | 键不存在 |
| `$ifPresent` 多分支都不命中 | 键不存在 |
| 字面量 `false` / `0` / `""` | 键**存在**（不会被丢） |

`$` 文件里出现 `{{ $.x }}`：值做 **URL 编码**；`async.poll.path` 里的 `{{taskId}}`：
**原样拼接**（引擎自己 encodeURIComponent）。两套占位符不可混用。

#### 0.3.4 上游响应怎么变成 items

- `response.items` 是数组 → 逐项；是单个对象 → 当一项。
- 每项 `{kind, encoding?, value}`：`value` 必须是**非空字符串**，否则该项被丢弃。
- `kind` 非法值 → 视为 `"url"`。
- `encoding` 归一（`kind` 为 `base64` 时生效）：
  `hex` → hex 解码后重新 base64；`dataUrl` → 剥掉 `data:…;base64,` 前缀；其余原样。
- `response.itemsB64`（旧写法）仍受支持，强制 `kind:"base64"`，排在 `items` 之后。
- `response.text` 是字符串时也算“有产物”（语音转写没有 items）。

#### 0.3.5 编码归一的确切行为

`hex` → base64：去空白、剥 `0x`、奇数长度前补 `0`、**不是合法 hex 就原样透传**（不报错）。
所以 `"zz"` 会原样返回，`"abc"`（奇数长度）会按 `0abc` 处理。

#### 0.3.6 异步轮询的判定

1. `path` 里 `{{taskId}}` 替换成 URL 编码后的 task id
2. 请求 → 读 body → JSON
3. 同样先判 `httpStatus` 再判 `when` 错误规则
4. `status = response` 映射结果的 `status` 字段（由 `statusPath` 指定）
5. 状态归类：
   - 有 `statusMap` → 在 `statusMap` 里查（**默认忽略大小写**）；查不到 → 继续等
   - 否则 `failureValues` 命中 → 失败；`successValues` 命中 → 成功；都没命中 → 继续等
6. **没有 `status` 字段**时：已取到产物就当成功；否则若 `!response.ok` → 502
7. 每轮之间 `await sleep(intervalMs)`；超过 `timeoutMs` → `504 task_timeout`，
   **错误信息里带上最后一次看到的 status**（这是排查的关键线索）

> 所以「未知状态」的行为取决于 `statusMap` 有没有 `""`：
> **有** → 继续等到超时并报出状态名；**无** → 保存时就被拒绝。

#### 0.3.7 `$fetch` 的展开时机与限制

- 在 `response` 映射求值后、`collectItems` 之前展开，可嵌套。
- 上限：单次调用**最多 8 个**，总超时 **30s**，只发 **GET**，同源、复用该 spec 的鉴权。
- 只有映射结果里真的出现了那个路径才会发请求（轮询中还没有 `file_id` 时不会白发）。

#### 0.3.8 空结果的两种情况

| 情况 | 结果 |
| --- | --- |
| 上游 2xx，映射出 0 产物且无 `text`，未设 `allowEmpty` | `502 upstream_contract_mismatch` |
| `allowEmpty: true` | 成功，`successCount` 按 `countOf` 退化为 1 |

`successCount` 优先级：映射出的 `successCount`（>0 时）→ items 数量 → 1。

#### 0.3.9 作用域构造 `buildMediaScope`

```
1. 合并 { ...extra(透传的原始请求体), ...归一化字段 }   归一化字段在上
2. 丢弃所有 undefined 的键
3. 为每个键补上另一种拼写（snake ↔ camel），但不覆盖已存在的真实键
```

第 3 条保证：真实键永远优先于别名，所以客户端透传的 `response_format`
不会盖掉路由归一化出的 `responseFormat`。

#### 0.3.10 URL 与 header 的优先级

- `path` = `baseUrl` 的 pathname（去尾斜杠）+ `transport.path`，所以
  **baseUrl 带路径前缀时会被保留**——`baseUrl: "https://x/v1"` + `path: "/v1/y"` = `/v1/v1/y`。
- `transport.headers` 逐项求值，取不到就不发；`auth` 最后写入，**会覆盖同名 header**。
- `Content-Type` 在 `auth` 之前设置，所以鉴权头不会被误设成 JSON。

#### 0.3.11 引擎明确不做的事

- **不重试、不换供应商、不降级**（媒体按件计费，重试可能重复扣费）
- **不做任何编解码**，除非 item 声明了 `encoding`
- **不缓存、不存储、不管理产物过期**（上游 URL 有效期由厂商定，MiniMax 是 24 小时）
- **不做多步兑换**（`$fetch` 只有一步）
- **不跨事件拼接流式音频**（`sse` 只汇总 url 类 items）
- **不内置对象存储**、**不执行任何代码**（没有 eval、没有插件）
- **不校验枚举值的合法性**——`$enum` 里写了厂商不认的值，只有真实调用才会暴露（这就是判官存在的理由）

### 0.4 协议速查（完整契约）

#### 0.4.1 spec 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `specVersion` | `2` | ✅ | 固定 2，其它值一律拒绝 |
| `capability` | 枚举 | ✅ | `image.generate` `image.edit` `video.generate` `audio.tts` `audio.stt` `music.generate` |
| `displayName` | string | — | 后台显示名 |
| `models` | string[] | 条件必填 | 本 spec 服务的**客户端模型名**。**同一 capability 出现多份时每份都必须写**（§3.4） |
| `baseUrl` | http(s) URL | — | 覆盖供应商 `baseUrl`（换区域/域名） |
| `transport` | object | ✅ | 见 0.3.2 |
| `auth` | object | ✅ | 见 0.3.2 |
| `request` | 映射树 | — | 上游请求体 |
| `response` | 映射树 | 产出媒体时✅ | 见 0.3.4；`image.generate`/`image.edit`/`video.generate`/`audio.tts`/`music.generate` 不映射 `items` 会在保存时报错 |
| `responseMode` | `json`\|`sse`\|`binary`\|`stream` | — | 默认 `json` |
| `errors` | array | — | 见 0.3.5 |
| `async` | object | 异步时✅ | 见 0.3.6 |
| `limits` | object | — | 见下 |
| `allowEmpty` | boolean | — | 允许「2xx 但没有产物」（如内容拦截）；否则报 `upstream_contract_mismatch` |
| `metadata` | object | — | **原样**透出到 `/v1/models` 的 `relay` 字段 |

**任何不在此表里的顶层字段都会在保存时报错**（`xxx: unknown spec field`）——
所以不要发明字段名，能力不够就说清楚，需要改代码。

`limits` 的两个字段：

| `limits` 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxN` | number | 上游接受的最大张数，客户端 `n` 超过就报 `400 n_too_large` |
| `timeoutMs` | number | 上游超时，**必须 ≤ 300000**（serverless 上限，超过保存时报错） |

#### 0.4.2 transport 与 auth

| `transport` 字段 | 类型 | 必填 | 取值 / 说明 |
| --- | --- | --- | --- |
| `method` | 枚举 | ✅ | `POST`（默认）/ `GET` / `PUT` / `PATCH`。`GET` 不带 body |
| `path` | string | ✅ | 相对 `baseUrl`，以 `/` 开头。**只能用 `{{model}}` 一个占位符**（URL 编码后的上游模型名）；`{{taskId}}` 只能在 `async.poll.path` |
| `contentType` | 枚举 | — | `application/json`（默认）/ `multipart/form-data` / `application/x-www-form-urlencoded` |
| `headers` | object | — | `{ "<头名>": <映射> }`。**值是映射**，解析不出值就不发这个头 |
| `query` | object | — | `{ "<参数名>": <映射> }`，规则同上 |

| `auth` 写法 | 效果 |
| --- | --- |
| `{ "type": "bearer" }` | `Authorization: Bearer <key>` |
| `{ "type": "header", "name": "X-Api-Key", "prefix": "" }` | 自定义头（`prefix` 可选） |
| `{ "type": "query", "name": "api_key" }` | 拼到 URL query |
| `{ "type": "none" }` | 不带凭据 |

```jsonc
"transport": {
  "method": "POST",
  "path": "/v1/image_generation",
  "contentType": "application/json",
  "headers": { "language": "$.language" },
  "query":   { "version": "2024-01-01" }
}
```

#### 0.4.3 映射原语（全部 12 个，没有别的）

| 原语 | 写法 | 什么时候用 |
| --- | --- | --- |
| `$const` | `{"$const": <任意>}` | 固定值、默认值 |
| `$ifPresent` | 单分支 `{"$ifPresent": {"$.voice": <映射>}}`；多分支 `{"$ifPresent": [{"$.url": …}, {"$.b64_json": …}]}` | 客户端给了才发；多分支时**第一个键存在的生效** |
| `$enum` | `{"$enum": {"path":…, "map":{…}, "default":…}}` | 换一套词汇（`b64_json` → `base64`） |
| `$mapSize` | `{"$mapSize": {"path":…, "table":{…}, "default":…}}` | 尺寸换算（`$enum` 的特例） |
| `$toString` | `{"$toString": "$.n"}` | 厂商要字符串，客户端给了数字 |
| `$dataUrl` | `{"$dataUrl": "$.image"}` | **只往请求里用**：裸 base64 → `data:image/png;base64,…` |
| `$file` | `{"$file": {"path":…, "filename":…, "contentType":…}}` | **只往请求里用**：data URL → 真的 multipart 文件（需 multipart） |
| `$firstPresent` | `{"$firstPresent": [<映射>, …]}` | 取第一个**标量**有值的；厂商必填但客户端可能不传时用它兜默认 |
| `$from` | `{"$from": "$.data.urls", "$to": {…}}` | **只往响应里用**：数组逐项映射 |
| `$merge` | `{"$merge": [<映射>, <映射>]}` | 合并多个对象 |
| `$eq` | `{"$eq": [<映射>, <映射>]}` | 深度相等（`errors.when` 主力） |
| `$fetch` | `{"$fetch": {"path":…, "url":…, "pick":…}}` | **只往响应里用**：拿到 id 再发一次 GET 换最终值 |

其它规则：

- 映射对象里出现**表以外的 `$xxx` 键**会报错——原语名拼错当场暴露。
- 取不到的路径得到 `undefined`，**该键会从产物里整体消失**（不是 `null`）。
  所以 `"x": "$.client_may_omit"` 在客户端没传时等于没发这个字段。
- 字符串值里 `{{ $.a.b }}` 会被替换成作用域里的值（自动 URL 编码）。
- **方向别搞反**：`$dataUrl`/`$file` 属于请求，`$from`/`$fetch` 属于响应。

#### 0.4.4 response 契约

`response` 映射出来的对象**只认这些 key**，多余的会被忽略：

| key | 类型 | 作用 |
| --- | --- | --- |
| `items` | item 或 item[] | 产物。每项 `{ kind, encoding?, value }` |
| `successCount` | number | **成功件数，决定计费** |
| `taskId` | string | 异步任务的 id（`async` 必填） |
| `status` | string | 异步状态（`async.poll.statusPath` 指向它） |
| `text` | string | 转写文本（`audio.stt`） |
| `errorCode` | any | 上游错误码，进错误响应的 message |
| `errorMessage` | string | 上游错误文案，**优先于我们的 code 返回给客户端** |

**item**：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `kind` | `url` \| `base64` \| `text` | **客户端要什么** |
| `encoding` | `plain` \| `base64` \| `hex` \| `dataUrl` | 选填。**上游实际给的是什么**，引擎负责归一 |
| `value` | 映射 | 值的位置 |

组合示例：`{"kind":"base64","encoding":"hex","value":"$.data.audio"}`
→ 上游给 hex，引擎转成客户端能解码的 base64。

`items` 可以是单个对象（不必包成数组）。

#### 0.4.5 errors

```jsonc
"errors": [
  { "httpStatus": 402, "status": 402, "code": "upstream_credit_exhausted" },
  { "httpStatus": [401, 403], "status": 502, "code": "upstream_auth_failed" },
  { "when": { "$eq": ["$.base_resp.status_code", 1026] }, "status": 400, "code": "content_filter" }
]
```

- `when` 匹配**原始响应体**（未映射）；`httpStatus` 匹配 HTTP 状态码。**任一命中即触发**。
- **两个都不写会保存报错**（规则永远不会触发）。
- `status` / `code` 是返回给客户端的；`message` 选填，不写时优先用 `response.errorMessage`。
- **厂商文档 `responses:` 里列出的每个状态码都要映射**，包括看起来不可能发生的
  （例：MiniMax 用 **422** 表示内容拦截）。漏一个 = 客户端收到 502。
- 可用 `code`：`rate_limited` `upstream_credit_exhausted` `content_filter` `bad_request`
  `upstream_auth_failed` `upstream_task_failed` `upstream_overloaded`
  `task_timeout` `upstream_contract_mismatch` `upstream_error`。

#### 0.4.6 async

| `async` 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `submitTaskId` | string | ✅ | 从**提交响应**里取 task id 的路径 |
| `poll` | object | ✅ | 见下 |

| `async.poll` 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `method` | `GET`\|`POST` | — | 默认 `GET` |
| `path` | string | ✅ | **唯一**能用 `{{taskId}}` 的地方 |
| `intervalMs` | number | — | 轮询间隔，默认 3000 |
| `timeoutMs` | number | — | ≤ 300000，默认 240000 |
| `statusPath` | string | 建议 | 状态从**映射后**结果的哪里读 |
| `statusMap` | object | 二选一 | `{ "<厂商状态>": "ok" \| "fail" \| "wait" }`，**必写 `""` 兜底** |
| `successValues` | string[] | 二选一 | 与 `failureValues` 成对使用 |
| `failureValues` | string[] | 二选一 | 与 `successValues` 成对使用 |
| `statusMatch` | `exact`\|`caseInsensitive` | — | 默认 `caseInsensitive` |

```jsonc
"async": {
  "submitTaskId": "$.task_id",
  "poll": {
    "method": "GET",
    "path": "/v1/query/video?task_id={{taskId}}",
    "intervalMs": 5000,
    "timeoutMs": 240000,
    "statusPath": "$.status",
    "statusMap": { "Success": "ok", "Fail": "fail", "failed": "fail", "": "wait" }
  }
}
```

- `statusMap` 的值只能是 `"ok"` / `"fail"` / `"wait"`，**`""` 兜底项必写**（不写会保存报错）。
- 同一状态的不同写法**都要列**：`Success`/`success`、`Fail`/`fail`/`failed`、
  `cancelled`/`Canceled`——漏一种 = 客户端挂到超时。
- 也可以用 `successValues` + `failureValues`（两组不能都空，否则保存报错）。
- 匹配**默认忽略大小写**；需要严格时写 `"statusMatch": "exact"`。

#### 0.4.7 作用域（`$` 根作用域里有什么）

**每个端点都会透传客户端请求体的全部字段**，另外注入这些归一化字段：

| 端点 | 归一化字段 |
| --- | --- |
| `/v1/images/generations` | `model` `prompt` `n` `size` `responseFormat` `seed` `style` `watermark` `promptOptimizer` |
| `/v1/images/edits` | `model` `prompt` `image`（上传图的 data URL）`n` `size` `responseFormat` `seed` |
| `/v1/videos/generations` | `model` `prompt` `n` `size` `seed` `duration` |
| `/v1/audio/music` | `model` `prompt` `n` |
| `/v1/audio/speech` | `model` `input`（待合成文本）`voice` `speed` `responseFormat` |
| `/v1/audio/transcriptions` | `model` `image`（上传音频的 data URL）`language` `prompt` `temperature` `filename` |

- **每个键同时以蛇形和驼峰两种拼写存在**：`$.response_format` 与 `$.responseFormat` 等价。
- `$` 永远指**上游模型名**（已按 `upstreamId` 替换），不需要再映射。
- **翻译流程第 3 步的关键**：如果厂商 `required:` 里有 `duration` 这种
  我们对外端点**没有**对应入参的字段，就必须
  `"duration": {"$firstPresent": ["$.duration", {"$const": 6}]}`。

#### 0.4.8 引擎会做 / 不会做的事

**会做**：路径与 `{{}}` 替换（同源校验）、蛇形/驼峰别名、映射求值、multipart/form/json
三种编码、hex/base64/dataUrl 归一、错误规则匹配、异步提交与轮询、`$fetch` 一次同源 GET、
binary/stream/sse 回传、空结果检测、按 `successCount` 计费。

**不会做**（别写 spec 假设它会）：

- **不重试、不故障转移、不换供应商**——媒体按件计费，自动重试可能重复扣费。
- **不做任何编解码，除非你声明了 `encoding`**。
- **不缓存、不存储产物**、不过期管理——上游给的 URL 有效期由厂商决定（MiniMax 24 小时）。
- **不做多步兑换**：`$fetch` 只有一步（id → url）。
- **不跨事件拼接流式音频**：`sse` 只汇总 url 类 items。
- **不内置对象存储**：上传图要转 URL 得你自己先传好。
- **不执行任何代码**：没有 `eval`、没有插件。表达不了的厂商要**扩展引擎原语**（改代码）。

### 0.5 硬规则（逐条可判定）

1. `specVersion` 必须是 `2`。
2. 输出**两个独立 JSON 块**，`specs` 是**一个平铺数组**。
3. 同一 `capability` 多份 spec 时，**每份都要写 `models`**，且不能有模型被两份同时声明。
4. 厂商 `required:` 的每个字段都要有归属；我们没有对应入参的，**用 `$firstPresent` 兜默认**。
5. 所有枚举映射表（`$mapSize` / `$enum`）里**只能出现厂商文档里的合法值**。
6. `statusMap`（或 `successValues`+`failureValues`）必须能终止轮询，且 `statusMap` **必写 `""` 兜底**；
   状态的不同大小写/拼写变体要**全部列出**。
7. 厂商 `responses:` 里的**每个状态码**都要有 `errors` 规则。
8. 产物只给 id、需要再调接口时，用 `$fetch`；不要把 id 当 URL 返回。
9. `$dataUrl` / `$file` 只往请求用；`$from` / `$fetch` 只往响应用。
10. 要 base64 就确认上游编码，并用 `encoding` 声明；**不要假设是 base64**。
11. `metadata.modes` 只写真的映射了的。
12. `limits.timeoutMs ≤ 300000`。

### 0.6 不确定时的决策规则

| 情况 | 怎么办 |
| --- | --- |
| 文档没写某个枚举的完整取值 | **只映射你确认的值**，其余交给 `default`。别猜。 |
| 不知道产物是 url 还是 base64 | 写 `kind:"url"` + `encoding:"plain"`，实测一次再改。**别两个都写**——引擎只会取一个。 |
| 不知道异步状态词表 | 写 `{"": "wait"}` 加你确认的终态；跑一次真实任务看返回再补。**兜底项保证不会挂死**。 |
| 某个字段不确定要不要传 | 用 `$ifPresent` 包起来，客户端不传就不发。 |
| 表达式太复杂表达不出来 | 拆成多个 spec / 换厂商。**协议不执行代码**，不要试图绕过。 |
| 需要厂商不支持的能力 | 如实说做不到。`metadata` 里不要写没实现的 `modes`。 |

### 0.7 先跑判官脚本，别只读文档

文档会被漏读，JSON 会被误读。**唯一能证明一份 spec 正确的方式是把它跑起来。**
本项目开源了引擎，所以判官也开源了：

```bash
# 把两个块放进一个文件：{ "models": {…}, "specs": [ … ] }
pnpm spec-check my-specs.json
```

它做两件事，都不需要厂商账号、不联网。

**PART 1 静态**：结构与跨 spec 校验、**逐字打印实际会发出的上游请求**（含 header 的取舍），
外加若干启发式检查，其中三条对应真实事故：

| 启发式 | 拦住的真实事故 |
| --- | --- |
| `async.poll.path` 在提交路径后又接了字面量段 | 官方 `/v2/query/video_generation/{task_id}` 被写成 `/v2/video_generation/query?task_id=` → 全 404 |
| 布尔字段用了字符串常量 | `{"$const":"false"}` 在 multipart 里发出去是字符串 `"false"` |
| 用空值兜必填字段 | `{"$const":""}` 撞厂商 `minLength: 1` → 400 |
| 语音/音乐产物声明成 url 却没要 url | 请求里没有 `response_format`/`output_format`，而 MiniMax `t2a_v2`/`music_generation` **默认返回 hex** → 客户端拿到一串 hex 当 URL |

**PART 2 探针**：脚本会**读你 spec 自己的 `response` 映射，反推出一份刚好能喂饱它的上游响应**，
然后把 spec 真的执行一遍，逐条验证：

- happy path 能产出产物
- 每条 `httpStatus` 规则映射到正确的状态和 code
- 每条 `when` 规则能真的触发（`$eq` 右值的字面量会被喂进去）
- 异步终态能收敛、失败态立即失败、**未知状态不会假装成功**
- `encoding: "hex"` 真的产出了可解码的 base64
- 映射为空时报 `upstream_contract_mismatch`，而不是静默成功并计费 0
- `n > maxN` 被拒

**工作流**：写完 → `pnpm spec-check` → 全绿再交。
**没跑过判官就不要交付 spec**——§0.8 的自查表是给人看的兜底，判官是机器验证。

> 脚本源码 `scripts/spec-check.ts`；它本身有测试
> `tests/unit/media-spec-check.test.ts`：必须对全部内置模板报绿，
> 且必须能抓到上面那几类已知事故——所以判官不会自己退化成橡皮图章。

#### 喂一份真实上游响应给它（唯一能抓「字段不存在」的办法）

判官默认**自己合成**上游响应，所以「spec 说读 `data.url`」和「厂商真的返回 `data.url`」
它分不出来。加一个 `fixtures` 块就能把这个缺口补上——把厂商文档里的 curl 响应
（或一次真实调用的返回）贴进去：

```jsonc
{
  "models": { … }, "specs": [ … ],
  "fixtures": {
    "zhipu-glm-image": {                       // key：displayName / 模型名 / capability / "*"
      "submit": { "id": "task-1", "task_status": "PROCESSING" },
      "poll":   { "task_status": "SUCCESS", "image_result": [ { "url": "https://…" } ] }
    }
  }
}
```

- 异步 spec 用 `submit` / `poll` 两段（任务 id 只在提交响应里，产物只在轮询响应里）。
- 判官会**逐条对账**，并直接告诉你「你读的这个字段上游没有，同层有这些：…」：

  ```
  ✗ 真实上游响应对账  data.url：上游没有这个字段（同层的字段有：…, image_result）
  ```

- `items` 与 `itemsB64` 视为**同一产物的两种形态**：只贴了 url 形态的响应时，
  另一路算「该形态未出现（属正常）」而不是失败。
- 贴进来的响应还会**真的喂进引擎**跑一遍，验证它能产出产物。

> 一次真实调用、或一次 `curl` 文档示例，就是最贵的测试数据。**贴进去。**

#### 判官覆盖什么、不覆盖什么（重要）

判官**合成**上游响应——也就是说，它验证的是「spec 内部自洽 + 引擎语义正确」，
**不是**「厂商文档写对了」。这个边界必须说清楚：

| | 判官能抓 | 判官抓不到（必须人/AI 对着厂商文档核） |
| --- | --- | --- |
| 格式 | 输出块结构、`specVersion`、未知字段、必填缺失 | — |
| 路由分流 | 同 capability 多份是否歧义、模型是否全覆盖 | — |
| 请求 | 每个 spec **实际发出的 body / header**、兜默认值是否为空串、布尔是否写成字符串、枚举表是否出现 | 枚举值**厂商是否真的认** |
| 响应 | 映射能否产出产物、`encoding` 是否生效、空结果是否被拦、`itemsB64` 是否被读 | 响应路径是否和厂商 schema 一致——**除非贴了 `fixtures`** |
| 错误 | 每条 `httpStatus` / `when` 规则是否真的能触发、映射对不对 | 厂商的错误码**是否抄全** |
| 异步 | 终态收敛、失败态立刻失败、未知状态不假装成功、poll 路径形状可疑 | poll 路径**逐字符**是否与文档一致 |

所以 PART 1 还会打印一行 **`response 读取路径: …`**——
把它和厂商响应 schema 逐字对一遍，是判官**替代不了**的那一步。

### 0.8 交稿前自查（逐条回答「是/否」）

> ### ⚠️ 勾选不是自证——三个 ⭐ 项必须**附上原文**
>
> 下面第 4、7、8 条是最容易翻车的（漏抄 `required:`、漏抄 `responses:`、漏抄状态枚举），
> 而且**保存时不会报错**，只有真实调用才暴露。所以勾「是」之前，先把**你抄到的原文**写进回复：
>
> ```text
> required: model, content, resolution, duration
> responses: 400 401 402 422 429 500
> 状态枚举: queued / running / succeeded / failed / cancelled
> ```
>
> 写不出原文 = 没查到 = 不能勾「是」。**只写「已核对」而没有原文的，一律视为未核对。**
>
> 这一条不是形式主义：实测中出现过「自查表全绿，但 V2 轮询路径写成
> `/v2/video_generation/query`（官方是 `/v2/query/video_generation/{task_id}`）」
> 和「自查表全绿，但把 `lyrics` 默认成空串（官方 `minLength: 1`）」——
> 两处都能靠「把文档里那一行抄出来」当场发现。

- [ ] 输出是两个独立 JSON 块，`specs` 是一个平铺数组？
- [ ] 每份 spec 的 `specVersion` 是 `2`？
- [ ] 同一 capability 的多份 spec 都写了 `models`，且无模型被重复声明？
- [ ] 厂商 `required:` 逐条对过，没有对应入参的字段用了 `$firstPresent` 兜默认？**（贴原文）**
- [ ] 每个枚举映射表里的值都能在厂商文档里找到？**（贴出该字段的 `enum:` 列表）**
- [ ] 厂商 `responses:` 里的每个状态码（包括 422/529 这类）都有规则？**（贴原文）**
- [ ] 异步 `statusMap` 写了 `""` 兜底，且终态的每种拼写变体都列了？**（贴出状态字段的取值列表）**
- [ ] `{{taskId}}` 的轮询路径**逐字符对照过**厂商文档的 URL？（路径拼接错一个段就全 404）
- [ ] 产物若是 id，用了 `$fetch` 换成真地址？
- [ ] 要 base64 的地方声明了正确的 `encoding`（或确认过上游本来就是 base64）？
- [ ] `$dataUrl` / `$file` 只出现在 `request`，`$from` / `$fetch` 只出现在 `response`？
- [ ] multipart 里的**字符串 vs 布尔**都对得上厂商文档？（`"false"` ≠ `false`）
- [ ] `metadata.modes` 里每一项都有对应的请求映射，且用词与其它能力一致？
- [ ] `limits.timeoutMs ≤ 300000`？

> 完整版（带每条的真实翻车案例）在 §17。

### 0.9 词汇对照：OpenAI 入参 ↔ 常见厂商字段

厂商几乎都不叫 OpenAI 的名字。下面这张表是「客户端发的词」到「厂商文档里的词」的常见对应，
写 spec 时对着它找，能省掉大量猜字段名的时间：

| 客户端（我们的作用域） | 常见厂商写法 | 备注 |
| --- | --- | --- |
| `$.size` = `1024x1024` | `aspect_ratio: "1:1"`（MiniMax） | 用 `$mapSize` |
| `$.size` = `1024x1024` | `size: "1K"` / `width`+`height`（部分厂商） | 用 `$mapSize` 拆字段 |
| `$.size` = `1920x1080` | `resolution: "768P"` / `"2K"`（MiniMax 视频） | 用 `$enum` |
| `$.responseFormat` = `b64_json` | `response_format: "base64"` | 用 `$enum` |
| `$.responseFormat` = `mp3` | `audio_setting.format: "mp3"` | 用 `$enum` |
| `$.n` = `2` | `n` / `num_images` / `num` | 直传或 `$toString` |
| `$.seed` = `42` | `seed` | 直传 |
| `$.style` = `"vivid"` | `style` / `aigc_style` | 直传 |
| `$.watermark` = `true` | `aigc_watermark`（MiniMax）/ `watermark` | 直传 |
| `$.promptOptimizer` = `true` | `prompt_optimizer` | 直传 |
| `$.input`（TTS 文本） | `text`（MiniMax）/ `input`（OpenAI） | 直传 |
| `$.voice` | `voice_setting.voice_id` | `$ifPresent` 包起来 |
| `$.speed` | `voice_setting.speed` | 直传 |
| `$.image`（data URL） | `image`（URL）/ `subject_reference[].image_file` / `content[].image_url.url` | `$dataUrl` 或直接给 URL |
| `$.image`（STT 音频） | `file`（multipart 文件） | `$file` |
| `$.language` | 表单字段 / HTTP 头（MiniMax 是**头**） | `transport.headers` |
| `$.prompt`（视频） | `prompt`（V1）/ `content: [{type:"text",text:…}]`（V2） | `$merge` 或数组字面量 |
| `$.duration` | `duration`（视频秒数） / `voice_setting.speed`（TTS 倍率） | 含义不同，别搞混 |
| `$.lyrics` | `lyrics` | 直传 |
| 产物 url | `data.image_urls[]` / `task.content.url` / `file.download_url` | `$from` 或 `$fetch` |
| 产物 base64 | `data.image_base64[]` / `data.audio`（**注意可能是 hex**） | 声明 `encoding` |
| 错误码 | `base_resp.status_code` / `error.type` / HTTP 状态 | `when` 或 `httpStatus` |
| 任务状态 | `status` / `task.status` | `statusPath` |

---



## 1. 五分钟看懂

一个**媒体供应商** = 一个 `baseUrl` + 一把密钥 + 一组模型（客户端模型名 → 上游模型名 + 单价）
+ 若干份 **spec**。一份 spec 描述「某一类能力怎么翻译」：

```
客户端请求 (OpenAI 形状)  ──spec.request──▶  上游请求 (厂商形状)
客户端响应 (OpenAI 形状)  ◀─spec.response─  上游响应 (厂商形状)
```

引擎（`src/lib/media/engine.ts`）是**通用**的：它只认 spec 里的声明，不认任何厂商。
厂商的一切差异都写在 JSON 里，所以加厂商 = 发一份 JSON。

---

## 2. 为什么是 2（v1 做不到的五件事）

这份协议不是设计出来的，是**拿四份独立写成的 MiniMax spec 反复跑真实引擎**逼出来的。
每一类反复出现的故障，现在都由协议本身兜住：

| 曾经的现象 | 根因 | 2 里的机制 |
| --- | --- | --- |
| V2 的视频 spec 被 V1 的**静默顶掉**，H3 请求被发到 `/v1/video_generation` | spec 只按 `capability` 选，第一份永远生效 | `spec.models` 按模型分流；两份都不写 `models` **保存时报错**（§3.4） |
| 客户端传 `response_format: "b64_json"`，上游收到 `url`，**不报错** | 图片端点是白名单，蛇形键取不到值 | 所有端点透传请求体，且**每个键同时以蛇形和驼峰暴露**（§6.1） |
| TTS 客户端拿到的音频**解不出来** | 上游默认吐 hex，spec 写成 base64 | `items[].encoding` 声明上游编码，引擎负责归一（§7） |
| 视频任务成功了，客户端**等满 280 秒**拿到 504 | 厂商文档里同一状态有 `Success` 和 `success` 两种写法 | 状态匹配**默认忽略大小写**，可用 `statusMap` 一次归一整个词表；超时错误会报出**实际观察到的状态**（§9） |
| 余额不足被当成 502 返回 | V2 用 HTTP 状态码 + `error.type`，V1 用 HTTP 200 + `base_resp` | 错误规则**两种都能匹配**（§8） |

> v1 的 spec 会被明确拒绝，并告诉你该去哪重新导入。**没有静默兼容**——
> 一个字段含义悄悄变了，比直接报错危险得多。

---

## 3. 数据模型

### 3.1 媒体供应商（与聊天 Provider 是两套实体）

```
MediaProvider {
  id, name
  baseUrl          // 例如 https://api.minimax.cn
  encryptedApiKey  // 加密存储，不回传前端
  enabled, priority
  models   { <客户端模型名>: { upstreamId, pricePerItem, enabled } }
  specs    MediaSpec[]
}
```

- `models` 的 key 是**客户端在请求里写的模型名**，`upstreamId` 才是发给厂商的名字。
- `pricePerItem` 是**每件多少整数积分**（`100` = 100 积分/张，`0` = 免费）。
  内部账本用 0.001 积分单位，换算由引擎做，**不要自己乘 1000**。
- 媒体**一律扣积分**，即使账号额度模式是「词元」——媒体没有自然词元数。

### 3.2 spec 顶层字段

下面是字段清单（**不是可粘贴的 spec**，完整可跑的例子见 §16）：

```text
{
  "specVersion": 2,                     // 必填，只能是 2
  "capability": "image.generate",      // 必填，见 §3.3
  "displayName": "MiniMax Image",      // 选填，后台显示用
  "models": ["minimax-image-01"],       // 选填，见 §3.4
  "baseUrl": "https://api.minimax.io", // 选填，覆盖供应商 baseUrl（换区域/域名）
  "transport": { ... },                 // 必填，见 §5
  "auth": { ... },                      // 必填，见 §5
  "request":  { ... },                  // 映射树，见 §6
  "response": { ... },                  // 映射树，见 §7
  "responseMode": "json",               // json | sse | binary | stream
  "errors": [ ... ],                    // 见 §8
  "async": { ... },                     // 见 §9
  "limits": { "maxN": 9, "timeoutMs": 120000 },
  "allowEmpty": false,                  // 见 §7.5
  "metadata": { ... }                   // 原样透出到 /v1/models 的 relay 字段
}
```

写错的顶层字段会在保存时**直接报名字**（`reponse: unknown spec field`），不会静默忽略。

### 3.3 能力

| capability | 对外端点 | 返回 |
| --- | --- | --- |
| `image.generate` | `/v1/images/generations` | `data[].url` / `data[].b64_json` |
| `image.edit` | `/v1/images/edits` | 同上 |
| `video.generate` | `/v1/videos/generations` | 同上 + `id` |
| `audio.tts` | `/v1/audio/speech` | 音频（JSON 或裸字节，见 §7.3） |
| `audio.stt` | `/v1/audio/transcriptions` | `text` |
| `music.generate` | `/v1/audio/music` | 同视频 |

### 3.4 一个供应商里可以有多份同能力 spec

厂商常同时提供两套接口（MiniMax 视频有 V1 和 V2），**必须能共存**。做法是给每份 spec
一个 `models` 列表，声明它服务哪些**客户端模型名**：

```jsonc
// 同一个供应商里的两份 video.generate
{ "capability": "video.generate", "models": ["minimax-hailuo-02","minimax-t2v-01"], "transport": {"path": "/v1/video_generation"} , … }
{ "capability": "video.generate", "models": ["minimax-h3"],                  "transport": {"path": "/v2/video_generation"} , … }
```

选路规则：先找 `models` 里含该模型的 spec；找不到再找**没写 `models`** 的 spec
（视作「这个能力我全都接」）；都没有才算不支持。

> ### ⚠️ 歧义会被拒绝，不会静默取第一份
>
> 同一个 capability 出现多份、而其中有**没写 `models`** 的，保存直接报错：
>
> ```
> specs[0],[1]: 2 specs serve "video.generate" but 2 of them do not list `models`,
> so only the first would ever run — add a `models` array to each
> ```
>
> 同一个模型被两份 spec 声明，也会报错（`"h3" is already served by specs[0]`）。
>
> 这正是 v1 最贵的一个坑：配置能存、目录能列、就是调不通，而且没有任何提示。

---

## 4. 交给 AI 写 spec

后台是**两个独立的输入框**（上面 `models`、下面 `specs`），所以 AI 的输出也必须是
**两个独立 JSON 块**：

````text
【第一块：models —— 扁平对象，key 是客户端模型名】
{ "minimax-image-01": { "upstreamId": "image-01", "pricePerItem": 100, "enabled": true } }

【第二块：specs —— 扁平数组，一份 spec 一个元素】
[ { "capability": "image.generate" }, { "capability": "video.generate" } ]
````

> ### ⚠️ 三条格式硬要求
>
> 1. **不要合并**成 `{"models": {…}, "specs": […]}`——没法直接粘进两个框。
> 2. **不要按「图片 / 视频 / 语音 / 音乐」分组或嵌套**。`specs` 是**平铺数组**，
>    每份 spec 自带 `capability` 字段自描述。
> 3. `models` 是**扁平对象**：不要写成数组，也不要按模态再分一层。
>
> 可以直接把这段发给 AI：
>
> ```text
> 请严格按「两个独立的 JSON 块」输出：第一块是 models（扁平对象，key=客户端模型名），
> 第二块是 specs（扁平数组，每份 spec 用 capability 字段自描述，specVersion 固定为 2）。
> 不要合并，也不要按图片/视频/语音/音乐分组或嵌套。
> 动笔前先读本文 §6.1（每个端点到底有哪些 `$.键`）、**§6.3（厂商必填但客户端可能不传的参数）**、
> §7.2（结果形态与编码）、§8（**厂商的每个状态码都要映射**）、§9（异步状态词表），
> 交稿前跑 `pnpm spec-check` 并按 §17 的十条自查。
> ```
>
> 贴的时候：上面那个框贴 `models`，下面那个框贴 `specs`。

---

## 5. transport 与 auth

```jsonc
"transport": {
  "method": "POST",                          // POST | GET | PUT | PATCH
  "path": "/v1/image_generation",            // 相对 baseUrl；提交路径上只能用 {{model}}
  // 三选一：application/json | multipart/form-data | application/x-www-form-urlencoded
  "contentType": "application/json",
  "headers": { "language": "$.language" },   // 值是映射，取不到就**不发这个头**
  "query":   { "version": "2024-01-01" }     // 同上，可映射
}
```

- **`headers` / `query` 的值是映射**，所以能把客户端参数送到厂商要求的位置。
  典型例子：MiniMax 的语音识别要 `language` **HTTP 头**而不是表单字段，
  写 `"headers": {"language": "$.language"}` 即可。
- **`{{model}}`** 替换成 URL 编码后的上游模型名，给路径式接口用
  （`/v2/models/{{model}}/images`）。提交路径上**只允许这一个**占位符；
  `{{taskId}}` 只在 `async.poll.path` 上有效。
- `GET` 不带 body。

```jsonc
"auth": { "type": "bearer" }                              // Authorization: Bearer …
"auth": { "type": "header", "name": "X-Api-Key" }         // 可加 "prefix": "Bearer "
"auth": { "type": "query",  "name": "api_key" }           // 拼到 URL 上
"auth": { "type": "none" }                                 // 公共端点
```

---

## 6. 请求映射

### 6.1 `$` 根作用域里有什么

每个端点都会注入一批**归一化字段**，同时**把客户端请求体的其余字段原样透传**。
因此：

> **只要客户端发了，就能引用到。** 不必担心某个键在某个端点上「不存在」。

| 端点 | 归一化字段 |
| --- | --- |
| `/v1/images/generations` | `model` `prompt` `n` `size` `responseFormat` `seed` `style` `watermark` `promptOptimizer` |
| `/v1/images/edits` | `model` `prompt` `image`（上传图的 data URL）`n` `size` `responseFormat` `seed` |
| `/v1/videos/generations` | `model` `prompt` `n` `size` `seed` `duration` |
| `/v1/audio/music` | `model` `prompt` `n` |
| `/v1/audio/speech` | `model` `input`（待合成文本）`voice` `speed` `responseFormat` |
| `/v1/audio/transcriptions` | `model` `image`（上传音频的 data URL）`language` `prompt` `temperature` `filename` |

外加**客户端自己发的每一个字段**（原样），所以 `$.lyrics`、`$.negative_prompt`、
`$.duration`、`$.style` 都能直接引用。

#### 两种拼写都能用

每个键会**同时**以蛇形和驼峰两种拼写出现在作用域里：

```jsonc
{ "response_format": { "$enum": { "path": "$.responseFormat", … } } }   // ✅
{ "response_format": { "$enum": { "path": "$.response_format", … } } }   // ✅ 等价
```

规则很简单：**两种写法等价，随便挑一个记住就行**。

- 客户端没传的字段**不在作用域里**（不是 `undefined` 键），所以 `$ifPresent` 可靠。
- 归一化字段优先于同名的透传字段。
- `$` 永远指上游模型名（已按 `upstreamId` 替换），spec 不用再映射一次。

### 6.2 映射原语

| 原语 | 完整写法 | 作用 | 例 |
| --- | --- | --- | --- |
| `$const` | `{"$const": <任意>}` | 固定值 | `{"$const": "jpg"}` |
| `$ifPresent` | `{"$ifPresent": {"$.voice": <映射>}}` | 客户端给了才发 | 客户端选音色时才带 `voice_setting.voice_id` |
| `$ifPresent`（多分支） | `{"$ifPresent": [{"$.url": <映射>}, {"$.b64_json": <映射>}]}` | 第一个**键存在**的分支生效 | 同一数组里 url / b64_json 二选一（OpenAI `data[]`） |
| `$enum` | `{"$enum": {"path":…, "map":{…}, "default":…}}` | 换一套词汇 | `{"$enum":{"path":"$.responseFormat","map":{"b64_json":"base64"},"default":"url"}}` |
| `$mapSize` | `{"$mapSize": {"path":…, "table":{…}, "default":…}}` | 尺寸换算（`$enum` 的特例） | `1024x1024 → 1:1` |
| `$toString` | `{"$toString": "$.n"}` | 数字转字符串 | 厂商要 `"4"` 而客户端发了 `4` |
| `$dataUrl` | `{"$dataUrl": "$.image"}` | **请求方向**：裸 base64 → data URL | 上传图直接给厂商 |
| `$file` | `{"$file": {"path":…, "filename":…, "contentType":…}}` | **请求方向**：data URL → 真的 multipart 文件 | 需要 `contentType: multipart/form-data` |
| `$firstPresent` | `{"$firstPresent": ["$.a", "$.b"]}` | 取第一个**标量**有值的 | 厂商必填但客户端可能不传时兜默认，见 §6.3 |
| `$from` + `$to` | `{"$from": "$.data.urls", "$to": {…}}` | **响应方向**：数组逐项映射 | 见 §7 |
| `$merge` | `{"$merge": [<映射>, <映射>]}` | 合并多个对象 | |
| `$eq` | `{"$eq": [<映射>, <映射>]}` | 深度相等（主要用于 `errors.when`） | `{"$eq":["$.base_resp.status_code",1002]}` |
| `$fetch` | `{"$fetch": {"path":…, "url":…, "pick":…}}` | **响应方向**：拿到 id 再发一次 GET 换最终值 | 见 §7.3 |

只有 `$file` 依赖 `contentType: multipart/form-data`，其余原语与 contentType 无关。

> **映射对象里出现表以外的 `$xxx` 键会报错**，写错的原语名当场暴露。

### 6.3 客户端没给、但厂商必填的参数

这是**最容易被忽略**的一类 bug：客户端只发 `model` + `prompt`（最自然的最小调用），
但厂商把某个参数标成 required，于是上游 400，而 spec 看起来完全正常。

上游把该参数丢掉时，映射结果里那个键会**直接消失**（不会有 `null`），所以
`"duration": "$.duration"` 在客户端没传时长时就等于**没发这个字段**。

用 `$firstPresent` 补一个默认值：

```jsonc
// ✘ 客户端只发 model + prompt → duration 整个字段消失 → MiniMax 400
"duration": "$.duration"

// ✔ 厂商必填 4–15 秒，客户端不传就默认 6 秒
"duration": { "$firstPresent": [ "$.duration", { "$const": 6 } ] }
```

**自查**：翻厂商文档的 `required:` 列表，逐个确认——凡是我们对外端点**没有**
对应入参的（`duration` 这类），都必须用 `$firstPresent` 兜一个默认值。
典型例子：MiniMax 视频 V2 的 `required: [model, content, resolution, duration]`，
其中 `duration` 在 OpenAI 形状的视频接口里没有对应字段。

### 6.4 `$dataUrl` 的方向

> ### ⚠️ `$dataUrl` 往**请求**里用，**响应**里绝不用
>
> - 请求：`{"$dataUrl": "$.image"}` 把上传的裸 base64 包成 `data:image/png;base64,…` 给厂商。
> - 响应：应该写 `"value": "$.data.audio"`。写成 `{"$dataUrl": "$.data.audio"}` 会得到
>   `data:image/png;base64,…`，客户端 `base64 -d` 直接失败。
>
> 响应方向要「还原」时用 `encoding: "dataUrl"`（§7.2）。

---

## 7. 响应映射

### 7.1 `response` 能产出什么

```jsonc
"response": {
  "items": [ { "kind": "url", "value": "$.task.content.url" } ],
  "successCount": "$.metadata.success_count",
  "taskId": "$.task_id",
  "status": "$.task.status",        // 异步轮询判断状态用这个（§9）
  "text": "$.text",                 // 语音转写用
  "errorCode": "$.base_resp.status_code",
  "errorMessage": "$.base_resp.status_msg"
}
```

`items` 的每一项：

```jsonc
{
  "kind": "url" | "base64" | "text",   // 客户端要什么
  "encoding": "plain|base64|hex|dataUrl", // 选填：上游实际给的是什么
  "value": <映射>
}
```

数组用 `$from`：

```jsonc
"items": { "$from": "$.data.image_urls", "$to": { "kind": "url", "value": "$" } }
```

### 7.2 结果形态与编码：上游给什么，客户端就拿到什么

这是**最容易出错、也最致命**的一处：映射错了不会报错，客户端只是拿不到能用的东西。

| 上游返回 | 例子 | 怎么写 | 客户端能用吗 |
| --- | --- | --- | --- |
| 公网 URL | `image_urls: ["https://…"]` | `{"kind":"url","value":"$"}` | ✅ 直接用 |
| 纯 base64 | `audio: "QUJDRA=="` | `{"kind":"base64","value":"$.data.audio"}` | ✅ 解码即可 |
| **hex 编码** | `audio: "49443304…"`（MiniMax `output_format` **默认就是 hex**） | `{"kind":"base64","encoding":"hex","value":"$.data.audio"}` | ✅ 引擎帮你转 |
| data URL | `audio: "data:audio/mpeg;base64,…"` | `{"kind":"base64","encoding":"dataUrl","value":"$.data.audio"}` | ✅ 引擎剥前缀 |
| 资源 id | `file_id: "205258526306433"` | 不是 URL，要用 `$fetch` 换 | ❌ 见 §7.3 |

> **`encoding` 声明的是上游给的是什么，`kind` 是客户端要什么。** 引擎负责在中间转换，
> 所以 `output_format` 是 hex 还是 url 都能正常出图/出音频——**但更推荐让上游吐 url**
> （`"output_format": {"$const": "url"}`），省掉一次编码转换，链接还能直接用。

**URL 有有效期**：MiniMax TTS / 音乐的 `url` 有效期 **24 小时**。转发给终端用户前请确认
这一点，必要时用 `$fetch` 换成自己的对象存储。

### 7.3 `$fetch`：再调一次换最终结果

有些厂商只给一个 id，真正的地址要**再发一次请求**。`$fetch` 表达这一步：

```jsonc
"items": [ { "kind": "url",
  "value": { "$fetch": { "path":  "$.file_id",
                         "url":   "/v1/files/retrieve?file_id={{ $.file_id }}",
                         "pick":  "$.file.download_url" } } } ]
```

规则：

- 只能再发**一次 GET**（同源、复用该 spec 的鉴权和 origin 校验）。
- 单次调用最多 8 次、总超时 30s。
- `$fetch.url` 用 `{{ $.x }}`（会做 URL 编码）；`async.poll.path` 用 `{{taskId}}`（原样拼接）。**两套占位符不要混用。**
- 上游还没有 `file_id` 时（例如任务还在 `processing`）不会白白发请求。

### 7.4 `responseMode`：上游返回的不是 JSON 时

| 值 | 上游返回 | 引擎行为 |
| --- | --- | --- |
| `json`（默认） | JSON | 套用 `response` 映射 |
| `sse` | `text/event-stream` | 逐个事件套映射，**url 类 items 拼起来并去重** |
| `binary` | 裸字节（如 mp3） | 字节原样回客户端 |
| `stream` | 任意流 | 不缓冲，直接透传 |

> `sse` 适合「流式吐状态/结果」的接口。**跨事件拼接流式音频字节不在支持范围内**（§15）。

### 7.5 空结果会被拦下

映射写错路径时，上游返回 2xx 但客户端**一张图都收不到**，旧版会静默成功并计费 0 积分。
现在这种情况直接报错：

```json
502 upstream_contract_mismatch
upstream returned 2xx but the spec's response mapping produced no items — check response.items paths…
```

确实允许空结果（比如内容安全拦截后只回一个状态）的，写 `"allowEmpty": true`。

> ### ⚠️ `successCount` 决定计费
>
> 实际扣费 = `pricePerItem × successCount`。**失败 / 被内容安全拦截不计费。**
> 上游只产出了一部分时，务必显式写 `"successCount": "$.metadata.success_count"`，
> 否则引擎按 `items` 长度算，可能把被拦掉的也计上；固定产出一个文件时写 `{"$const": 1}`。

---

## 8. 错误处理

两种厂商错误表达方式**都支持**，可以混用。

**方式一：HTTP 状态码**（OpenAI 系、MiniMax 视频 V2 等）：

```jsonc
"errors": [
  { "httpStatus": 402, "status": 402, "code": "upstream_credit_exhausted" },
  { "httpStatus": [401, 403], "status": 502, "code": "upstream_auth_failed" }
]
```

**方式二：响应体里的厂商码**（MiniMax V1 会用 HTTP 200 + `base_resp.status_code`）：

```jsonc
"errors": [
  { "when": { "$eq": ["$.base_resp.status_code", 1026] }, "status": 400, "code": "content_filter" },
  { "when": { "$eq": ["$.error.type", "insufficient_balance_error"] }, "status": 402, "code": "upstream_credit_exhausted" }
]
```

规则：

- `when` 匹配的是**原始响应体**（未经映射），因为厂商错误码都在那里。
- `when` 和 `httpStatus` **任一命中**即触发；两个都不写会**保存时报错**
  （否则这条规则永远不会触发）。
- `status` + `code` 是**返回给客户端**的状态和错误码。
- 规则没写 `message` 时，若 `response.errorMessage` 有映射，会用**厂商自己的错误文案**，
  比我们的 code 有用得多。
- 都不匹配时：HTTP 非 2xx → `502 upstream_error`；HTTP 2xx → 正常成功路径。

> ### ⚠️ 把厂商文档里列出的**每一个**状态码都映射
>
> 业务错误不一定用 4xx 里「常规」的那些码。真实例子：MiniMax 视频 V2 用
> **HTTP 422 + `unprocessable_entity_error` 表示内容被拦截**（不是 400），
> 漏掉它 → 客户端拿到的是 `502 upstream_error` 而不是 `400 content_filter`。
>
> 抄厂商文档的 `responses:` 列表时，**400 / 401 / 402 / 422 / 429 / 529 一个都别漏**，
> 哪怕看起来「不可能发生」。
>
> 常用映射对照：`402` → `upstream_credit_exhausted`、`429` → `rate_limited`、
> `401` → `upstream_auth_failed`、`400` → `bad_request`、
> `422` → `content_filter`（内容审核）、`529` → `upstream_overloaded`。

常用 `code`：`rate_limited` `upstream_credit_exhausted` `content_filter` `bad_request`
`upstream_auth_failed` `upstream_task_failed` `task_timeout` `upstream_contract_mismatch`。

---

## 9. 异步供应商

```jsonc
"async": {
  "submitTaskId": "$.task_id",
  "poll": {
    "method": "GET",
    "path": "/v1/query/video_generation?task_id={{taskId}}",  // 唯一能用 {{taskId}} 的地方
    "intervalMs": 5000,
    "timeoutMs": 240000,
    "statusPath": "$.status",        // 映射后的结果里，状态从哪读
    "statusMap": { "Success": "ok", "Fail": "fail", "": "wait" }
  }
}
```

时序：提交 → 取 `taskId` → 每 `intervalMs` 轮询 → 命中 `fail` 立即失败；
命中 `ok`（或已取到产物）成功；超过 `timeoutMs` 报 `task_timeout`。

### 9.1 用 `statusMap` 一次归一整个词表（推荐）

`statusMap` 把厂商的词表映射成三个规范状态，**一个词表覆盖大小写和中间态**：

```jsonc
"statusMap": { "Success": "ok", "Fail": "fail", "Preparing": "wait", "Queueing": "wait", "": "wait" }
```

- `""` 是**兜底项，必写**。没有它，厂商新增一个状态时轮询会一直挂到超时——
  保存时会强制要求你写。
- 匹配**默认忽略大小写**（MiniMax 同一状态在文档里有 `Success` 和 `success` 两种写法）。
  需要严格区分时写 `"statusMatch": "exact"`。

### 9.2 或者用 successValues / failureValues

```jsonc
"successValues": ["Success", "success", "SUCCEEDED"],
"failureValues": ["Fail", "failed", "Cancelled"]
```

没列到的状态一律当作「还在进行」继续等。两组都没写会**保存时报错**。

### 9.3 超时错误会告诉你实际看到的状态

```
504 task_timeout
upstream task did not finish in time (last status "Rendering" — check async.poll.statusMap / successValues)
```

轮询在请求内完成，受 Serverless 函数上限约束（约 300 秒，`limits.timeoutMs`
超过 300000 会在保存时报错）。更长的任务需要外部队列，协议暂不支持（§15）。

---

## 10. 计费

- 价格在 `models[客户端模型名].pricePerItem`：**每件多少整数积分**。
- 实际扣费 = `pricePerItem × successCount`；**失败 / 被内容安全拦截不计费**。
- 媒体**一律扣积分**，即使账号额度模式是「词元」。
- 用量行记录件数（`images`）与能力（`capability`），聚合链路
  `UsageLog → UsageAggregate → 用量页 / /api/admin/usage` 都带件数。

---

## 11. 模型目录元数据

`GET /v1/models` 里的媒体条目带 `relay` 扩展对象（OpenAI SDK 会忽略未知字段）：

```json
{
  "id": "image-01", "object": "model", "created": 1790647246, "owned_by": "relayab",
  "relay": {
    "kind": "media",
    "provider": "MiniMax",
    "capability": "image.generate",
    "modes": ["text-to-image", "image-to-image"],
    "edit_mode": "reference",
    "sizes": ["1024x1024", "auto"],
    "max_n": 9
  }
}
```

`metadata` 原样透出，所以随便写。**只写你真的支持的值**——
`modes` 里写了 `image-to-video` 就意味着请求里带图能用，没实现就别写。
`/anthropic/v1/models` **不列媒体模型**（这是既定决策）。

---

## 12. 保存时的校验

保存前会跑两轮检查，**目的是让错误在后台暴露，而不是在 3 点钟的线上请求里**。

**逐份 spec（`parseMediaSpec`）**：必填字段、类型、未知顶层字段、
`transport.path` 的占位符、`limits.timeoutMs ≤ 300000`、`statusMap` 有没有兜底项、
错误规则会不会永远不触发……

**整组 spec（`validateMediaSpecs`）**：同 capability 多份是否都用 `models` 区分、
同一模型是否被两份声明、产出媒体的能力是否真的映射了 `items`。
返回的错误里带 `specs[i]:` 下标，警告会随保存响应返回给面板。

> 非致命的 `warnings`（比如 `async.poll.path` 里没有 `{{taskId}}`）不会阻止保存，
> 但值得看一眼。

---

## 13. 安全边界

- **不执行任何代码**：只有声明式原语，没有 `eval`，没有插件上传。
  这是刻意的取舍——代价是遇到表达不了的厂商只能**扩展引擎原语**（改代码），
  而不是给单个厂商写适配器。
- spec 只能请求**自己供应商的 origin**：`baseUrl`、`spec.baseUrl`、`transport.path` 都是
  运营者配置，引擎会重新校验 origin，防止把网关变成开放代理。
- `$fetch` 复用同一套 origin 校验和鉴权。
- 每次调用跟随上游的 `retry`？**不跟随**：媒体调用计费按件，重试可能重复扣费。
- `baseUrl` 重复版本段是常见低级错误（`baseUrl` 带 `/v1` + `path` 带 `/v1/…` = 全 404）。
  自查：`baseUrl + transport.path` == 厂商文档里的完整 URL。

---

## 14. 排查手册

| 现象 | 多半是 |
| --- | --- |
| 404 `model_not_found` | 该客户端模型名没配，或 `enabled: false` |
| 400 `capability_not_supported` | 这个供应商没有该能力的 spec（或 `models` 没覆盖该模型） |
| 400 `n_too_large` | 超过 `limits.maxN` |
| 502 `upstream_unreachable` | baseUrl/路径错、DNS、厂商挂了 |
| 502 `upstream_contract_mismatch` | **响应映射路径写错**，或模型真的没产出 |
| 502 `upstream_auth_failed` | key 不对 / 过期；或该 region 的 key 用错了 baseUrl |
| 504 `task_timeout` | 看错误里的 `last status`，多半是 `statusMap` 漏了终态 |
| 客户端拿到的音频解不开 | `kind`/`encoding` 与上游实际编码不符（§7.2） |
| 客户端拿到的链接打不开 | 上游只给了 id，该用 `$fetch`（§7.3）；或 URL 已过期 |
| 404（全部接口） | `baseUrl` 和 `path` 的版本段重复（§13） |

---

## 15. 已知限制

| 限制 | 说明 |
| --- | --- |
| 异步上限约 300 秒 | 轮询在请求内完成，受 Serverless 限制。`timeoutMs` 再大也不会被兑现 |
| 不跨 spec 组合 | 一个供应商内可以按模型选 spec，但不能把两份 spec 的请求**拼**在一起 |
| `$fetch` 只支持一步 | id → url 可以；「A 换 B 再换 C」不行 |
| 不拼接流式音频 | `responseMode: "sse"` 只汇总 **url 类** items；跨事件拼接音频字节流不支持 |
| 无对象存储 | 上传图片要转成 URL 得自己先传好，再用常量或 `$firstPresent` 引用（§17.6） |
| 无重试 / 无故障转移 | 媒体按件计费，自动重试可能重复扣费，故不做 |
| 扩展新原语要改代码 | 协议刻意不执行代码，代价就是这里 |

---

## 16. 完整示例

以下都是**真实跑过引擎**的 spec。

### 16.1 MiniMax 文生图 + 主体参考

```jsonc
{
  "specVersion": 2,
  "capability": "image.generate",
  "displayName": "MiniMax Image (image-01 / image-01-live)",
  "transport": { "method": "POST", "path": "/v1/image_generation", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model", "prompt": "$.prompt", "n": "$.n", "seed": "$.seed",
    "style": "$.style",
    "prompt_optimizer": "$.promptOptimizer",
    "aigc_watermark": "$.watermark",
    "aspect_ratio": { "$mapSize": { "path": "$.size",
      "table": { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3",
                 "1792x1024": "16:9", "1024x1792": "9:16" },
      "default": "1:1" } },
    "response_format": { "$enum": { "path": "$.responseFormat",
      "map": { "b64_json": "base64", "url": "url" }, "default": "url" } },
    "subject_reference": { "$ifPresent": { "$.image": [
      { "type": "character", "image_file": { "$dataUrl": "$.image" } } ] } }
  },
  "response": {
    "items": { "$from": "$.data.image_urls", "$to": { "kind": "url", "value": "$" } },
    "itemsB64": { "$from": "$.data.image_base64", "$to": { "kind": "base64", "value": "$" } },
    "successCount": "$.metadata.success_count",
    "errorCode": "$.base_resp.status_code",
    "errorMessage": "$.base_resp.status_msg"
  },
  "errors": [
    { "when": { "$eq": ["$.base_resp.status_code", 1002] }, "status": 429, "code": "rate_limited" },
    { "when": { "$eq": ["$.base_resp.status_code", 1008] }, "status": 402, "code": "upstream_credit_exhausted" },
    { "when": { "$eq": ["$.base_resp.status_code", 1026] }, "status": 400, "code": "content_filter" },
    { "when": { "$eq": ["$.base_resp.status_code", 2013] }, "status": 400, "code": "bad_request" },
    { "when": { "$eq": ["$.base_resp.status_code", 1004] }, "status": 502, "code": "upstream_auth_failed" },
    { "when": { "$eq": ["$.base_resp.status_code", 2049] }, "status": 502, "code": "upstream_auth_failed" }
  ],
  "limits": { "maxN": 9, "timeoutMs": 120000 },
  "metadata": {
    "modes": ["text-to-image", "image-to-image"],
    "edit_mode": "reference",
    "sizes": ["1024x1024", "1536x1024", "1024x1536", "auto"],
    "max_n": 9,
    "max_reference_images": 1
  }
}
```

> `edit_mode: "reference"` 是**如实标注**：MiniMax 的「图生图」是**主体参考**（保持人物一致），
> **不是**遮罩/指令编辑。`/v1/images/edits` 的 mask 会被忽略。要真正的指令式编辑需接
> OpenAI `gpt-image-1` 或 Gemini。
>
> `$.responseFormat` 与 `$.response_format` 等价（§6.1），两种拼写都对。

### 16.2 V1 视频：轮询只回 `file_id`，用 `$fetch` 换地址

```jsonc
{
  "specVersion": 2,
  "capability": "video.generate",
  "displayName": "MiniMax Video V1 (Hailuo-02 / T2V-01)",
  "models": ["minimax-hailuo-02", "minimax-t2v-01"],
  "transport": { "method": "POST", "path": "/v1/video_generation", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "prompt": "$.prompt",
    "duration": "$.duration",
    // 合法值只有 720P / 768P / 1080P —— 映射表里不要写不存在的档位
    "resolution": { "$enum": { "path": "$.size",
      "map": { "1280x720": "768P", "1920x1080": "1080P" }, "default": "768P" } }
  },
  "response": {
    "taskId": "$.task_id",
    "status": "$.status",
    "items": [ { "kind": "url", "value": { "$fetch": {
        "path": "$.file_id",
        "url":  "/v1/files/retrieve?file_id={{ $.file_id }}",
        "pick": "$.file.download_url" } } } ],
    "successCount": { "$const": 1 },
    "errorCode": "$.base_resp.status_code",
    "errorMessage": "$.base_resp.status_msg"
  },
  "async": {
    "submitTaskId": "$.task_id",
    "poll": { "method": "GET", "path": "/v1/query/video_generation?task_id={{taskId}}",
              "intervalMs": 5000, "timeoutMs": 240000,
              "statusPath": "$.status",
              "statusMap": { "Success": "ok", "Fail": "fail", "": "wait" } }
  },
  "errors": [
    { "when": { "$eq": ["$.base_resp.status_code", 1002] }, "status": 429, "code": "rate_limited" },
    { "when": { "$eq": ["$.base_resp.status_code", 1008] }, "status": 402, "code": "upstream_credit_exhausted" },
    { "when": { "$eq": ["$.base_resp.status_code", 1026] }, "status": 400, "code": "content_filter" }
  ],
  "limits": { "maxN": 1, "timeoutMs": 240000 },
  "metadata": { "modes": ["text-to-video"], "async": true, "sizes": ["1280x720", "1920x1080"] }
}
```

> `"value": "$.file_id"` 是错的——客户端会拿到 `"205258526306433"` 当 URL，打不开。

### 16.3 V2 视频：不同端点、不同请求形状、不同错误体系

和 16.2 **并存于同一个供应商**，靠 `models` 分流。

```jsonc
{
  "specVersion": 2,
  "capability": "video.generate",
  "displayName": "MiniMax Video V2 (H3)",
  "models": ["minimax-h3"],
  "transport": { "method": "POST", "path": "/v2/video_generation", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "content": [ { "type": "text", "text": "$.prompt" } ],   // V2 不是 prompt，是 content[]
    "duration": "$.duration",
    "resolution": { "$enum": { "path": "$.size",
      "map": { "1280x720": "768P", "1920x1080": "2K" }, "default": "768P" } }
  },
  "response": {
    "taskId": "$.task_id",
    "status": "$.task.status",
    "items": [ { "kind": "url", "value": "$.task.content.url" } ],  // V2 直接给 url
    "successCount": { "$const": 1 },
    "errorCode": "$.error.type",
    "errorMessage": "$.error.message"
  },
  "async": {
    "submitTaskId": "$.task_id",
    "poll": { "method": "GET", "path": "/v2/query/video_generation/{{taskId}}",  // 路径参数，不是 query
              "intervalMs": 5000, "timeoutMs": 240000,
              "statusPath": "$.task.status",
              "statusMap": { "succeeded": "ok", "failed": "fail", "cancelled": "fail", "": "wait" } }
  },
  // V2 用真实 HTTP 状态码 + error.type，不是 base_resp —— 只写 when 的规则永远不会触发
  "errors": [
    { "httpStatus": 402, "status": 402, "code": "upstream_credit_exhausted" },
    { "httpStatus": 429, "status": 429, "code": "rate_limited" },
    { "httpStatus": 401, "status": 502, "code": "upstream_auth_failed" },
    { "httpStatus": 400, "status": 400, "code": "bad_request" },
    { "when": { "$eq": ["$.error.type", "insufficient_balance_error"] }, "status": 402, "code": "upstream_credit_exhausted" }
  ],
  "limits": { "maxN": 1, "timeoutMs": 240000 },
  "metadata": { "modes": ["text-to-video"], "async": true }
}
```

### 16.4 TTS：上游默认吐 hex

```jsonc
{
  "specVersion": 2,
  "capability": "audio.tts",
  "displayName": "MiniMax T2A v2 (speech-2.8-hd)",
  "transport": { "method": "POST", "path": "/v1/t2a_v2", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "text": "$.input",
    "stream": false,
    "voice_setting": { "voice_id": { "$ifPresent": { "$.voice": "$.voice" } },
                       "speed": "$.speed", "vol": 1, "pitch": 0 },
    "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "channel": 1,
      "format": { "$enum": { "path": "$.responseFormat",
        "map": { "mp3": "mp3", "wav": "wav", "pcm": "pcm" }, "default": "mp3" } } },
    "output_format": { "$const": "url" }        // ← 不写就是 hex
  },
  "response": {
    "items": [ { "kind": "url", "value": "$.data.audio" } ],
    "successCount": { "$const": 1 },
    "errorCode": "$.base_resp.status_code",
    "errorMessage": "$.base_resp.status_msg"
  },
  "errors": [
    { "when": { "$eq": ["$.base_resp.status_code", 1002] }, "status": 429, "code": "rate_limited" },
    { "when": { "$eq": ["$.base_resp.status_code", 1008] }, "status": 402, "code": "upstream_credit_exhausted" },
    { "when": { "$eq": ["$.base_resp.status_code", 1026] }, "status": 400, "code": "content_filter" }
  ],
  "limits": { "timeoutMs": 120000 },
  "metadata": { "modes": ["text-to-speech"] }
}
```

> **如果上游只能吐 hex**，把 items 改成
> `"items": [ { "kind": "base64", "encoding": "hex", "value": "$.data.audio" } ]`，
> 引擎会转成客户端能解码的 base64：
>
> ```jsonc
> // ✘ 错：客户端拿到 49443304… 去 base64 解码 → 乱码，全程不报错
> "items": [ { "kind": "base64", "value": "$.data.audio" } ]
> // ✔ 对：声明上游编码，引擎负责转
> "items": [ { "kind": "base64", "encoding": "hex", "value": "$.data.audio" } ]
> ```
>
> `output_format: "url"` 时 URL **24 小时**有效。

### 16.5 STT：multipart 上传 + header 参数

```jsonc
{
  "specVersion": 2,
  "capability": "audio.stt",
  "displayName": "MiniMax ASR (asr-1.0)",
  "transport": {
    "method": "POST", "path": "/v1/speech_to_text",
    "contentType": "multipart/form-data",
    "headers": { "language": "$.language" }   // ← 厂商要 HTTP 头，不是表单字段
  },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "file": { "$file": { "path": "$.image", "filename": "$.filename", "contentType": "audio/mpeg" } },
    "response_format": { "$const": "json" }
  },
  "response": {
    "text": "$.text",
    "taskId": "$.trace_id",
    "errorCode": "$.base_resp.status_code",
    "errorMessage": "$.base_resp.status_msg"
  },
  "limits": { "timeoutMs": 120000 },
  "metadata": { "modes": ["speech-to-text"] }
}
```

### 16.6 TTS 形态 B：上游直接返回音频字节

```jsonc
{ "responseMode": "binary", "request": { "model": "$.model", "input": "$.input", "voice": "$.voice" } }
```

客户端在 `/v1/audio/speech` 直接拿到 `audio/mpeg` 字节（OpenAI 兼容行为）。

### 16.7 上传图片到对象存储再传 URL

```jsonc
"image_file": { "$enum": { "path": "$.image", "map": {}, "default": "https://my-cdn/ref.png" } }
```

（先用外部流程把 `$.image` 传上去，再把固定 URL 填进 `subject_reference`；本协议不内置对象存储。）

### 16.8 第二家厂商：OpenAI 兼容的图片接口

前面 16.1–16.5 都是 MiniMax。**协议不是 MiniMax 专用的**——同一个模型、同一套原语，
换一个字段命名完全不同的厂商照样用。OpenAI 的图片接口就是最短的一例：

```jsonc
{
  "specVersion": 2,
  "capability": "image.generate",
  "displayName": "OpenAI Images (gpt-image-1 / dall-e-3)",
  "transport": { "method": "POST", "path": "/v1/images/generations", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "prompt": "$.prompt",
    "n": "$.n",
    "size": { "$enum": { "path": "$.size",
      "map": { "1024x1024": "1024x1024", "1536x1024": "1536x1024", "1024x1536": "1024x1536" },
      "default": "1024x1024" } },
    "quality": "$.quality",
    "style": "$.style",
    "response_format": "$.responseFormat"
  },
  "response": {
    // 同一个 `data` 数组里，url 和 b64_json 是**互斥**的两种形态（取决于上游给了哪个）。
    // `$ifPresent` 的数组写法：按顺序试，第一个「键存在」的分支生效；都不存在就丢掉这一项。
    // ⚠️ 不要用 $firstPresent 做这件事——它取的是「第一个能取到值的标量」，
    //    对 {kind,value} 这种对象无效（对象永远不是 undefined，第一个分支会永远命中）。
    "items": { "$from": "$.data", "$to": { "$ifPresent": [
      { "$.url": { "kind": "url", "value": "$.url" } },
      { "$.b64_json": { "kind": "base64", "value": "$.b64_json" } }
    ] } },
    "errorCode": "$.error.code",
    "errorMessage": "$.error.message"
  },
  "errors": [
    { "httpStatus": 400, "status": 400, "code": "bad_request" },
    { "httpStatus": 401, "status": 502, "code": "upstream_auth_failed" },
    { "httpStatus": 429, "status": 429, "code": "rate_limited" },
    { "when": { "$eq": ["$.error.code", "content_policy_violation"] }, "status": 400, "code": "content_filter" },
    { "when": { "$eq": ["$.error.code", "moderation_blocked"] }, "status": 400, "code": "content_filter" }
  ],
  "limits": { "maxN": 4, "timeoutMs": 180000 },
  "metadata": { "modes": ["text-to-image", "image-to-image"], "edit_mode": "mask", "sizes": ["1024x1024", "1536x1024", "1024x1536"], "max_n": 4 }
}
```

对照 MiniMax 那份，注意几个**完全不同但都能表达**的地方：

| | MiniMax 16.1 | OpenAI 16.8 |
| --- | --- | --- |
| 尺寸 | `aspect_ratio` + `$mapSize`（比例） | `size` 原样透传 |
| 产物 | 两个独立数组 `image_urls` / `image_base64` | 同一个数组里每项二选一 → `$ifPresent` 多分支 |
| 错误 | HTTP 200 + `base_resp.status_code` | HTTP 4xx + `$.error.code` → `httpStatus` |
| 编辑 | 主体参考（`edit_mode:"reference"`） | 遮罩编辑（`edit_mode:"mask"`） |

---

## 17. 交稿前自查（十二条，每条都有真实翻车案例）

这七条都真实发生过，且**都不会在保存时报错**——只有跑起来才暴露：

1. **`$dataUrl` 用到 `response` 里**（最隐蔽）
   → `$dataUrl` 往请求里用，base64 往响应里用（§6.4）。

2. **客户端没传、但厂商 required 的参数没兜默认值**
   → 翻厂商 `required:` 列表，凡是对外端点没有对应入参的，用 `$firstPresent` 补默认（§6.3）。
   典型：MiniMax 视频 V2 的 `duration`。

3. **厂商的业务错误状态码没映射**
   → 内容拦截不一定是 400，MiniMax V2 用 **422**。`400/401/402/422/429/529` 一个都别漏（§8）。

4. **异步终态漏了一种写法**
   → 同一厂商文档里成功可能写 `Success` 也可能写 `success`，失败可能写 `Fail` 也可能写
   `failed`。`statusMap` 两种都列，**并写 `""` 兜底**（§9.1）。漏一个 = 挂到超时。

5. **轮询路径拼错**
   → 官方是 `GET /v2/query/video_generation/{task_id}`，写成 `/v2/video_generation/query?task_id=`
   就全 404（段序和「路径参数 vs query」都要**逐字符对照**，§9）。

6. **multipart 里把字符串当布尔**
   → 厂商要 `stream: false`（布尔），`{"$const":"false"}` 在 multipart 里发出去是**字符串** `"false"`。
   布尔字段要么用 `$const: false`，要么干脆不写（用厂商默认值）。

7. **用空串「兜必填」**
   → 厂商 `lyrics` 是 `minLength: 1` 时，`{"$firstPresent":["$.lyrics",{"$const":""}]}` 会发空串
   直接 400。**省略字段通常优于发空值**——先确认厂商对「缺失」和「空串」的态度。

8. **图片/视频端点引用的键名拼错**
   → 两种拼写都通，但拼错的名字会让 `$enum` **静默落到 `default`**。对照 §6.1 核一遍。

9. **`baseUrl` 重复版本段**
   → `baseUrl` 带 `/v1` + `path` 带 `/v1/…` = `/v1/v1/…` 全 404（§13）。

10. **变换原语方向搞反**
    → `$dataUrl` / `$file` 只能往**请求**里用（响应里应该写 `value: "$.data.audio"`）；
    `$from` / `$fetch` 只能往**响应**里用。判官的 `PART 1` 会直接报出来。

11. **目录和实际能力对不上**
    → `metadata.modes` 写了没映射的模式、`metadata.max_n` 与 `limits.maxN` 不一致、
    `metadata.sizes` 少了映射表里支持的尺寸——客户端只看得见目录。

12. **同一 capability 多份 spec 却没写 `models`**
    → 保存会直接报错（§3.4）；别靠「第一份生效」。

> 外加一条常识：**`metadata.modes` 只写你真支持的**。写了 `image-to-video` 却没映射
> `first_frame_image`，客户端传图过来会被当文生视频跑，目录里却宣传着支持图生视频（§11）。

> ### 这份清单存在的原因
>
> 十二条里**没有一条能在保存时拦住你**——这正是它们危险的地方。每一类都真实发生过，
> 而且都是「自查表全绿、上线才发现」。
>
> 所以 §0.8 要求第 4/6/7/8 项**必须附上厂商文档原文**：写不出原文就说明没查，
> 而不是「已核对」。

---

## 18. 代码与测试位置

```
src/lib/media/spec.ts                    协议类型 + parseMediaSpec + validateMediaSpecs
src/lib/media/engine.ts                  引擎：作用域、原语、上游调用、编码归一、错误、异步
src/lib/media/handler.ts                 鉴权 → 解析 → 额度 → 执行 → 计费
src/lib/media/seeds.ts                   内置模板（MiniMax 图/视频V1+V2/语音、OpenAI 音频、通用异步视频）
src/lib/db/media-providers.ts            媒体供应商仓储 + 按模型选 spec
src/app/api/v1/{images,videos,audio}/…   六个对外端点
src/app/api/admin/media-providers/…      管理端点
src/app/(admin)/admin/media-providers/   后台页面（spec 编辑器 + 模板按钮）

scripts/spec-check.ts                    判官：静态检查 + 用合成上游跑引擎探针
                                        （pnpm spec-check <file.json>，不联网、不需密钥）

tests/unit/media-spec-check.test.ts      判官自身：内置模板必须全绿 + 必须能抓到已知事故
tests/unit/media-protocol-doc.test.ts    本文的示例可解析 + §0.3 速查表逐字段与 TS 接口同步
tests/unit/media-spec-v2.test.ts         v2 的六个能力点 + 校验面 + $ifPresent 多分支
tests/unit/media-engine.test.ts          原语、引擎（含异步轮询）
tests/unit/media-fetch.test.ts           $fetch（id → URL 兑换）
tests/integration/media-images.test.ts   图片端点 + 计费 + 目录元数据
tests/integration/media-audio-video.test.ts 视频/语音端点（异步、二进制、multipart）
```

> 本文里每个 `jsonc` 完整示例都会被脚本抽出来喂给 `parseMediaSpec()` 校验，
> **示例本身不允许写错**。
