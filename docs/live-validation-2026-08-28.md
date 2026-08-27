# DadaAPI Image2 真实链路验收报告（2026-08-28）

## 状态

生产链路：插件 -> `https://dadaapi.com`（NewAPI）-> sub2api 系渠道

验收结论：**生产矩阵通过**。生产入口鉴权、模型枚举和插件 doctor 均通过；16 个计划用例全部成功，得到 20 张最终图片。另有最初一次 G1 在 NewAPI 内部成功结算后丢失下行响应体，明确证明插件不自动重试的额度保护有价值；经用户确认后只重跑该失败用例，随后完整矩阵未再出现断流。

全部请求使用 `gpt-image-2`、`1024x1024`、`quality=low`、`output_format=png`。密钥仅通过进程环境注入，未写入仓库、状态文件、日志或本报告。

## 生产链路核验

| 检查 | 结果 | 证据 |
|---|---|---|
| `/v1/models` | 通过 | `200 application/json`；仅返回 1 个模型，`gpt-image-2` 可见；NewAPI 版本 `dev-e8a55658` |
| 插件 `image2_doctor` | 通过 | Node、配置、输出目录、API 与模型检查全部 pass；未产生图片费用 |
| 首次 G1 非流式单图 | 下行失败且已结算 | NewAPI 消费日志为成功消费，`use_time=33s`、输入/输出 token 为 `24/272`、`is_stream=false`；插件 188.9 秒后在读取响应体时收到 `UND_ERR_SOCKET`，未得到文件 |
| 完整生产矩阵 | 通过 | 16/16 用例成功，20 张最终图全部为非空 `1024x1024` PNG；11 张编辑结果人工检查通过 |

G1 的 NewAPI 本机请求 ID 为 `202608271646294524209368268d9d6dhFiPZWI`，上游请求 ID 为 `68f790e9-496e-457d-860c-2ea5dd54be70`。旧版插件只记录了后者；本次已改为优先返回 NewAPI 的 `X-Oneapi-Request-Id`，并以 `upstream_request_id` 另行保留 `X-Request-Id`。

NewAPI 消费日志明确记录本次请求命中渠道 `#182`。只读运维快照显示，当前 `Codex 生图` 分组有两个启用渠道：

- 优先级 100：`#182`，Base URL `https://gmats.mosshubs.com`；
- 优先级 99：`#197`，Base URL `https://api.aiboys.xyz`。

因此本次生产请求并未进入 `https://chuangagent.eu.cc`。后者不在当前生图分组中，之前的直连结论不能用于推断现网协议行为。验收期间未修改任何线上渠道、优先级或开关。

首次 G1 的证据把单次故障范围缩小到 NewAPI 已取得完整上游结果之后的下行响应传输。NewAPI 的非流式图片处理会先 `io.ReadAll` 完整上游 JSON，再设置 `Content-Length` 并写给客户端；本地代码在 `RELAY_TIMEOUT=0` 时没有出站总超时，HTTP server 也未设置 `WriteTimeout`。随后相同 G1 在 70.3 秒通过，且最慢的 E1R 在 131.4 秒通过，因此目前判断为偶发下行传输故障，不构成发布阻塞，但仍应保留监控。

若同类故障再次出现，应在生产端按上述两个请求 ID 核对：

- NewAPI 应用日志是否出现 `failed to copy response body`、客户端断开或容器重启；
- 源站/反向代理是否存在约 180 秒请求时限、响应缓冲、body size 或带宽限制；
- Cloudflare 是否对 API 路由设置了自定义 Proxy Read Timeout；必要时使用 DNS-only API 子域名，或在支持的套餐上提高超时；
- 实际返回的 `Content-Length` 与下行发送字节数是否一致。

## 生产矩阵结果

| ID | 场景 | HTTP / 模式 | final / partial | 耗时 | 结果 |
|---|---|---|---:|---:|---|
| G1 | 单图生成，非流式 | `200 JSON` | 1 / 0 | 70.3s | 通过 |
| G2 | 单图生成，流式无 partial | `200 SSE` | 1 / 0 | 34.5s | 通过 |
| G3 | 单图生成，流式请求 1 partial | `200 SSE` | 1 / 0 | 37.6s | 通过 |
| G4 | 单请求双图，非流式 | `200 JSON` | 2 / 0 | 68.6s | 通过 |
| G5 | 单请求双图，流式 | `200 SSE` | 2 / 0 | 44.6s | 通过 |
| G1R | G1 独立复测 | `200 JSON` | 1 / 0 | 33.7s | 通过 |
| G3R | G3 独立复测 | `200 SSE` | 1 / 0 | 58.4s | 通过 |
| E1 | 单输入编辑，非流式 | `200 JSON` | 1 / 0 | 38.8s | 通过，人工预览通过 |
| E2 | 单输入编辑，流式无 partial | `200 SSE` | 1 / 0 | 44.9s | 通过，人工预览通过 |
| E3 | 单输入编辑，流式请求 1 partial | `200 SSE` | 1 / 0 | 58.5s | 通过，人工预览通过 |
| E4 | 双输入编辑，非流式 | `200 JSON` | 1 / 0 | 43.9s | 通过，人工预览通过 |
| E5 | 双输入编辑，流式 | `200 SSE` | 1 / 0 | 86.9s | 通过，人工预览通过 |
| E6 | 单输入、双结果编辑，非流式 | `200 JSON` | 2 / 0 | 61.1s | 通过，人工预览通过 |
| E7 | 单输入、双结果流式编辑 | `200 SSE` | 2 / 0 | 46.0s | 通过，人工预览通过 |
| E1R | E1 独立复测 | `200 JSON` | 1 / 0 | 131.4s | 通过，人工预览通过 |
| E3R | E3 独立复测 | `200 SSE` | 1 / 0 | 48.2s | 通过，人工预览通过 |

所有 JSON 响应均为 `application/json`，所有 SSE 响应均为 `text/event-stream`。SSE 的 `image_generation.completed` / `image_edit.completed` 事件数与期望最终图数量一致；NewAPI 未发送 `[DONE]`，但在 completed 后正常关闭流。7 个请求设置了 `partial_images=1`，渠道均未返回 partial，这符合验收允许的 0-1 张范围，也没有产生已观察到的 partial 文件。

人工预览确认：绿色杯子、白色星标、浅蓝背景、多输入产品组合、灰色背景及海军蓝横纹修改均生效，主体基本保留。全部 20 张文件通过 PNG 签名、非空和 `1024x1024` 尺寸检查。

生产共 17 次尝试，包含首次已结算但未交付的 G1；按 0.05 元/张估算最终图最坏成本约 1.05 元。加上直连阶段最多 0.40 元，整体最坏约 1.45 元，未超过 1.5 元硬预算；未观察到 partial 输出。

## sub2api 直连参考

以下结果来自 `https://chuangagent.eu.cc` 直连，只用于证明插件对该渠道的观察，不替代生产 NewAPI 链路验收。该渠道当前不是 NewAPI 生图分组成员。非流式单图与单请求多图生成通过；流式生成收到非标准事件包装，无法在 Images-only 严格边界内确定性解析。直连矩阵在 G2 停止。

### 已执行请求

| 尝试 | 用例 | 结果 | HTTP / Content-Type | 模式 | final / partial | 耗时 | 说明 |
|---:|---|---|---|---|---:|---:|---|
| 1 | G1 | 通过 | `200 application/json` | JSON | 1 / 0 | 34.6s | 文件非空、PNG 签名、`1024x1024` |
| 2 | G4 | 不明确 | 未取得响应元数据 | 非流式请求 | 0 / 0 | 60.0s | MCP 客户端默认 60 秒先超时；未自动重试 |
| 3 | G4 | 通过 | `200 application/json` | JSON | 2 / 0 | 68.1s | 调整验收客户端超时后人工继续；两张均通过文件检查 |
| 4 | G2 | 协议失败 | `200 text/event-stream` | SSE | 0 / 0 | 0.5s | 首事件为 `image_generation.queued`；随后增加受限 Images 生命周期支持 |
| 5 | G2 | 协议失败 | `200 text/event-stream` | SSE | 0 / 0 | 4.2s | 事件无 `event`/`type`；仅有 wrapper 顶层字段，无法确定事件语义 |
| 6 | G2 | 协议失败 | `200 text/event-stream` | SSE | 0 / 0 | 4.6s | 增加受限 `upstream_event_type` 一致性解析后，渠道仍未提供可用事件名 |

成功请求 ID：

- G1：`05125a5e-0fa3-401e-b405-90dee2c3fd37`
- G4：`c77a6a07-c859-4d63-8097-89c95dc2e12f`

最后一次 G2 诊断仅保留：`text/event-stream`、1 个无类型事件、175 字节、未见 `[DONE]`，以及顶层字段 `object`、`created`、`model`、`index`、`total`、`progress_text`、`upstream_event_type`、`data`。未记录字段值或事件体。

共向上游发出 6 次请求，请求 final 上限为 8 张，按 0.05 元/张估算最坏约 0.40 元；所有 G2 均为 `partial_images=0`，未产生 partial 额外费用。

### 协议判断

- [OpenAI Images 官方指南](https://developers.openai.com/api/docs/guides/image-generation#streaming)的 Image API 示例显式处理 `image_generation.partial_image`；Responses API 使用独立的 `response.*` 事件族。
- 公开 sub2api 主仓库提交 `efb46db0a960fdad94502b1c3a982a0051cf5245` 会把上游 Responses 图片事件转换为 `image_generation.partial_image/completed` 或 `image_edit.partial_image/completed`。
- 目标渠道实际返回的 `image_generation.queued` 和无事件名 wrapper 在该公开提交中均不存在，说明部署包含额外网关、私有分支或不同版本。
- 插件可安全支持同端点的 `queued`、`in_progress`、`partial_image`、`completed`，以及事件名明确且内外一致的 `upstream_event_type` 包装；不能根据 `object`、`progress_text` 或字段结构猜测图片事件，否则可能把 Responses 或进度消息误当 final 图片。

## 本地验证

- `npm test`：24/24 通过
- `npm run build`：通过
- skill quick validation：通过
- plugin validation：通过
- `git diff --check`：通过

覆盖范围包括 JSON/SSE 协商、缺失或通用 Content-Type 嗅探、CRLF/分块/无终止换行、生成和编辑事件、生命周期事件、受限 wrapper、Responses/跨端点/未知事件拒绝、partial 保留、异步 running partial、多个 `image[]`、小 PNG 原文件保留、尺寸与透明背景约束、双层 request id 和诊断脱敏。

## 发布状态

- 生产矩阵、本地测试、构建、技能与插件校验均已通过。
- 已通过 plugin-creator 更新 cachebuster：`0.1.0+codex.20260827174133`。
- 当前已配置的 `dadaapi` marketplace 是 GitHub 缓存副本，仍指向提交 `fc2e6d344deedde090dd0f3668d5219a7e0f075f`；本地优化尚未进入该远端快照。
- 为避免 `codex plugin add dadaapi-image2-plugin@dadaapi` 重新安装旧版本，本轮没有执行重装，也没有擅自 push、删除或切换 marketplace 来源。
- 远端 marketplace 更新后，应执行重装并在新 Codex 任务中确认新版本、工具列表和技能加载。
