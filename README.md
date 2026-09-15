# Codex 辅助工具

> 最后更新：2026-09-15

本仓库提供 Codex 运行数据清理脚本、任务完成桌面通知脚本、会话管理工具，以及多个 Codex skill。清理和通知脚本分别按功能放在独立目录，并同时支持 Ubuntu 与 Windows。

## 目录

| 功能 | 路径 | 说明 |
| --- | --- | --- |
| 清理运行数据 | [`clean-all/`](clean-all/) | 预览或删除 Codex 缓存、日志和临时数据 |
| 桌面通知 | [`notify/`](notify/) | 解析 Codex 通知事件并显示 Ubuntu/Windows 通知 |
| VS Code 扩展工具复用 | [`vsc-extension-tool/`](vsc-extension-tool/) | 直接调用 VS Code Codex 扩展内置的命令行工具 |
| Codex Web UI | [`web-ui/`](web-ui/) | 通过 HTTP API 与增量轮询管理和使用 Codex 会话 |
| Azure 图片生成 skill | [`skills/azure-image-gen/`](skills/azure-image-gen/) | 通过 Azure GPT-Image-2 部署生成图片 |
| Make It Mine skill | [`skills/make-it-mine/`](skills/make-it-mine/) | 在 AI 辅助开发后梳理理解、技术取舍和可迁移的工程判断 |
| Codex 会话管理 skill | [`skills/codex-session-manager/`](skills/codex-session-manager/) | 通过 Python CLI 和本地 Web UI 管理 Codex 会话 |

各功能的安装、参数和安全说明见对应目录的 README。

## 快速使用

### Ubuntu

```bash
sudo apt update && sudo apt install -y libnotify-bin python3
chmod +x clean-all/ubuntu/clean.sh notify/ubuntu/notify.sh

# 清理前预览，确认后再执行
./clean-all/ubuntu/clean.sh --dry-run
./clean-all/ubuntu/clean.sh

# 在 ~/.codex/config.toml 中配置通知（使用绝对路径）
# notify = ["bash", "/absolute/path/to/codex-scripts/notify/ubuntu/notify.sh"]
```

### Windows

在用户级 `%USERPROFILE%\\.codex\\config.toml` 配置 `notify`，并使用 `notify/window/notify.ps1`；清理脚本使用 `clean-all/windows/clean.ps1 -WhatIf` 预览，确认后去掉 `-WhatIf` 执行。Windows TOML 路径中的反斜杠需要写成双反斜杠。

## 清理安全范围

脚本默认处理 `~/.codex`（Windows 为 `%USERPROFILE%\\.codex`），也可通过 Ubuntu 的 `CODEX_HOME` 覆盖。会清理 `sessions`、临时目录、快照、记忆、日志、JSON/SQLite/JSONL 文件；始终保留顶层 `auth.json` 与 `config.toml`。请务必先使用预览模式。

## Azure Image Gen

配置 `AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_ENDPOINT`（或 `AZURE_OPENAI_BASE_URL`）和 `AZURE_OPENAI_IMAGE_DEPLOYMENT` 后，按 [`skills/README.md`](skills/README.md) 安装和测试。密钥不要写入仓库、命令参数或 Codex 配置文件。

## Codex Web UI

[`web-ui/`](web-ui/) 是一个运行在本机的轻量 Codex Web UI。浏览器使用 HTTP API 与增量轮询连接 Node 服务；Node 启动并保持一个常驻的 `codex app-server`，通过 stdio JSON-RPC 获取模型、sessions、turn 和流式事件。浏览器端不使用 WebSocket。

当前版本支持分页浏览和管理 sessions、从任意一条 Codex 回复创建对话分支、显示消息时间、查看回答与工具调用、workspace 文件预览/下载、用户与 Codex 图片预览、文件修改和 diff。New thread 默认使用当前有效 `config.toml` 中的模型与 reasoning effort。打开 session 时只传输最近 60 条 UI 消息，生成图片通过独立 URL 加载，避免把 Base64 图片重复放进会话响应。

开发运行：

```bash
cd web-ui
npm install
npm run dev
```

默认访问 <http://127.0.0.1:8765/>。生产部署、后台运行、认证和反向代理配置请参阅 [`web-ui/README.md`](web-ui/README.md)。

生产运行：

```bash
cd web-ui
npm run build
./scripts/codex-web.sh start
./scripts/codex-web.sh status
```

常用配置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEB_HOST` | `127.0.0.1` | Node 监听地址 |
| `CODEX_WEB_PORT` | `8765` | Node 监听端口 |
| `CODEX_WEB_BASE_PATH` | `/` | 页面和 HTTP API 的反向代理子路径 |
| `CODEX_WEB_AUTH` | 未启用 | Basic Auth，格式为 `username:password` |
| `CODEX_HOME` | `~/.codex` | Codex sessions、附件缓存和生成图片所在目录 |

Web UI 启动时会冷加载并常驻 `codex app-server`；Settings 中可以查看状态、PID、内存并执行 Start、Stop、Restart。完整说明、Nginx 示例、文件限制和验证方法以 [`web-ui/README.md`](web-ui/README.md) 为准。
