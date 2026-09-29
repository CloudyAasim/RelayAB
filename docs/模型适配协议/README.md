# 模型适配协议（Media Adapter Protocol）

> **这是权威参考文档**。面向两类读者：
> - **管理员**：照着厂商文档改一份 JSON，就能接入图片 / 视频 / 语音 / 音乐供应商，**不用改代码、不用重新部署**。
> - **维护者**：引擎只认这里列出的字段与原语；文档即契约，改引擎前先改这里。

---

## 1. 为什么有这套协议

不同厂商的媒体接口几乎没有共同形状：

| 维度 | 差异 |
| --- | --- |
| 端点 | `/v1/image_generation`、`/audio/speech`、`/api/v3/videos/…` |
| 鉴权 | `Authorization: Bearer`、`X-Api-Key`、`api-key` 查询参数 |
| 请求体 | JSON、multipart（含文件）、裸字节 |
| 尺寸表达 | `size: "1024x1024"`、`aspect_ratio: "16:9"`、`width/height` |
| 返回载体 | 公网 URL、base64、二进制流（音频） |
| 同步性 | 一次请求返回 / 提交拿 `task_id` 再轮询 |
| 错误 | HTTP 状态码，或「HTTP 200 但 body 里是错误码」 |

协议的做法是：**把厂商差异全部压进一份 spec（数据），引擎（代码）只负责解释 spec。**
所以新增/调整供应商 = 改后台 JSON；引擎保持通用。

### 明确不做的事

- **不执行任意代码**。spec 是声明式的，只有下面列出的原语；没有 `eval`、没有自定义函数。
  表达力不够时的正确做法是**扩展引擎原语**（惠及所有 spec），而不是给单个厂商写适配器。
- 不做供应商级故障转移（同一模型多个供应商时按 `priority` 取第一个，见 §12.3）。

---

## 2. 五分钟接入

1. 后台 **管理 → 媒体供应商 → 新增供应商**。
2. 点一个模板按钮：`MiniMax Image` / `OpenAI Audio` / `Async video vendor`，会填好 `models` 与 `specs`。
3. 改三处：
   - `baseUrl`：厂商接口根地址。**注意不要带 `/v1`**——spec 里的 `transport.path` 已经含 `/v1/…`，
     两者都带会拼出 `/v1/v1/…`（历史上踩过的坑）。自查方法：`baseUrl + transport.path`
     必须**正好等于**厂商文档里那条完整 URL。MiniMax 填 `https://api.minimax.cn`。
   - `models`：客户端模型名 → 上游模型名 + **每件多少整数积分**（`pricePerItem`，`0` = 免费；`100` = 100 积分/张）。
   - `specs`：按厂商文档改端点、鉴权、字段名、尺寸表达、错误码、**状态枚举**。
4. 填上游 API Key → **保存**。保存时服务端做结构校验，**保存即生效**。

> 交给 AI 写 spec 时，把本文档整份给它即可；最容易出错的三类问题（`$dataUrl` 用错、
> 异步状态枚举照抄不全、`baseUrl` 重复版本段）都整理在 **§16.1 常见错误**。

### 2.1 交给 AI 写 spec：请要求它按这个格式输出

后台的**两个输入框是分开的**（上面 `models`、下面 `specs`），所以 AI 的输出也必须是
**两个独立的 JSON 块**，顺序固定：

````text
【第一块：models —— 扁平对象，key 是客户端模型名】
{ "minimax-image-01": { "upstreamId": "image-01", "pricePerItem": 100, "enabled": true } }

【第二块：specs —— 扁平数组，一个 capability 一份 spec】
[ { "capability": "image.generate" }, { "capability": "video.generate" } ]
````

> ### ⚠️ 三条格式硬要求
>
> 1. **不要合并**成 `{"models": {…}, "specs": […]}` 这种单一对象——那没法直接粘进两个框，
>    得先手工拆开。
> 2. **不要按「图片 / 视频 / 语音 / 音乐」分组或嵌套**。`specs` 就是一个**平铺数组**，
>    每个元素自带 `capability` 字段，靠它区分用途，不靠外层结构。
> 3. `models` 是**扁平对象**：不要写成 `[{…}, {…}]` 数组，也不要按模态再分一层
>    `{"image": {…}, "video": {…}}`。
>
> 可以直接把这段要求发给 AI：
>
> ```text
> 请严格按「两个独立的 JSON 块」输出：第一块是 models（扁平对象，key=客户端模型名），
> 第二块是 specs（扁平数组，每份 spec 用 capability 字段自描述）。
> 不要把两者合并，也不要按图片/视频/语音/音乐分组或嵌套。
> ```
>
> 贴的时候：上面那个框贴 `models`，下面那个框贴 `specs`。

---

## 3. 数据模型

### 3.1 媒体供应商（独立于聊天 Provider）

```
MediaProvider {
  id, name, baseUrl, encryptedApiKey, enabled, priority,
  models: { [客户端模型名]: MediaModelConfig },
  specs:  MediaSpec[],          // 每种能力一份
  createdAt, updatedAt
}
```

一个供应商的多份 spec **共用**同一份密钥与 `models`。

### 3.2 模型行

```
MediaModelConfig {
  upstreamId:   string   // 发给厂商的模型名
   pricePerItem: number   // **每件多少整数积分**（100 = 100 积分/张；0 = 免费）
                         // 内部按 0.001 积分单位存储，由引擎换算，不要自己乘
  enabled:      boolean
}
```

### 3.3 解析顺序

`客户端模型名` → 找 `models` 里命中且 `enabled` 的供应商 → 按 `priority` 升序（同序按 name）
→ 再按本次调用的 `capability` 选 spec。找不到就是 `model_not_found`（404）。

---

## 4. 能力与对外端点

| capability | 对外端点 | 请求 | 归一化响应 |
| --- | --- | --- | --- |
| `image.generate` | `POST /v1/images/generations` | JSON | `{created, data:[{url}|{b64_json}]}` |
| `image.edit` | `POST /v1/images/edits` | multipart `image[,mask],prompt,model[,n,size,response_format]` | 同上 |
| `video.generate` | `POST /v1/videos/generations` | JSON `{model,prompt[,n,size]}` | `{created, id?, status:"succeeded", data:[…]}` |
| `music.generate` | `POST /v1/audio/music` | JSON `{model,prompt[,n]}` | 同上 |
| `audio.tts` | `POST /v1/audio/speech` | JSON `{model,input,voice?,speed?,response_format?}` | **上游音频字节原样返回** |
| `audio.stt` | `POST /v1/audio/transcriptions` | multipart `file,model[,language,prompt]` | `{text, id?}` |

媒体模型**只出现在** `GET /v1/models`；**不出现在** `GET /anthropic/v1/models`（那个面没有媒体端点）。
与聊天模型的互斥由解析层保证：图片端点收到聊天模型 → 404 `model_not_found`；
聊天端点收到图片模型 → 400 `model_not_mapped`。两种模型**不能同名**（保存时应校验）。

### 4.1 管理端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/admin/media-providers` | 列出（**不含**密钥明文） |
| `POST /api/admin/media-providers` | 新建：`{name, baseUrl, apiKey, models, specs, enabled?, priority?}` |
| `GET/PATCH/DELETE /api/admin/media-providers/[id]` | 查看 / 改（`PATCH` 省略 `apiKey` 即保留原密钥；`specs` 整份替换）/ 删除 |

---

## 5. spec 字段参考

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `specVersion` | `1` | 是 | 协议版本 |
| `capability` | 见 §4 | 是 | 这份 spec 服务哪种能力 |
| `displayName` | string | 否 | 后台展示名 |
| `transport.method` | `"POST" \| "GET"` | 是 | |
| `transport.path` | string | 是 | **相对 `baseUrl`**，必须以 `/` 开头 |
| `transport.contentType` | `"application/json" \| "multipart/form-data"` | 否 | 默认 `application/json` |
| `transport.headers` | `{[k]:string}` | 否 | 固定附加头 |
| `transport.query` | `{[k]:string}` | 否 | 固定附加查询参数 |
| `auth` | object | 是 | 见 §5.1 |
| `request` | 映射树 | 否 | 归一化输入 → 上游请求体 |
| `response` | 映射树 | 否 | 上游响应 → 归一化结果（见 §7） |
| `responseMode` | `"json" \| "binary" \| "stream"` | 否 | 默认 `json` |
| `errors` | ErrorRule[] | 否 | 见 §8 |
| `async` | object | 否 | 见 §9 |
| `limits.maxN` | number | 否 | 超过则在**调用上游之前**拒绝（不计费） |
| `limits.timeoutMs` | number | 否 | 单次上游调用超时 |
| `metadata` | object | 否 | 自由字段，原样透出到 `/v1/models` 的 `relay` |

### 5.1 鉴权

```jsonc
"auth": { "type": "bearer" }                                   // Authorization: Bearer <key>
"auth": { "type": "header", "name": "X-Api-Key" }              // X-Api-Key: <key>
"auth": { "type": "header", "name": "Authorization", "prefix": "Bearer " }
"auth": { "type": "query",  "name": "api-key" }                // ?api-key=<key>
"auth": { "type": "none" }
```

---

## 6. 映射语法

映射树是一个 JSON 值，按类型递归求值。**求值为 `undefined` 的键会被整体丢弃**——这就是
「客户端没传的字段别发给上游」。

| 写法 | 含义 |
| --- | --- |
| `"$.a.b"` | 从**归一化输入**里取路径 |
| `"$.a[0].b"` | 数组下标 |
| `"$"` | 整个作用域（数组投影里表示「当前元素」） |
| `"hi {{ $.voice }}!"` | 模板插值；未定义替换为空串 |
| `42` / `true` / `null` | 字面量 |
| `[ … ]` | 数组，逐项求值 |
| `{ "k": <映射> }` | 对象，逐键求值（丢弃 undefined） |
| `{ "$原语": … }` | 变换，见 §6.1 |

### 6.1 归一化输入里有什么

`$` 根作用域是「客户端这次请求」归一化后的结果。`model` 一律是**上游模型名**
（已按 `models[].upstreamId` 替换），spec 不需要再映射一次。

| 端点 | 固定注入的键 |
| --- | --- |
| `/v1/images/generations` | `model` `prompt` `n` `size` `responseFormat` `seed` `style` `watermark` `promptOptimizer` |
| `/v1/images/edits` | `model` `prompt` `image`（上传图的 data URL）`n` `size` `responseFormat` `seed` |
| `/v1/videos/generations` | `model` `prompt` `n` `size` `seed` |
| `/v1/audio/music` | `model` `prompt` `n` |
| `/v1/audio/speech` | `model` `input`（待合成文本）`voice` `speed` `responseFormat` |
| `/v1/audio/transcriptions` | `model` `image`（上传音频的 data URL）`language` `prompt` `temperature` `filename` |

除上表外，**客户端请求体里的其余字段会按原名（snake_case）注入到 `$` 根作用域**，
所以 `$.lyrics`、`$.duration`、`$.response_format` 这类自定义字段可以直接引用。

> 两个容易搞混的点：
> - `response_format`（snake_case，请求体原样注入）与 `responseFormat`
>   （camelCase，路由归一化后的标准字段）**是两个不同的键**。图 / 音乐 / TTS 用哪个都行，
>   但 **`audio.stt` 目前只透出上表那几项**，`$.response_format` 取不到值，
>   会落到 `$enum.default`（见 §15 限制）。
> - 客户端没传的字段是 `undefined`，会被整体丢弃（上游才用自己的默认值）。
>   想「有值才发」请用 `$ifPresent`。

### 6.2 变换原语

| 原语 | 完整写法 | 作用 | 例 |
| --- | --- | --- | --- |
| `$const` | `{"$const": <任意>}` | 固定值 | `{"$const": "jpg"}` |
| `$ifPresent` | `{"$ifPresent": {"<路径>": <映射>}}` | 路径有值才输出 | `{"$ifPresent": {"$.image": [{"type":"character","image_file":{"$dataUrl":"$.image"}}]}}` |
| `$enum` | `{"$enum": {"path":…, "map":{…}, "default":…}}` | 词表映射 | `{"$enum":{"path":"$.response_format","map":{"b64_json":"base64","url":"url"},"default":"url"}}` |
| `$mapSize` | `{"$mapSize": {"path":…, "table":{…}, "default":…}}` | 尺寸/比例换算 | `{"$mapSize":{"path":"$.size","table":{"1024x1024":"1:1","1536x1024":"3:2"},"default":"1:1"}}` |
| `$dataUrl` | `{"$dataUrl": "<路径>"}` | **仅用于 `request` 里「上游要一张图」的场景**：`data:` / `http(s)://` 原样透传；裸 base64 包成 `data:image/png;base64,…` | |
| `$file` | `{"$file": {"path":…, "filename":…, "contentType":…}}` | 生成**真正的 multipart 文件分片** | `{"$file":{"path":"$.image","filename":"$.filename","contentType":"audio/mpeg"}}` |
| `$from` + `$to` | `{"$from": "<路径>", "$to": <映射>}` | 数组逐项投影 | `{"$from":"$.data.image_urls","$to":{"kind":"url","value":"$"}}` |
| `$merge` | `{"$merge": [<映射>, <映射>]}` | 合并多个对象 | |
| `$eq` | `{"$eq": [<映射>, <映射>]}` | 深度相等（主要用于 `errors.when`） | `{"$eq":["$.base_resp.status_code",1002]}` |

> `$file` 需要 `transport.contentType: "multipart/form-data"`；其余原语与 contentType 无关。

> ### ⚠️ `$dataUrl` 只在 `request` 里用，**绝不要用在 `response` 里**
>
> `$dataUrl` 的作用是「把输入图片整理成 data URL 发给上游」，产物带
> `data:image/png;base64,` 前缀。而 `response.items[].value`（`kind:"base64"`）
> 必须是**纯 base64 字符串**——客户端会把它直接写进 `b64_json` 再解码，套一层
> `data:` 前缀就解不出来。
>
> ```jsonc
> // ✘ 错：上游返回 base64 音频/图片时
> "items": [ { "kind": "base64", "value": { "$dataUrl": "$.data.audio" } } ]
> //   → 客户端收到 "data:image/png;base64,QUJDRA=="，解码失败
>
> // ✔ 对：普通路径原样透传
> "items": [ { "kind": "base64", "value": "$.data.audio" } ]
> //   → 客户端收到 "QUJDRA=="
> ```

---

## 7. 归一化契约

`response` 映射的结果里，引擎**只认**这些键：

| 键 | 类型 | 用途 |
| --- | --- | --- |
| `items` | `[{kind:"url"\|"base64", value:string}]` | 产物（`$from/$to` 造出来） |
| `itemsB64` | `[{kind:"base64", value:string}]` | 上游把 url 和 base64 分开返回时用 |
| `text` | string | STT 转写文本 |
| `status` | string | 异步轮询的状态 |
| `successCount` | number | **计费用的件数**；缺省按 `items` 长度 |
| `taskId` | string | 回传给客户端 + 异步轮询起点 |
| `errorCode` / `errorMessage` | any / string | 出错时把厂商原因带出来 |

> ### ⚠️ `value` 只有两种形态，不能带 `data:` 前缀
>
> | `kind` | `value` 必须是 | 客户端会怎么做 |
> | --- | --- | --- |
> | `"url"` | **完整可访问 URL**（`https://…`） | 直接当图片/音频地址用 |
> | `"base64"` | **纯 base64 字符串**（`QUJDRA==`） | 写进 `b64_json` 后 `base64 -d` 解码 |
>
> 带 `data:` 前缀会让客户端拿到坏掉的 URL / 无法解码的 `b64_json`，所以
> `value` 里**不要用 `$dataUrl`**——它专门给 `request` 用（见 §6.2）。

**`successCount` 很重要**：被内容安全拦截、没产出的部分**不计费**（见 §10）。上游只返回
一部分时，请显式写 `"successCount": "$.metadata.success_count"`，否则引擎按 `items`
长度计费，会把被拦掉的也算进去；固定产出一个文件时写 `{"$const": 1}`。

`responseMode: "binary" | "stream"` 时，以上全部不适用——引擎把上游响应体原样透传，不做 JSON 解析。

---

## 8. 错误处理

厂商有两种报错方式，协议都覆盖：

1. **HTTP 非 2xx** → 引擎默认转成 `502 upstream_error`（`errors` 没命中时）。
2. **HTTP 200 但 body 里是错误码**（MiniMax 就是这样）→ 用 `errors` 声明。

```jsonc
"errors": [
  { "when": {"$eq": ["$.base_resp.status_code", 1002]},
    "status": 429, "code": "rate_limited",       "message": "上游限流" },
  { "when": {"$eq": ["$.base_resp.status_code", 1026]},
    "status": 400, "code": "content_filter",     "message": "提示词被内容策略拦截" },
  { "when": {"$eq": ["$.base_resp.status_code", 1008]},
    "status": 402, "code": "upstream_credit_exhausted" },
  { "when": {"$eq": ["$.base_resp.status_code", 1004]},
    "status": 502, "code": "upstream_auth_failed" }
]
```

- `when` 在**原始响应**上求值（不是映射后的结果）。
- relay 自己的错误码（客户端能区分）：

| code | HTTP | 含义 |
| --- | --- | --- |
| `model_not_found` | 404 | 客户端模型名没有对应的媒体供应商/模型 |
| `capability_not_supported` | 400 | 该供应商不提供这个能力 |
| `n_too_large` | 400 | 超过 `limits.maxN`（**未调用上游、未计费**） |
| `invalid_request` | 400 | prompt/input 缺失或超长、上传文件超限 |
| `rate_limited` / `content_filter` / `upstream_credit_exhausted` / `upstream_auth_failed` / `bad_request` | 由 spec 定义 | 来自 `errors` |
| `upstream_unreachable` | 502 | 连不上上游 |
| `upstream_error` | 502 | 上游返回非 2xx 且无匹配规则 |
| `no_task_id` / `upstream_task_failed` | 502 | 异步任务异常 |
| `task_timeout` | 504 | 轮询超时 |
| `no_media` / `no_audio` | 502 | 成功但没有产物 |
| `quota_exceeded_credits` / `quota_exceeded_tokens` | 403 | 账号额度用尽（与聊天一致，**调用上游之前**判定） |

错误响应形状固定为：

```json
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

---

## 9. 异步供应商

```jsonc
"async": {
  "submitTaskId": "$.task_id",          // 从「提交响应」里取任务 id
  "poll": {
    "method": "GET",
    "path": "/v1/videos/{{taskId}}",   // 支持 {{taskId}}
    "intervalMs": 3000,
    "timeoutMs": 240000,
    "statusPath": "$.status",          // 说明：映射后的结果里 status 从哪来
    "successValues": ["SUCCEEDED", "success"],
    "failureValues": ["FAILED", "CANCELLED"]
  }
}
```

时序：提交 → 取 `taskId` → 每 `intervalMs` 轮询 → `status` 命中 `failureValues` 立即失败，
命中 `successValues`（或取到产物）则成功；超过 `timeoutMs` 报 `task_timeout`。

> ### ⚠️ `successValues` / `failureValues` 必须**逐字照抄**厂商文档的状态枚举
>
> 这两个数组是**精确字符串匹配、区分大小写**的。写错一个字符的后果不是报错，而是
> **一直轮询到 `timeoutMs` 才返回 504 `task_timeout`**——客户端白等好几分钟，
> 真实的失败原因也丢了（`task.status` 落在两个数组之外时，引擎拿不到失败态）。
>
> 写 spec 时请照抄厂商的枚举值，例如 MiniMax H3 的 `task.status` 是
> `Preparing` / `Queueing` / `Processing` / `Success` / `Fail`（注意是 **`Fail`**，
> 不是 `failed`、也不是 `Failed`）：
>
> ```jsonc
> "successValues": ["Success", "succeeded"],
> "failureValues": ["Fail", "fail", "Cancelled", "cancelled"]
> ```
>
> 自查：把你文档里出现的**每一个**终态字符串都列进去；不认识的中间态（如
> `Processing`）不用列，它们会继续等待。

**约束**：轮询在请求内完成，受 Serverless 函数上限约束（约 300 秒）。更长的任务协议暂不支持，
需要外部队列（见 §15）。

---

## 10. 计费

- 价格在 `models[客户端模型名].pricePerItem`：**每件多少整数积分**（`100` = 100 积分/张；`0` = 免费）。
  这是你在面板里直接填的数字；内部账本按 0.001 积分单位存储，换算由引擎完成（**不要自己乘 1000**）。
- 实际扣费 = `pricePerItem × 成功件数`；**失败 / 被内容安全拦截不计费**。
- 媒体**一律扣积分**，即使账号额度模式是「词元」（媒体没有自然词元数）。
- 用量行记录 `images`（件数）与 `capability`；聚合链路（`UsageLog` → `UsageAggregate` →
  用量页/接口）都带上了件数，可在用量页与 `/api/admin/usage` 看到。

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
    "sizes": ["1024x1024", "1536x1024", "1024x1536", "auto"],
    "max_n": 9,
    "max_reference_images": 1
  }
}
```

- `relay.kind`：`"media"` 或 `"chat"`——客户端据此区分，不靠「有没有 relay 块」。
- `provider` / `capability` 来自供应商与 spec；其余字段原样来自 `spec.metadata`。
- `edit_mode`：`"reference"`（主体参考）vs `"mask"`（真遮罩编辑）——**语义不同，别混用**。

---

## 12. 鉴权、权限与选择

1. **鉴权**：媒体端点用与聊天相同的 API Key（`Authorization: Bearer sk-relay-…`，也支持 `x-api-key` / `?api_key=`）。
2. **白名单**：Key 的 `allowedModels` 同样约束媒体模型；为空 = 全部可见。
3. **额度**：调用上游前按账号池判定（`quota_exceeded_*`），与聊天一致。
4. **优先级**：`priority` 升序，同序按名称；取第一个命中的供应商。

---

## 13. 安全边界

- spec **只能请求该供应商自己配置的 `baseUrl` 主机**：路径与查询参数由引擎拼装，越界即报错
  （防 SSRF / 防把 relay 当开放代理）。
- 不跟随到别的主机的重定向；无任意代码执行。
- 只有管理员能编辑；`models` / `specs` 保存前均做结构校验。
- 上传体积上限：图片参考图 10MB、音频 25MB（路由层拦截，spec 里 `limits` 可再限）。

---

## 14. 保存时的校验

保存（POST/PATCH）会先做结构校验，失败返回 400 并给出**带路径的错误**：

- `specVersion` 必须是 `1`；`capability` 必须是 §4 的六个之一；
- `transport.path` 必须是以 `/` 开头的字符串；`contentType` 只能两种；
- `auth.type` 只能是四种；`header`/`query` 必须有 `name`；
- 映射树里的 `$` 键必须**都是**变换原语（不能把原语和普通键混在一个对象里）；
- `errors[].status` 必须是数字、`code` 必须非空；
- `async.submitTaskId` / `async.poll.path` 必填。

---

## 15. 已知限制

| 限制 | 说明 |
| --- | --- |
| 异步上限 ~300s | 超时即 `task_timeout`；更长任务需外部队列，协议暂不支持 |
| 不执行代码 | 极特殊厂商可能需要扩展引擎原语（改代码），这是刻意的取舍 |
| 单供应商一密钥 | 同一厂商的不同端点若用不同密钥，需建成两行 |
| 客户端名唯一 | 媒体与聊天的客户端模型名不能同名 |
| 尺寸映射是表驱动 | 表里没有的尺寸走 `default`（协议不猜） |
| 无供应商故障转移 | 与聊天一致，取第一个命中的供应商 |
| TTS 只能回 JSON | 上游若把音频包在 JSON 里（MiniMax `t2a_v2` 就是），只能映射成 `b64_json`，**无法**返回 OpenAI 那种裸音频字节流——协议暂无「解出 base64 再当响应体」的模式 |
| `audio.stt` 的 `response_format` | 该端点只透出 §6.1 表内字段，spec 里写 `$.response_format` 取不到值，会落到 `$enum.default` |

---

## 16. 排查手册

| 现象 | 多半是 |
| --- | --- |
| `model_not_found` | `models` 里没有该客户端模型名 / 模型 `enabled:false` / 供应商 `enabled:false` |
| `capability_not_supported` | 缺该能力的 spec；或只声明了 `image.generate` 却没在 `metadata.modes` 里写 `image-to-image` |
| 上游 404/405 | `baseUrl` 与 `transport.path` 重复了 `/v1`（拼成 `/v1/v1/…`） |
| `upstream_auth_failed` / 401 | `auth` 类型或头名不对 |
| HTTP 200 但产物为 0 | `$from` 指错字段（对照 `data.*` 实际结构） |
| `no_task_id` | `response.taskId` 路径错，或厂商把 id 放在别的字段 |
| 一直 504 | `poll.successValues` / `failureValues` 与实际状态值对不上，永远不收敛（见 §9 警告） |
| 内容被拦但没提示 | `errors` 少了 `1026` 之类的规则，走了默认 502 |
| 客户端说 base64 解不开 | `response.items[].value` 用了 `$dataUrl`，混进了 `data:` 前缀（见 §7） |

### 16.1 常见错误（AI 写 spec 最容易踩的坑）

这三条都真实发生过，且**都不会在保存时报错**——只有跑起来才暴露：

1. **`$dataUrl` 用到 `response` 里**（最隐蔽）
   上游返回 base64 音频/图片时，应该写 `"value": "$.data.audio"`。写成
   `{"$dataUrl": "$.data.audio"}` 会得到 `data:image/png;base64,…`，客户端 `base64 -d` 直接失败。
   记法：**`$dataUrl` 往「请求里」用，base64 往「响应里」用。**

2. **异步状态枚举照抄不全**
   `Success` 写对了，`Fail` 写成 `failed` → 任务失败不会报错，客户端白等到超时。
   必须逐字复制厂商文档（区分大小写），见 §9。

3. **`baseUrl` 重复版本段**
   `baseUrl` 带 `/v1` + `path` 带 `/v1/…` = `/v1/v1/…` 全 404。
   自查：`baseUrl + transport.path` == 厂商文档里的完整 URL。

> 交作业前对着这三条过一遍，能挡掉绝大多数「保存成功但一调用就出问题」的情况。

---

## 17. 完整示例

### 17.1 MiniMax 文生图 + 主体参考（同步）

```jsonc
{
  "specVersion": 1,
  "capability": "image.generate",
  "displayName": "MiniMax Image (image-01 / image-01-live)",
  "transport": { "method": "POST", "path": "/v1/image_generation", "contentType": "application/json" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model", "prompt": "$.prompt", "n": "$.n", "seed": "$.seed",
    "aspect_ratio": { "$mapSize": { "path": "$.size",
      "table": { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3",
                 "1792x1024": "16:9", "1024x1792": "9:16" },
      "default": "1:1" } },
    "response_format": { "$enum": { "path": "$.response_format",
      "map": { "b64_json": "base64", "url": "url" }, "default": "url" } },
    "subject_reference": { "$ifPresent": { "$.image": [
      { "type": "character", "image_file": { "$dataUrl": "$.image" } } ] } }
  },
  "response": {
    "items": { "$from": "$.data.image_urls", "$to": { "kind": "url", "value": "$" } },
    "itemsB64": { "$from": "$.data.image_base64", "$to": { "kind": "base64", "value": "$" } },
    "successCount": "$.metadata.success_count",
    "taskId": "$.id",
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
  "metadata": { "modes": ["text-to-image", "image-to-image"], "edit_mode": "reference",
                "sizes": ["1024x1024", "1536x1024", "1024x1536", "auto"],
                "max_n": 9, "max_reference_images": 1 }
}
```

> 上例 `sizes` 里的 `1024x1536` 是竖图（宽 1024、高 1536）。实际可用的尺寸以 `specs` 里 `metadata.sizes` 为准。

### 17.2 TTS 形态 A：上游直接返回音频字节（`responseMode: "binary"`）

适合 OpenAI 这类 `/audio/speech` 直接吐 mp3/wav 的上游。此时 `response` 映射**不会被执行**，
引擎把上游响应体原样透传给客户端。

```jsonc
{
  "specVersion": 1, "capability": "audio.tts",
  "transport": { "method": "POST", "path": "/audio/speech" },
  "auth": { "type": "bearer" },
  "responseMode": "binary",
  "request": { "model": "$.model", "input": "$.input", "voice": "$.voice",
               "speed": "$.speed", "response_format": "$.responseFormat" },
  "limits": { "timeoutMs": 120000 },
  "metadata": { "modes": ["text-to-speech"] }
}
```

> 若上游把音频包在 JSON 里（MiniMax `t2a_v2`），**不能**用 `binary`——那会把整段 JSON 当音频返回。
> 那种情况用 **17.5 的写法**（保持 `json`，把 base64 映射到 `items`）。

### 17.3 STT（multipart 上传）

```jsonc
{
  "specVersion": 1, "capability": "audio.stt",
  "transport": { "method": "POST", "path": "/audio/transcriptions",
                 "contentType": "multipart/form-data" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "file": { "$file": { "path": "$.image", "filename": "$.filename",
                         "contentType": "audio/mpeg" } },
    "language": "$.language", "prompt": "$.prompt"
  },
  "response": { "text": "$.text", "taskId": "$.id" },
  "metadata": { "modes": ["speech-to-text"] }
}
```

### 17.4 异步视频（状态枚举照抄厂商文档）

```jsonc
{
  "specVersion": 1, "capability": "video.generate",
  "transport": { "method": "POST", "path": "/v2/video_generation" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "content": [ { "type": "text", "text": "$.prompt" } ],
    "resolution": { "$enum": { "path": "$.size",
      "map": { "1280x720": "768P", "1920x1080": "2K" }, "default": "768P" } },
    "duration": "$.duration"
  },
  "response": {
    "taskId": "$.task_id",
    "status": "$.task.status",
    "items": [ { "kind": "url", "value": "$.task.content.url" } ],
    "successCount": { "$const": 1 }
  },
  "async": {
    "submitTaskId": "$.task_id",
    "poll": { "method": "GET", "path": "/v2/query/video_generation/{{taskId}}",
              "intervalMs": 5000, "timeoutMs": 240000,
              "statusPath": "$.task.status",
              // ↓ 逐字照抄 MiniMax H3 的终态枚举（区分大小写）
              "successValues": ["Success", "succeeded"],
              "failureValues": ["Fail", "fail", "Cancelled", "cancelled"] }
  },
  "errors": [
    { "when": { "$eq": ["$.error.type", "insufficient_balance_error"] },
      "status": 402, "code": "upstream_credit_exhausted" },
    { "when": { "$eq": ["$.error.type", "rate_limit_error"] },
      "status": 429, "code": "rate_limited" }
  ],
  "limits": { "maxN": 1, "timeoutMs": 240000 },
  "metadata": { "modes": ["text-to-video"], "async": true }
}
```

> 中间态 `Preparing` / `Queueing` / `Processing` **不需要**写进任何数组——它们不是终态，
> 引擎会继续等。终态一个都不能漏：`Success` 大小写写错、或漏掉 `Fail`，都会退化成
> 「轮询满 240s 再报 504」，客户端白等。

### 17.5 TTS 形态 B：上游把音频包在 JSON 里（`$dataUrl` 的反面教材）

```jsonc
// ✘ 错：客户端会拿到 "data:image/png;base64,QUJDRA=="，解码失败
"response": { "items": [ { "kind": "base64", "value": { "$dataUrl": "$.data.audio" } } ] }

// ✔ 对：普通路径原样透传纯 base64
"response": { "items": [ { "kind": "base64", "value": "$.data.audio" } ] }
```

完整一段：

```jsonc
{
  "specVersion": 1, "capability": "audio.tts",
  "transport": { "method": "POST", "path": "/v1/t2a_v2" },
  "auth": { "type": "bearer" },
  "request": {
    "model": "$.model",
    "text": "$.input",
    "voice_setting": { "voice_id": { "$ifPresent": { "$.voice": "$.voice" } },
                       "speed": "$.speed", "vol": 1, "pitch": 0 },
    "audio_setting": { "sample_rate": 44100, "bitrate": 256000,
      "format": { "$enum": { "path": "$.responseFormat",
        "map": { "mp3": "mp3", "wav": "wav", "pcm": "pcm" }, "default": "mp3" } } }
  },
  "response": { "items": [ { "kind": "base64", "value": "$.data.audio" } ] },
  "metadata": { "modes": ["text-to-speech"] }
}
```

> 这类上游只能回 JSON，客户端在 `/v1/audio/speech` 拿到的是
> `{"data":[{"b64_json":"…"}]}` 而非裸音频字节（见 §15 限制）。

### 17.6 上传图片到对象存储再传 URL（`$dataUrl` 的另一种用法）

```jsonc
"image_file": { "$enum": { "path": "$.image", "map": {}, "default": "https://my-cdn/ref.png" } }
```

（先用外部流程把 `$.image` 传上去，再把固定 URL 填进 `subject_reference`；本协议不内置对象存储。）

---

## 18. 代码与测试位置

```
src/lib/media/spec.ts                    协议类型 + parseMediaSpec 校验
src/lib/media/engine.ts                  引擎：路径、原语、上游调用、错误、异步、binary/stream
src/lib/media/handler.ts                 鉴权 → 解析 → 额度 → 执行 → 计费
src/lib/media/seeds.ts                   内置模板（MiniMax / OpenAI 音频 / 异步视频）
src/lib/db/media-providers.ts            媒体供应商仓储
src/app/api/v1/{images,videos,audio}/…   六个对外端点
src/app/api/admin/media-providers/…      管理端点
src/app/(admin)/admin/media-providers/   后台页面（spec 编辑器 + 模板按钮）

tests/unit/media-engine.test.ts            协议校验、原语、引擎（含异步轮询）
tests/integration/media-images.test.ts     图片端点 + 计费 + 目录元数据
tests/integration/media-audio-video.test.ts 视频/语音端点（异步、二进制、multipart）
```
