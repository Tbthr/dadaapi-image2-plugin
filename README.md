# 哒哒API Image2

哒哒API Image2 是用于生成、编辑和提取图片元素的 Codex 插件，也可作为独立 MCP server 使用。GPT Image2 不支持透明背景、alpha 通道或透明 PNG 输出。

## 安装插件

通过 marketplace 安装：

```bash
codex plugin marketplace add https://github.com/Tbthr/dadaapi-image2-plugin.git
codex plugin add dadaapi-image2-plugin@dadaapi
```

本地安装：

```bash
git clone https://github.com/Tbthr/dadaapi-image2-plugin.git
cd dadaapi-image2-plugin
codex plugin marketplace add .
codex plugin add dadaapi-image2-plugin@dadaapi
```

## 配置

将 [`.env.example`](plugins/dadaapi-image2-plugin/.env.example) 复制为 `~/.codex/image2-mcp.env`，再填写 API Key。不要将真实 Key 提交到仓库。

```env
IMAGE2_API_KEY=你的哒哒API Key
IMAGE2_BASE_URL=https://dadaapi.com
IMAGE2_MODEL=gpt-image-2
IMAGE2_DEFAULT_OUTPUT_DIR=~/.codex/mcp/dadaapi-image2-plugin/assets
IMAGE2_REQUEST_TIMEOUT_MS=300000
IMAGE2_DOWNLOAD_TIMEOUT_MS=60000
IMAGE2_MAX_OUTPUT_BYTES=33554432
```

重启 Codex 或开启新线程后，使用 `@dadaapi-image2-plugin` 调用插件。

## 诊断与失败处理

调用 `image2_doctor` 可以检查 Node 版本、API Key 配置、输出目录写权限、API 连通性和 `gpt-image-2` 可见性。该检查不会生成图片，也不会消耗图片生成额度。服务商不支持 `/v1/models` 时会返回 warning，不会阻止继续使用生成工具。

插件同时接受 API 返回的 base64、data URL 和 HTTP(S) 图片 URL。所有结果都会校验为 PNG、JPEG 或 WebP，再以原子写入方式保存到本地；空结果、无效图片和流式响应缺少最终图都会明确返回错误，不再伪装成成功。

失败结果包含稳定的 `error.code`、失败阶段、HTTP 状态和 request id。主要错误码包括：

- `CONFIG_ERROR`、`API_HTTP_ERROR`、`NETWORK_ERROR`、`REQUEST_TIMEOUT`、`CANCELLED`
- `EMPTY_IMAGE_RESULT`、`INVALID_IMAGE_DATA`、`IMAGE_DOWNLOAD_ERROR`
- `INCOMPLETE_STREAM`、`OUTPUT_WRITE_ERROR`

插件采用额度优先策略：生成或编辑请求不会被自动重发。远程图片下载遇到网络错误或 408、429、5xx 时，只会针对同一个结果 URL 重试一次，避免重复生成和重复扣费。

## 独立 MCP Server

安装依赖后，将以下配置加入 `~/.codex/config.toml`，并替换为本机绝对路径：

```bash
cd plugins/dadaapi-image2-plugin
npm ci
```

```toml
[mcp_servers.dadaapi-image2]
command = "node"
args = ["/absolute/path/to/dadaapi-image2-plugin/plugins/dadaapi-image2-plugin/dist/server.js"]
```

独立 MCP server 同样读取 `~/.codex/image2-mcp.env`。
