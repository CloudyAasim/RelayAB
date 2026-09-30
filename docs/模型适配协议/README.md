# 模型适配协议（媒体能力 · specVersion 2）

> 新增或调整 **图片 / 视频 / 语音 / 音乐** 供应商时，只改后台里的 JSON，**不改代码、不重新部署**。
>
> 后台路径：`/admin/media-providers`　协议全文：本文　示例模板：后台的「导入模板」按钮

**本协议只有一个版本（`specVersion: 2`）。** 没有分支版本、没有厂商专用字段。
下面 §2 会说明它是怎么被反复实测出来的，以及每个字段为什么长这样。

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
> 动笔前先读本文 §6.1（每个端点到底有哪些 $.键）、§7.2（结果形态与编码）、
> §9（异步状态词表），交稿前按 §16.1 的六条自查。
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
| `$enum` | `{"$enum": {"path":…, "map":{…}, "default":…}}` | 换一套词汇 | `{"$enum":{"path":"$.responseFormat","map":{"b64_json":"base64"},"default":"url"}}` |
| `$mapSize` | `{"$mapSize": {"path":…, "table":{…}, "default":…}}` | 尺寸换算（`$enum` 的特例） | `1024x1024 → 1:1` |
| `$toString` | `{"$toString": "$.n"}` | 数字转字符串 | 厂商要 `"4"` 而客户端发了 `4` |
| `$dataUrl` | `{"$dataUrl": "$.image"}` | **请求方向**：裸 base64 → data URL | 上传图直接给厂商 |
| `$file` | `{"$file": {"path":…, "filename":…, "contentType":…}}` | **请求方向**：data URL → 真的 multipart 文件 | 需要 `contentType: multipart/form-data` |
| `$firstPresent` | `{"$firstPresent": ["$.a", "$.b"]}` | 取第一个有值的（不同套餐返回不同字段时） | `["$.data.audio", "$.data.url"]` |
| `$from` + `$to` | `{"$from": "$.data.urls", "$to": {…}}` | **响应方向**：数组逐项映射 | 见 §7 |
| `$merge` | `{"$merge": [<映射>, <映射>]}` | 合并多个对象 | |
| `$eq` | `{"$eq": [<映射>, <映射>]}` | 深度相等（主要用于 `errors.when`） | `{"$eq":["$.base_resp.status_code",1002]}` |
| `$fetch` | `{"$fetch": {"path":…, "url":…, "pick":…}}` | **响应方向**：拿到 id 再发一次 GET 换最终值 | 见 §7.3 |

只有 `$file` 依赖 `contentType: multipart/form-data`，其余原语与 contentType 无关。

> **映射对象里出现表以外的 `$xxx` 键会报错**，写错的原语名当场暴露。

### 6.3 `$dataUrl` 的方向

> ### ⚠️ `$dataUrl` 往**请求**里用，**响应**里绝不用
>
> - 请求：`{"$dataUrl": "$.image"}` 把上传的裸 base64 包成 `data:image/png;base64,…` 给厂商。
> - 响应：应该写 `"value": "$.data.audio"`。写成 `{"$dataUrl": "$.data.audio"}` 会得到
>   `data:image/png;base64,…`，客户端 `base64 -d` 直接失败。
>
> 响应方向要「还原」时用 `encoding: "dataUrl"`（§7.1）。

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

---

## 17. 交稿前自查（六条）

这六条都真实发生过，且**都不会在保存时报错**——只有跑起来才暴露：

1. **`$dataUrl` 用到 `response` 里**（最隐蔽）
   → `$dataUrl` 往请求里用，base64 往响应里用（§6.3）。

2. **图片/视频端点引用的键没在上表里**
   → 现在两个拼写都通，但如果键名本身拼错了，`$enum` 会**静默落到 `default`**。
   对照 §6.1 的表核一遍。

3. **异步状态漏了终态 / 没写兜底**
   → 用 `statusMap` 并**必须写 `""` 兜底项**（§9.1）。

4. **`baseUrl` 重复版本段**
   → `baseUrl` 带 `/v1` + `path` 带 `/v1/…` = `/v1/v1/…` 全 404（§13）。

5. **同一 capability 多份 spec 却没写 `models`**
   → 保存会直接报错（§3.4）；别靠「第一份生效」。

6. **把 hex / 资源 id 当成 base64 或 url 返回**
   → 声明 `encoding`，或用 `$fetch` 换（§7.2、§7.3）。

> 对着这六条过一遍，能挡掉绝大多数「保存成功但一调用就出问题」的情况。

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

tests/unit/media-spec-v2.test.ts         v2 的六个能力点 + 校验面
tests/unit/media-engine.test.ts          原语、引擎（含异步轮询）
tests/unit/media-fetch.test.ts           $fetch（id → URL 兑换）
tests/integration/media-images.test.ts   图片端点 + 计费 + 目录元数据
tests/integration/media-audio-video.test.ts 视频/语音端点（异步、二进制、multipart）
```

> 本文里每个 `jsonc` 完整示例都会被脚本抽出来喂给 `parseMediaSpec()` 校验，
> **示例本身不允许写错**。
