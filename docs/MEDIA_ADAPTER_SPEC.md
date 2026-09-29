# 媒体适配协议（Media Adapter Protocol，specVersion 1）

> 面向**管理员**：如何只改后台里的 JSON，就把一个新的图片 / 视频 / 语音 / 音乐供应商接进来，
> **不需要改代码、不需要重新部署**。

## 1. 心智模型

一次媒体调用在 relay 里是这样流动的：

```
客户端（OpenAI 形状）
  │  /v1/images/generations  /v1/images/edits
  │  /v1/videos/generations  /v1/audio/speech  /v1/audio/transcriptions  /v1/audio/music
  ▼
路由：用 API Key 鉴权 → 模型名 → 找到「媒体供应商」→ 选出该能力对应的 spec
  ▼
引擎（src/lib/media/engine.ts）：按 spec 构造上游请求 → 调用上游 → 按 spec 解析响应
  ▼
归一化响应 → 按「每件积分」计费 → 记录用量（张数 + 能力）
```

**spec 是数据，不是代码。** 引擎只认识下面列出的字段和原语；厂商特有的东西全部被 spec 吸收。
如果你在 spec 里写了引擎不认识的键，后台保存时会直接报错，而不是等到半夜的请求里。

## 2. 五分钟接入

1. 打开 **管理后台 → 媒体供应商 → 新增供应商**。
2. 点一个模板按钮（`MiniMax Image` / `OpenAI Audio` / `Async video vendor`），它会把
   `models` 与 `specs` 填进编辑器。
3. 改三处：
   - `baseUrl`：厂商文档里的接口根地址；
   - `models`：客户端模型名 → 上游模型名，以及**每件积分**（0.001 积分单位，0 = 免费）；
   - `specs`：按厂商文档改字段名、鉴权头、尺寸表达、错误码。
4. 点「应用」在编辑框上（填入密钥）→ 保存。**保存即生效，不用部署。**

> 保存前会在服务端做一次结构校验；`specs` 格式有问题会返回 400 并指出具体路径。

## 3. 能力（capability）

| capability | 对外端点 | 归一化响应 |
| --- | --- | --- |
| `image.generate` | `POST /v1/images/generations` | `{created, data:[{url}\|{b64_json}]}` |
| `image.edit` | `POST /v1/images/edits` | 同上 |
| `video.generate` | `POST /v1/videos/generations` | `{created, id?, status:"succeeded", data:[…]}` |
| `music.generate` | `POST /v1/audio/music` | 同上 |
| `audio.tts` | `POST /v1/audio/speech` | 上游音频字节（原样透传） |
| `audio.stt` | `POST /v1/audio/transcriptions` | `{text, id?}` |

一个供应商可以有多份 spec（每种能力一份），共用同一份密钥与 `models`。

## 4. spec 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `specVersion` | 是 | 固定 `1` |
| `capability` | 是 | 上面六个之一 |
| `displayName` | 否 | 后台展示名 |
| `transport.method` | 是 | `POST` / `GET` |
| `transport.path` | 是 | **相对 `baseUrl`** 的路径，必须以 `/` 开头 |
| `transport.contentType` | 否 | `application/json`（默认）/ `multipart/form-data` |
| `transport.headers` / `.query` | 否 | 固定附加的头/查询参数 |
| `auth` | 是 | `{"type":"bearer"}` / `{"type":"header","name":…,"prefix":…}` / `{"type":"query","name":…}` / `{"type":"none"}` |
| `request` | 否 | 归一化输入 → 上游请求体的映射树 |
| `response` | 否 | 上游响应 → **归一化结果**的映射树（见第 6 节契约） |
| `responseMode` | 否 | `json`（默认）/ `binary` / `stream` |
| `errors` | 否 | 错误码 → HTTP 状态 + 错误码；`when` 在**原始响应**上求值 |
| `async` | 否 | 异步供应商：提交拿 `taskId` → 轮询 |
| `limits` | 否 | `maxN`（`n` 上限）、`timeoutMs` |
| `metadata` | 否 | 自由字段，原样透出到 `/v1/models` 的 `relay` 里 |

## 5. 映射原语

映射树是一个 JSON 值：

- 字符串：`"$.a.b[0].c"` → 从输入里取值；`"{{ $.a.b }}"` → 模板插值
- 数字 / 布尔 / `null` → 字面量
- 数组 → 逐项求值
- 对象 → 逐键求值，**结果为 `undefined` 的键会被丢弃**（这就是「客户端没传就别发」）
- 带 `$` 前缀的对象 → 变换：

| 原语 | 写法 | 作用 |
| --- | --- | --- |
| `$const` | `{"$const": 1}` | 固定值 |
| `$ifPresent` | `{"$ifPresent": {"$.image": <映射>}}` | 输入里有该路径才输出 |
| `$enum` | `{"$enum": {"path":"$.response_format","map":{"b64_json":"base64"},"default":"url"}}` | 值映射（协议词表不同） |
| `$mapSize` | `{"$mapSize": {"path":"$.size","table":{"1024x1024":"1:1"},"default":"1:1"}}` | 尺寸/比例表达转换 |
| `$dataUrl` | `{"$dataUrl": "$.image"}` | 公网 URL / data URL 原样透传，裸 base64 包成 data URL |
| `$file` | `{"$file": {"path":"$.image","filename":"$.filename","contentType":"audio/mpeg"}}` | 生成真正的 multipart 文件分片（STT 上传音频） |
| `$from` / `$to` | `{"$from":"$.data.image_urls","$to":{"kind":"url","value":"$"}}` | 数组逐项投影 |
| `$merge` | `{"$merge": [<映射>, <映射>]}` | 合并多个对象 |
| `$eq` | `{"$eq": ["$.code", 1002]}` | 比较（主要用于 `errors.when`） |

> 表达力不够时可以接 JSONata 之类的安全求值器；**不会**执行任意代码。

## 6. 归一化契约（引擎读什么）

`response` 映射的结果里，引擎只认这几个键：

```jsonc
{
  "items":     [{ "kind": "url" | "base64", "value": "…" }],  // 产物
  "itemsB64":  [{ "kind": "base64", "value": "…" }],          // 或者分开给
  "text":      "转写文本",                                      // STT
  "status":    "SUCCEEDED",                                     // 异步用
  "successCount": 2,                                            // 计费用；缺省按产物数
  "taskId":    "abc",                                           // 回传 + 异步轮询起点
  "errorCode": 1002, "errorMessage": "…"                        // 出错时带出原因
}
```

`successCount` 很重要：被内容安全拦截、没产出的部分**不计费**。

## 7. 异步供应商

```jsonc
"async": {
  "submitTaskId": "$.task_id",
  "poll": {
    "method": "GET", "path": "/v1/videos/{{taskId}}",
    "intervalMs": 3000, "timeoutMs": 240000,
    "statusPath": "$.status",
    "successValues": ["SUCCEEDED"], "failureValues": ["FAILED"]
  }
}
```

引擎在请求内提交并轮询到终态，客户端仍只收到一次响应。
**注意**：受 Serverless 函数上限约束（约 300 秒），更长的任务需要队列，协议暂不支持。

## 8. 二进制与流式

`responseMode: "binary"` 会把上游响应体原样读成字节返回（TTS 音频）；
`"stream"` 则直接透传上游的流，不落内存。两者都**不会**去 JSON 解析。

## 9. 计费

- 价格写在 `models[客户端模型名].pricePerItem`：**每件积分**（0.001 积分单位，0 = 免费）。
- 实际扣费 = `pricePerItem × successCount`，失败/被拦截不计。
- 媒体**一律扣积分**，即使账号是「词元」额度模式（图片没有自然词元数）。
- 用量行会记录 `images`（件数）与 `capability`，用量页能看到张数。

## 10. 安全

- spec 只能请求**该供应商自己配置的 `baseUrl` 主机**（防 SSRF），不支持重定向到别处。
- 引擎不执行任意代码，因此上传 spec 不等于上传脚本。
- 只有管理员能编辑；`models` / `specs` 保存前均做结构校验。

## 11. 排查

| 现象 | 多半是 |
| --- | --- |
| `capability_not_supported` | 供应商没有该能力的 spec；或 `metadata.modes` 未声明对应模式 |
| `model_not_found` | `models` 里没有这个客户端模型名，或该模型 `enabled:false`，或供应商 `enabled:false` |
| 上游 4xx/5xx | `transport.path` / 鉴权 / 字段名与文档不符；看返回体里的 `errorCode`、`errorMessage` |
| 一直 502 | 引擎无法连上游（baseUrl 或网络） |
| 返回 0 张图 | 上游返回的数组路径写错（`$from` 指错字段） |

## 12. 相关代码

```
src/lib/media/spec.ts        协议类型 + 校验
src/lib/media/engine.ts      引擎（路径、原语、上游调用、错误、异步）
src/lib/media/handler.ts     鉴权 → 解析 → 配额 → 执行 → 计费
src/lib/media/seeds.ts       内置模板（MiniMax / OpenAI 音频 / 异步视频）
src/lib/db/media-providers.ts  媒体供应商仓储
tests/unit/media-engine.test.ts             协议与引擎单测
tests/integration/media-images.test.ts      图片端点
tests/integration/media-audio-video.test.ts 视频/语音端点
```
