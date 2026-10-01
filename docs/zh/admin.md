# 管理员文档

> RelayAB AI 网关管理员操作指南。

---

## 1. 访问管理后台

访问 `/admin` 路径，使用管理员账号登录后即可进入管理后台。

管理后台包含以下模块：
- **用户管理** (`/admin/users`) - 创建、编辑、删除用户
- **密钥管理** (`/admin/keys`) - 查看、创建、启用/禁用、删除 API Key
- **上游 Provider** (`/admin/providers`) - 管理 AI 上游提供商配置
- **媒体 Provider** (`/admin/media-providers`) - 声明式媒体提供商规格
- **用量** (`/admin/usage`) - 用量统计
- **设置** (`/admin/settings`) - 系统全局设置
- **文档** (`/admin/docs`) - 从仓库渲染的媒体适配协议

---

## 2. 用户管理

### 2.1 创建用户

1. 进入 **用户管理** 页面
2. 点击 **创建用户** 按钮
3. 填写表单：
   - **用户名** - 登录凭证，必填，3-32 字符
   - **密码** - 可选；**留空则会为你自动生成一个强密码**。你填的内容会按字面使用。
   - **显示名称** - 展示用，可选
   - **角色** - `admin`（管理员）或 `user`（普通用户）
4. 点击 **创建** 完成

### 2.2 分配额度

每个用户有一个共享额度池，该用户的所有 Key 都从同一个池中扣费。

1. 在用户列表找到目标用户
2. 点击用户卡片右下角的 **编辑** 按钮
3. 在弹窗中配置：
   - **额度类型** - `积分` 或 `tokens`
   - **额度上限** - 整数，新调用会被拒绝超过此上限
   - **快速充值** - 点击 +100 / +500 / +1000 快速增加额度
   - **模型白名单** - 空 = 可用所有模型，也可指定允许的模型列表
   - **最大活跃 Key 数** - 0 = 无上限

### 2.3 切断某用户的访问（没有"停用"开关）

> **用户无法被禁用。** 本文档早期版本描述过一个「禁用/启用」操作；它并不存在——
> 用户上没有 `disabled` 字段，没有切换端点，也没有 `user_disabled` 错误码。要停止
> 某个用户的访问，请改用以下方式之一：

- 在 **编辑** 中把 **额度上限** 设为 `0` —— 该用户所有 Key 的每次调用都会被拒绝，
  错误为 `quota_exceeded_credits`（或 `quota_exceeded_tokens`），而面板登录不受影响。
- 如果希望账号保留但凭证失效，可在 **密钥管理** 中逐个删除其 Key。
- 如果账号应当彻底消失，则删除该用户（见 §2.5）。

禁用某个用户的 *Key* 是另一个真实存在的独立功能——见 §3.3。

### 2.4 重置密码

1. 在操作菜单选择 **重置密码**
2. 系统生成新随机密码，请立即复制保存（只显示一次）
3. 让用户使用新密码登录后自行修改

### 2.5 删除用户

> 警告：删除用户会同时删除其所有 API Key，此操作不可恢复。

1. 在操作菜单选择 **删除**
2. 确认提示后永久删除

---

## 3. API Key 管理

### 3.1 创建 Key

1. 进入 **密钥管理** 页面
2. 点击 **创建 Key** 按钮
3. 填写表单：
   - **所属用户** - 必选，下拉选择
   - **标签** - 识别名称，如 "Alice 的笔记本"
   - **过期时间** - 可选，不填则永不过期
   - **允许的模型** - 可选，逗号分隔，不填则继承用户的模型白名单
4. 点击 **创建**
5. **重要**：创建成功后显示明文 Key，**仅此一次**，请立即复制保存

### 3.2 Key 与额度的关系

> 额度属于用户，不属于 Key。用户的所有 Key 共享同一个额度池。

这意味着：
- 给 Alice 分配 1000 积分，她创建了 key A / B / C
- 通过 A、B、C 的任何调用都从同一个 1000 里扣
- 1000 用完 → 三把 Key 一起失效
- 多建 Key 不会多拿额度

### 3.3 启用/禁用 Key

1. 在 Key 列表点击操作列的 **⋮** 按钮
2. 选择 **禁用** 或 **启用**
3. `forceDisabled`（强制禁用）由管理员设置，普通的启用/禁用操作无法覆盖

### 3.4 删除 Key

1. 在操作菜单选择 **删除**
2. 确认后永久删除

---

## 4. 上游 Provider 管理

### 4.1 创建 Provider

1. 进入 **Provider 管理** 页面
2. 点击 **创建 Provider** 按钮
3. 填写配置：
   - **名称** - 管理员可见的标识名
   - **类型** - `openai` / `anthropic` / `custom-openai` / `azure`
   - **Base URL** - 上游 API 根地址
   - **API Key** - 上游 API Key（加密存储）
   - **优先级** - 数字越小越优先
   - **上游格式** - `responses`（默认）/ `chat` / `anthropic`
   - **模型映射** - 客户端模型名 → 上游模型名，建议用恒等映射

### 4.2 测试 Provider

保存前可点击 **测试** 按钮验证配置是否正确。

---

## 5. 公开 API 接口

用户通过以下端点使用 AI 服务：

| 端点 | 协议 | 说明 |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat | |
| `/v1/responses` | OpenAI Responses | |
| `/v1/models` | OpenAI | 返回可用模型列表 |
| `/anthropic/v1/messages` | Anthropic | Claude 兼容 |

认证方式：
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 6. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `unauthorized` | 缺少/无效 Bearer |
| 403 | `key_disabled` | Key 已禁用 |
| 403 | `key_force_disabled` | Key 被管理员强制禁用 |
| 403 | `key_expired` | Key 已过期 |
| 403 | `quota_exceeded_credits` | 积分不足 |
| 403 | `quota_exceeded_tokens` | Token 额度不足 |
| 403 | `model_not_allowed` | 该 Key 不允许此模型 |
| 400 | `model_not_mapped` | 没有任何 Provider 支持此模型 |
| 400 | `missing_model` | 请求体中没有 `model` 字段 |
| 502 | `upstream_error` | 上游调用失败 |

> 这里**没有 `user_disabled` 错误码**——它曾出现在本文档早期版本的表格中，但代码
> 库中没有任何地方会产生它，因为用户无法被禁用。真正会拦住用户的是
> `quota_exceeded_credits` / `quota_exceeded_tokens`（把额度设为 0）以及上面这些
> Key 级别的错误码。

---

## 7. 调试技巧

### 7.1 查用户真实配额状态

```bash
# 库就是一个 SQLite 文件，直接查；RELAY_DB_PATH 不设则默认 ./data/relayab.db
sqlite3 "$(grep -oP '(?<=^RELAY_DB_PATH=).*' /opt/relayab/.env.production | tr -d '"')" \
  "SELECT username, role, quota_limit, quota_used FROM users WHERE id = '<userId>';"
```

应用运行中不要用 `sqlite3` 直接写库——会绕开事务和 WAF。只读查询是安全的。

对比 `quotaLimit` 与 `quotaUsed`。积分以 0.001 积分为单位存储，因此
`quotaLimit` 为 `100000` 表示 100 积分。当 `quotaUsed` 达到 `quotaLimit` 时，调用会
失败并返回 `quota_exceeded_credits`（当 `quotaType` 为 `tokens` 时为
`quota_exceeded_tokens`）。

### 7.2 为什么"停用"用户后他还能调用？

因为用户无法被停用——见 §2.3。真正会拦住调用的是：

- 额度达到上限会停止 **API 调用**，但用户仍可登录面板，直到其 session 过期。
- 禁用或强制禁用某个 **Key** 会立即停止该 Key；但用户仍然持有他拥有的其他所有 Key。
- 不存在用户级别的总开关，因此要停止全部访问，唯一办法是删除该用户（这会一并删除其 Key）。
