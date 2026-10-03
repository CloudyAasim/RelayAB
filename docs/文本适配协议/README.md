# 文本适配协议（文本供应商专用 · specVersion 1）

> 新增或调整**文本 / 对话**供应商时，只改这一份 JSON，**不改代码、不重新部署**。
>
> 后台路径：`/admin/providers`，每个服务商下方一个「上游协议」编辑器。
>
> **不配协议 = 原样透传。** 留空时中转站把客户端的请求体原封不动送到上游，这是
> 透明网关该有的默认行为，也是绝大多数 OpenAI 兼容中转的正确配置。

**本协议只有一个版本（`specVersion: 1`）。** 没有分版本、没有厂商专用字段。
下面第 2 节列出的每一条机制都在 `src/lib/protocol/text-spec.ts` 里有实打实的实现；
`tests/unit/text-protocol-doc.test.ts` 会逐项核对，**文档与实现对不上，测试就红**。

---

## 0. 给 AI 的操作说明

> **你在写 spec：读 §0.2 的排错流程、§1.3 是精确语义。** 其余章节是细节解释
> 和排查手册。**不准许时回 §0。**

### 0.1 你要产出什么

**一段 JSON 字符串**，存到该服务商的 `textSpec` 字段：

```json
{
  "specVersion": 1,
  "protocol": "openai-chat",
  "parameters": { "temperature": { "mode": "clamp", "min": 0, "max": 2 } },
  "errors": [{ "httpStatus": 429, "code": "rate_limited" }],
  "limits": { "timeoutMs": 600000 }
}
```

**硬性格式要求**（违反任何一条，运营者得手改）：

1. `specVersion` 固定为 `1`。
2. `protocol` 必须是 `openai-chat` / `openai-responses` / `anthropic-messages` /
   `gemini-generate` 之一。**不要写别的**——写错协议比不写更糟：不写是原样透传，
   写错是把请求改成了另一个协议的样子。
3. `parameters` 的每个规则必须带 `mode`，取值见 §1.3。
4. 所有 JSON 必须**严格合法**（无注释、无尾逗号）。

### 0.2 排错流程（照着做，每一步能真回厂商文档里指出来）

| # | 步骤 | 在厂商文档里找什么 | 写到 spec 的哪里 |
|---|---|---|---|
| 1 | **协议** | 端点路径和请求体最外层的键名 | `protocol` |
| 2 | **参数改名** | 同一个概念的两种叫法（如 `max_tokens` vs `max_completion_tokens`） | `parameters.<名>.mode = "rename"` |
| 3 | **参数嵌套** | 参数是否在子对象里（如 Gemini 的 `generationConfig`） | `to` 写点号路径 |
| 4 | **参数缺失** | 必填但客户端不会传 | `parameters.<名>.mode = "default"` + `value` |
| 5 | **厂商拒绝的参数** | 厂商明确不支持的（传了会 400） | `mode = "drop"` |
| 6 | **取值范围** | 文档写的合法区间 | `mode = "clamp"` + `min`/`max` |
| 7 | **错误码** | 每一个状态码的含义 | `errors[]` |

△ = 历史上的坑位、且**保存时不会报错**的三项；这些坑是真实厂商文档写出来的。
推理模型藏在 Anthropic 兼容面后面时，无条件发 `thinking` 块，客户端读 `content[0]`
会渲染空白。

> **不试线上接口体检（别参考文档，不是参考试）**
>
> 枚举一个字段的合法值时，**唯一正确动作是去读厂商文档**。不要想当然提交测试值：
> 枚举参数是**对生产接口**的仪器，会触发限流、拉爆并发窗口，甚至触发封号；
> 猜中名字但没猜中它真正要哪些媒体字段，你丢的是它在限流窗口里没有定位的能力。
>
> 文档里找不到时：**没有**。**写保守值并加注释**，待运营者手工加并注明。**这些比
> 接下来任何东西都重要**：
>
> 同一渠道，`fixtures` 要取自**文档中的响应示例**或**SDK 源码中的示例**，不是
> 拿你凭印象编的请求去打真实接口。
>
> 回头只做两件事：**兜底的是默认值**、**被忽略的留在原地**。

### 0.3 引擎行为的精确语义

本节是**引擎行为的规范说明**，不是示例（示例和断言脚本在 §0.7；按本节实现，
两者必须一致）。`tests/unit/text-protocol-doc.test.ts` 会逐项核对。

#### 0.3.1 策略先于翻译

```
1. 客户端请求体进来
2. 读该服务商的 textSpec；没有 / 不是合法 JSON / 没通过校验 → 当作没有（不报错）
3. 按 §1.3 对每个 parameters 规则依次裁决（顺序固定，见 §1.3.1）
4. 剩下什么就送什么
```

**第 2 步的静默降级是刻意的。** 运营者写错一次协议不该让这个服务商下线——
退回「原样透传」正好是接入协议之前的行为。

#### 0.3.2 映射求值 `applyMapping(node, scope)`

- 字符串：不以 `$` 开头且不含 `{{` → **字面量原样返回**（枚举表的每个值都是这样）
- `$.a.b[0].c` → 从 scope 取值；取不到返回 `undefined`，**该键整个不出现**
- `{ "$const": v }` → v
- `{ "$firstPresent": [a, b, …] }` → 第一个能取到值的分支
- `{ "$ifPresent": { "$.a": X, "$.b": Y } }` → `$.a` 存在且非空则 X，否则 Y
- `{ "$merge": {...} }` → 合并
- `$enum` / `$mapSize` / `$toString` / `$eq` —— 见媒体协议同名词条，语义一致

**文本 spec 禁止三个媒体算子**：`$fetch`、`$file`、`$dataUrl`。
`$fetch` 会把映射变成一个**会发 HTTP 请求的程序**；文本 spec 描述的是请求体，
不是程序。写进去 `parseTextSpec` 直接报错并**指名道姓**告诉你是哪个算子。

#### 0.3.3 深度与规模

- 映射树深度上限 **32**（`src/lib/protocol/text-spec-mapping.ts`）——运营者手写的
  文档不是程序，超深是笔误，而运营者上传的文件上无界递归是一个拒绝服务
- `textSpec` 字段最长 **200000** 字符
- `parameters` 规则条数不限（一个服务商不会有几百个），但每条都要通过 §1.3 的校验

---

## 1. 字段

### 1.1 `specVersion`（必填）

固定 `1`。写 `2` 会被拒，以免一个未来的版本被当成这一版读。

### 1.2 `protocol`（必填）

| 值 | 什么时候用 |
|---|---|
| `openai-chat` | 大多数厂商。**不确定就选它。** |
| `openai-responses` | 上游原生支持 `/v1/responses`（Codex CLI 直连） |
| `anthropic-messages` | Anthropic 官方或任何 `/v1/messages` 兼容上游 |
| `gemini-generate` | Gemini 的 `generateContent` |

### 1.3 `parameters`（可选）—— **每个参数怎么处置**

**没有列出的参数一律 `passthrough`。** 这是整个协议里承重的一条：一个把
「不认识就丢掉」当默认值的网关，会在厂商每次发新参数时静默吃掉它，而症状是
客户端以为自己要了 high reasoning、实际拿到的是默认值。

| mode | 含义 | 附加字段 |
|---|---|---|
| `passthrough` | 客户端传了就送 | — |
| `drop` | 客户端传了也不送 | — |
| `default` | 客户端**没传**时用 `value` | `value`（必填） |
| `force` | 不管客户端传没传都用 `value` | `value`（必填） |
| `clamp` | 保留客户端的值，但限制在区间内 | `min` / `max`（至少一个） |
| `rename` | 换个名字或换个位置送 | `to`（必填，可为点号路径） |

`to` 可以是点号路径：`"extra_body.thinking.type"` 会自动建出中间对象。

##### 1.3.1 裁决顺序（固定）

1. `drop`——列了就一定丢，且不再被后面的规则捡回来
2. `default`——只在客户端没传时生效
3. `clamp`——保留客户端的值
4. `force`——覆盖
5. `rename`——搬运并从原名删除

所以同一条参数上 `force` 赢 `clamp`。每次裁决都会记进 `decisions`，后台能看到
实际生效的是哪一条。

### 1.4 `request` / `response`（可选）

映射树，语法见 §0.3.2。绝大多数厂商**不需要写**——选了 `protocol` 预设就够。

### 1.5 `errors`（可选）

```json
[{ "httpStatus": 429, "code": "rate_limited", "message": "上游限流" }]
```

命中上游状态码时替换成中转站自己的错误码。

### 1.6 `limits`（可选）

`{ "timeoutMs": 600000 }`。**不要超过 600000**（serverless 上限），超了会在
保存时直接报错。

---

## 2. 预设

| 协议 | 它替你做了什么 |
|---|---|
| `openai-chat` | 透传全部；`temperature` 钳制 0–2；`max_tokens` 钳制到 131072 |
| `openai-responses` | `reasoning` 原样；`max_output_tokens` 原样 |
| `anthropic-messages` | `stop` → `stop_sequences`；`max_completion_tokens` → `max_tokens`；`temperature` 钳制 0–1；529 → `overloaded` |
| `gemini-generate` | 采样参数全部搬进 `generationConfig.*`；`reasoning_effort` 丢弃 |

预设只是**填好的 spec**，随时可以改。

---

## 3. 与媒体协议的关系

媒体协议（`docs/模型适配协议`）和本文档共用**同一套映射引擎**（`applyMapping` /
`getPath`，从 `src/lib/media/engine.ts` 导入，不是复制）。共用的是语法，不共用产物模型：

| | 媒体 | 文本 |
|---|---|---|
| 产物 | 多个 item，可轮询，可按件计费 | 一次回答 |
| 专有字段 | `items` `encodings` `async` | `protocol` `parameters` |
| 专有算子 | `$fetch` `$file` `$dataUrl` | **禁止使用这三个** |

---

## 4. 与实现对应

| 机制 | 实现位置 |
|---|---|
| 解析与校验 | `parseTextSpec` — `src/lib/protocol/text-spec.ts` |
| 映射树结构门 | `isValidSpecMapping` — `src/lib/protocol/text-spec-mapping.ts` |
| 策略裁决 | `applyParameterPolicy` — `src/lib/protocol/parameter-policy.ts` |
| 四个预设 | `TEXT_PROTOCOL_PRESETS` — `src/lib/protocol/text-protocols.ts` |
| 读取存储 | `readTextSpec` — `src/lib/protocol/text-spec.ts` |
| 写入校验 | `textSpec` 的 `superRefine` — `src/app/api/admin/providers/[id]/route.ts` |
| 后台编辑器 | `src/app/(admin)/admin/providers/TextProtocolPanel.tsx` |
| 代理接入 | `src/lib/proxy/openai.ts`、`src/lib/proxy/anthropic.ts` |
