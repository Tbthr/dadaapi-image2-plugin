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
```

重启 Codex 或开启新线程后，使用 `@dadaapi-image2-plugin` 调用插件。

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
