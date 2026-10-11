# Codex 辅助工具

> 最后更新：2026-10-11

本仓库提供 Codex 运行数据清理脚本、任务完成桌面通知脚本、会话管理工具，以及多个 Codex skill。清理和通知脚本分别按功能放在独立目录，并同时支持 Ubuntu 与 Windows。

## 目录

| 功能 | 路径 | 说明 |
| --- | --- | --- |
| 清理运行数据 | [`clean-all/`](clean-all/) | 预览或删除 Codex 缓存、日志和临时数据 |
| 桌面通知 | [`notify/`](notify/) | 解析 Codex 通知事件并显示 Ubuntu/Windows 通知 |
| VS Code 扩展工具复用 | [`vsc-extension-tool/`](vsc-extension-tool/) | 直接调用 VS Code Codex 扩展内置的命令行工具 |
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
