# Codex Web Harness

一个运行在本机的轻量 Codex Web UI。浏览器通过 HTTP API 和增量轮询连接 Node 服务，Node 再通过 stdio JSON-RPC 管理常驻的 `codex app-server`。

Codex 的登录状态、配置和 session 仍由 Codex 自己管理；Web UI 不读取或保存 Codex 凭据。

## 演示

![Codex Web UI 演示](src/assets/web-ui-demo.gif)

## 功能

- 从 app-server 分页加载本机 Codex CLI、VS Code、exec、app-server 和 sub-agent sessions
- 创建、恢复、Branch、归档、取消归档、批量操作和删除 session
- 当前 session 写入 `?session=<id>`，刷新页面后自动恢复
- 创建新对话前从当前用户 home 中选择 workspace；已有 session 自动恢复自己的 workspace
- 从真实 `model/list` 读取模型与 reasoning effort
- 流式显示回答、thinking、命令、文件修改、工具调用、网页搜索、图片、hook、子 agent、review、计划更新与警告
- AI 回复在浏览器端渲染 Markdown/GFM，支持表格、任务列表、删除线与代码块
- 每轮活动汇总为可展开的时间线；保留文件/命令摘要和历史 context compact 记录
- Composer 可选择会话权限：按需确认、Full access（无 sandbox / 无审批）或只读；设置会作用于后续 turn
- 可在输入框粘贴或选择任意类型文件作为附件；图片支持点击预览，所有附件均会在会话中保留并可下载
- 输入框附件单条消息最多 4 个，单个文件和所有附件合计均限制为 10 MB；附件直接保存在当前 thread 的 workspace `.files/<thread.id>/`，每轮会把具体文件路径告诉 Codex；文本、图片和音频也会直接传入模型，其他二进制文件可由 Codex 按路径读取
- 文件树、文本文件创建/删除、预览、编辑与下载；支持向 workspace 目录上传文件
- 按文件查看 Changes/Diff
- 显示 context window、实时内存占用，以及独立的 5-hour / Weekly account usage 窗口
- 支持部署在 `/codex/` 之类的反向代理子路径；不要求 WebSocket 反代

## 目录说明

| 路径           | 用途                               | 是否手工修改   |
| -------------- | ---------------------------------- | -------------- |
| `src/`         | React/TSX 前端源码                 | 是             |
| `server/`      | Node/TypeScript 服务端源码         | 是             |
| `public/`      | 原样复制的静态资源                 | 是             |
| `scripts/`     | Playwright 验证脚本                | 是             |
| `dist/`        | Vite 生成的前端生产文件            | 否，可删除重建 |
| `dist-server/` | TypeScript 生成的服务端 JavaScript | 否，可删除重建 |

`server/` 与 `dist-server/` 不是两套源码：

```text
server/*.ts  -- npm run build -->  dist-server/*.js
src/*        -- npm run build -->  dist/*
```

仓库只维护 `src/` 和 `server/`。`dist/`、`dist-server/` 已加入 `.gitignore`，不要直接编辑或提交。当前生成目录被删除是正常的，执行 `npm run build` 会重新创建。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- 已安装且可直接执行的 `codex` CLI
- Codex 已完成登录或配置好可用的认证方式

检查：

```bash
node --version
codex --version
```

## 开发运行

开发模式不需要 `dist/` 或 `dist-server/`：

```bash
cd /home/pldz/local/codex-scripts/web-ui
npm install
npm run dev
```

默认打开：

```text
http://127.0.0.1:8765/
```

前端修改由 Vite 即时加载，后端入口通过 `tsx server/index.ts --dev` 运行。

## 会话权限

Composer 工具栏中的权限菜单会在创建 session 时设置权限，也会在已有 session 的下一次 turn 覆盖并延续该设置：

| 选项            | Codex 策略                       | 适用场景                                                     |
| --------------- | -------------------------------- | ------------------------------------------------------------ |
| Ask when needed | `workspace-write` + `on-request` | 默认选择；允许写入 workspace，需要时向浏览器请求确认         |
| Full access     | `danger-full-access` + `never`   | 无 sandbox、无审批提示，适合可信环境的长时间 unattended 任务 |
| Read-only       | `read-only` + `on-request`       | 仅检查、分析或审阅代码                                       |

`Full access` 会允许 Codex 在当前运行账户的权限范围内执行命令。只应在本机、可信 workspace 和已理解任务影响时使用。

## 活动时间线与用量

- app-server 的结构化 item 会按 turn 显示；命令、读写文件、MCP/动态工具、网页搜索、图像、子 agent 和 review 都可展开查看详情。
- 计划、hook、模型 reroute、安全等待、警告和 context compact 显示为独立状态行；compact 记录会随 session 历史保留。
- 设置抽屉中的 account usage 会将 app-server 返回的 primary / secondary 窗口明确标为 **5-hour limit** 与 **Weekly limit**。认证方式未提供该接口时，面板显示 `Unavailable`。

## 生产运行

生产模式必须先构建：

```bash
cd /home/pldz/local/codex-scripts/web-ui
npm install
npm run build
npm start
```

`npm run build` 会同时生成：

- `dist/`：浏览器静态资源
- `dist-server/`：Node 可执行 JavaScript

`npm start` 只负责启动已有构建，不会自动重新 build。修改 `src/` 或 `server/` 后，需要再次执行 `npm run build`。

`npm start` 实际执行：

```bash
node --max-old-space-size=256 dist-server/index.js
```

如果希望少一个 npm 父进程，也可以在 build 后直接运行上面的 Node 命令。

## 后台运行

项目提供 Linux/macOS shell 与 Windows PowerShell 两个生命周期脚本。它们直接启动 `dist-server/index.js`，关闭启动它们的终端后，Node 和自动创建的 `codex app-server` 仍会继续运行。

使用前必须完成一次生产构建：

```bash
npm run build
```

Linux/macOS：

```bash
./scripts/codex-web.sh start
./scripts/codex-web.sh status
./scripts/codex-web.sh logs
./scripts/codex-web.sh restart
./scripts/codex-web.sh stop
```

PowerShell：

```powershell
.\scripts\codex-web.ps1 start
.\scripts\codex-web.ps1 status
.\scripts\codex-web.ps1 logs
.\scripts\codex-web.ps1 restart
.\scripts\codex-web.ps1 stop
```

如果 Windows 阻止执行本地脚本，可以仅对本次命令放行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\codex-web.ps1 start
```

脚本继承当前终端中的 `CODEX_WEB_*` 和 `CODEX_HOME` 环境变量。例如：

```bash
export CODEX_WEB_BASE_PATH=/codex
export CODEX_WEB_PORT=8765
./scripts/codex-web.sh start
```

```powershell
$env:CODEX_WEB_BASE_PATH = "/codex"
$env:CODEX_WEB_PORT = "8765"
.\scripts\codex-web.ps1 start
```

运行日志和 PID 保存在 `.run/`，该目录不会提交到 Git。`logs` 命令中的 `Ctrl+C` 只会退出日志查看，不会停止服务。

后台脚本能跨终端关闭继续运行，但不会在机器重启后自动恢复。需要开机自动启动时，应使用 systemd、Windows Service 或任务计划程序。

## Workspace 与环境变量

所有变量都是可选的：

| 变量                  | 默认值      | 说明                                                                                                                  |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `CODEX_WEB_HOST`      | `127.0.0.1` | Node 监听地址                                                                                                         |
| `CODEX_WEB_PORT`      | `8765`      | Node 监听端口                                                                                                         |
| `CODEX_WEB_BASE_PATH` | `/`         | 页面及 HTTP API 的统一子路径                                                                                          |
| `CODEX_WEB_AUTH`      | 未启用      | 可选 Basic Auth，格式为 `username:password`                                                                           |
| `CODEX_HOME`          | `~/.codex`  | Codex sessions、旧版 Web UI 附件缓存和 Codex 原始生成图片所在目录；新版输入框附件保存在 thread workspace 的 `.files/` |

页面会先加载最近 50 个本地 session；打开已有 session 时使用该 session 自己的 workspace，创建新对话时从当前用户 home 中选择 workspace。

Composer 上传文件使用 app-server 返回的 `thread.id`（不是 `sessionId`）作为目录名，例如 `.files/<thread.id>/<message-id>-0-example.pdf`。恢复和分叉 session 后也按各自 thread 的 ID 和 cwd 定位；旧版 `.files/<thread.id>/uploads/` 和 `CODEX_HOME/attachments/codex-web/` 附件仍可读取。删除 thread 不会自动删除 workspace 下的 `.files/<thread.id>/`，以免误删其中的图片或其他工作文件。

创建非只读 thread 时，Web UI 会在 workspace 根目录的 `AGENTS.md` 中新增或更新有标记的规则，并保留其他项目指令；恢复、分叉或创建只读 thread 不会改写该文件。每轮输入都会向 Codex 传入具体的 `.files/<thread.id>/` 路径，但这段内部说明不会显示在用户消息气泡里。上传文件与 Codex 生成的独立交付文件（图片、文档、音频、导出文件等）都直接放在该目录，不再按类型分子目录；上传文件名前缀用于避免重名。用户明确指定其他交付路径时以用户要求为准；源码修改、项目文件和必须位于原路径的构建产物仍留在项目目录。Codex 的 `cwd` 仍是项目 workspace，不会切到 `.files/`。生成文件的归档由 Agent 执行，不是后端自动搬运，因此受当前权限和执行结果影响。如果不想把 `.files/` 提交到 Git，可在项目的 `.gitignore` 中加入它。

子路径部署示例：

```bash
export CODEX_WEB_HOST=127.0.0.1
export CODEX_WEB_PORT=8765
export CODEX_WEB_BASE_PATH=/codex
npm start
```

访问：

```text
http://127.0.0.1:8765/codex/
```

注意：只写 `CODEX_WEB_BASE_PATH=/codex` 而不使用 `export`，后续单独执行的 `npm start` 不会继承这个变量。

## 访问认证

默认不启用认证，行为与此前一致。如需保护整个页面、静态资源和 HTTP API，启动前设置：

```bash
export CODEX_WEB_AUTH='username:password'
./scripts/codex-web.sh restart
```

PowerShell：

```powershell
$env:CODEX_WEB_AUTH = "username:password"
.\scripts\codex-web.ps1 restart
```

浏览器打开页面时会显示用户名/密码登录框。用户名或密码错误时，页面和 HTTP API 都返回 `401`。

不设置或删除该变量即可关闭认证：

```bash
unset CODEX_WEB_AUTH
./scripts/codex-web.sh restart
```

密码中允许包含额外的冒号，程序只把第一个冒号视为用户名与密码的分隔符。用户名和密码都不能为空；格式错误时服务会拒绝启动。

Basic Auth 只是访问门槛，凭据本身仅做 Base64 编码。通过非本机网络访问时必须使用 Nginx HTTPS，不能直接把 HTTP 服务暴露到公网。

## Nginx

Nginx 可以负责 TLS 和反向代理，但不能替代 Node。Node 仍需要：

- 启动并管理 `codex app-server`
- 在 stdio JSON-RPC 与浏览器 HTTP API 之间桥接
- 提供受 workspace 范围保护的文件读写接口

配置示例：

```nginx
location /codex/ {
    proxy_pass http://127.0.0.1:8765/codex/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

同时设置：

```bash
export CODEX_WEB_BASE_PATH=/codex
```

页面静态资源、轮询和操作 API 都会使用同一个 base path。

聊天回答中的本地文件链接也会使用该 base path。例如设置 `/codex` 后，workspace 文件链接会转换为：

```text
/codex/?file=src%2Fserver%2Fusers.ts
```

点击后直接在 Files 抽屉中预览；复制到新标签页打开也不会跳出 `/codex/`。只有当前 workspace 内的文件可以打开，workspace 外的绝对路径会显示为不可用链接。

## Files 文件管理与上传

Files 抽屉的路径栏提供 New 和 Upload。默认在 workspace 根目录操作；先点击文件树中的目录，可以切换目标目录。New 创建空文件，预览顶部的 Delete 会在二次确认后删除当前文件。创建、删除和上传都被限制在当前 workspace 内；Delete 不会删除目录或符号链接。

限制：

- 单文件最大 10 MB
- 单批最大 25 MB
- 单次最多选择 10 个文件
- 不覆盖同名文件
- 只能写入当前 workspace，不能通过 `..`、绝对路径或符号链接逃逸

文本文件上传后可以直接预览和编辑；二进制文件会出现在文件树中，不支持预览时会在预览区中央提供大号 Download 按钮。

Files 只对常见纯文本和代码格式启用预览/编辑，例如 `.txt`、`.md`、`.json`、`.yaml`、`.csv`、`.js`、`.ts`、`.tsx`、`.py`、`.go`、`.rs`、`.java`、`.c/.cpp`、`.html`、`.css`、`.sh`、`.toml`、`.ini`、`.sql`、`.ps1`，以及 `Dockerfile`、`Makefile`、`.env`、`.gitignore` 等。文本预览/编辑上限为 10 MB；超过 1 MB 时使用不带逐行 DOM 的轻量预览。

PNG、JPEG、GIF、WebP、SVG、BMP 和 AVIF 会直接显示图片预览并可下载。Word、PDF、Excel、压缩包和其他二进制/办公格式可以上传和保存在 workspace 中，但 Files 不会尝试解析或编辑，只显示文件大小、不可预览说明和下载入口。

## Session URL

打开或创建 session 成功后，浏览器地址会自动包含：

```text
/codex/?session=<thread-id>
```

刷新该地址会等待 Codex app-server ready，然后自动执行 thread resume。点击 session 或通过 URL 恢复 session 时，页面会立即显示全局 Loading 遮罩，并在恢复成功或失败后解除，避免重复点击。`session` 可以与 `file` 参数共存；选择新 workspace、创建空白对话或删除当前 session 时会清除旧的 session 参数。

每条已完成的 Codex 文本回复下方提供复制与分支操作。复制会保留回答的原始 Markdown；分支使用 app-server 原生 `thread/fork` 与该回复的 `lastTurnId` 创建新 session，只保留到这条回复为止，后续对话不会带入，原 session 也不会被修改。这里不提供点赞、点踩等无关操作。Thread/Turn 提供的时间会显示在用户与 Codex 消息下方；历史消息使用 turn 开始/完成时间，实时消息使用 item 事件时间。

New thread 的默认模型与 reasoning effort 来自当前工作区生效的 `config.toml`（`model`、`model_reasoning_effort`）。仅在配置未指定时，才回退到 app-server 模型目录中标记为默认的模型；不会再直接把模型列表第一项当成用户配置。

## 内存说明

Node 不维护浏览器 WebSocket。浏览器在生成时高频拉取增量状态，空闲时自动降频，页面隐藏时降为 15 秒；提交新 turn 后会立即唤醒轮询。Session 列表从 app-server 分页加载，打开会话只返回最近 60 条 UI 消息，更早内容按需加载，Settings 关闭时不会持续读取资源数据。

会话 JSON 不包含 app-server 返回的原始 `turns`，工具输出和 diff 也有首包上限。生成图片通过受保护的图片 URL 单独读取，不会把 Base64 图片重复塞进会话响应。

`codex app-server` 会在 Web UI 启动时冷加载并常驻。页面显示分阶段的全局 Loading，模型和首屏 session 同时就绪后再进入 UI。Settings 提供 Start、Stop 和 Restart，并显示 PID、运行状态与错误。

生产验证中的参考值：

- Harness Node RSS：约 76–79 MB
- Codex app-server RSS：约 92–129 MB
- Node V8 heap 上限：256 MB

RSS 包含 V8 之外的 Buffer 和原生内存，因此可能高于当前 heap usage。Codex app-server 是独立子进程，也会单独占用内存。

## 验证

先启动一个生产服务：

```bash
npm run build
CODEX_WEB_PORT=8876 CODEX_WEB_BASE_PATH=/codex npm start
```

运行完整 UI 验证：

```bash
/home/pldz/local/venv/bin/python scripts/verify_ui.py
```

运行真实 Codex 流式验证：

```bash
CODEX_WEB_VERIFY_URL=http://127.0.0.1:8876/codex/ \
/home/pldz/local/venv/bin/python scripts/verify_streaming.py
```

截图输出到 `artifacts/screenshots/`。

开发 UI fixture：

```text
http://127.0.0.1:8765/?demo=1
```

`?demo=1` 不会连接真实 Codex，只用于 UI 开发与截图验证。

## 常见问题

### `Cannot find module dist-server/index.js`

尚未生产构建，先执行：

```bash
npm run build
```

### 浏览器提示模块 MIME 类型是 `text/html`

通常是旧构建或 base path/proxy 不一致：

1. 重新执行 `npm run build`
2. 确认 `CODEX_WEB_BASE_PATH` 与 Nginx location 一致
3. 确认代理了整个 `/codex/`，包括静态资源和 HTTP API

### 新对话无法发送

先在 workspace picker 中选择目录。查看已有 session 不要求预先选择 workspace。

### Account usage 显示 Unavailable

当前 Codex 认证方式没有提供账号 usage/rate-limit 接口。对话、文件和 session 功能仍可正常使用。
