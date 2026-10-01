# RelayAB 技术文档

> **本文档套为中文。** English version: [../README.md](../en/README.md)
>
> 语言切换只放在**顶层这两页**（本页与英文索引）；各篇正文之间互链，**不会把你送到另一种语言的页面**。

RelayAB 是一个自托管 AI API 网关（API 中转站）。

## 从哪里开始

| 你想…… | 读 |
| --- | --- |
| 搞清整体怎么拼起来的 | [architecture.md](architecture.md) |
| 查某个 Redis key 或字段什么意思 | [data-model.md](data-model.md) |
| 调用某个接口，或新增一个 | [api-routes.md](api-routes.md) |
| 部署到自己的服务器 | [deployment.md](deployment.md) |
| 管理用户、Key、供应商 | [admin.md](admin.md) |
| 跑测试或扩充测试 | [testing.md](testing.md) |
| 接入图片 / 视频 / 语音 / 音乐供应商 | [../模型适配协议/README.md](../模型适配协议/README.md) |

## 文档清单

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 目标与非目标、顶层架构、背后的设计决策、加密与安全 |
| [data-model.md](data-model.md) | Redis 键命名、每个实体的字段、各键的 TTL |
| [api-routes.md](api-routes.md) | 全部公开代理端点、全部管理 API、中间件行为 |
| [deployment.md](deployment.md) | 一键部署、Upstash、首次启动、绕过部署保护、冒烟测试清单 |
| [admin.md](admin.md) | 管理后台全流程：用户、Key、供应商、错误码、排查 |
| [testing.md](testing.md) | 测试金字塔、工具、各层怎么跑 |
| [../模型适配协议/README.md](../模型适配协议/README.md) | 媒体供应商协议：spec 格式、全部原语、离线校验器（判官）、完整示例 |

## 本套文档的约定

- **章节编号是稳定的。** 代码注释按编号引用，例如 `src/lib/db/users.ts` 引用
  `docs/zh/data-model.md` 的 §1、`src/lib/crypto/password.ts` 引用
  `docs/zh/deployment.md` 的 §3。重排章节会打断这些引用。一处**原有的跳号有意保留**：
  `data-model.md` 没有 §7（从 6 直接跳到 8）。
- **代码不翻译。** 标识符、文件路径、环境变量、路由路径、JSON 键、命令参数与源码逐字一致。
- **术语固定。** 「供应商」专指上游供应商那一行，「客户 API Key」专指用户在面板里创建的 Key；
  「额度」与「积分」是两回事（额度以积分为单位计量）。
- **`⚠️` 标记陷阱，`⭐` 标记推荐。**

## 相关

- [../../README.md](../../README.md) —— 项目中文 README（原版）
- [../模型适配协议/README.md](../模型适配协议/README.md) —— 媒体供应商协议（中文）
- [../README.md](../en/README.md) —— English documentation index（英文文档索引）
