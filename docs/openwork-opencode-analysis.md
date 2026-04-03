# OpenWork 与 OpenCode 架构深度分析

> 文档版本：v0.11.199 | 最后更新：2026-04-02

---

## 一、项目概览

| 属性 | 值 |
|------|----|
| 仓库地址 | `https://github.com/different-ai/openwork.git` |
| 包名 | `@different-ai/openwork-workspace` |
| 主开发分支 | `dev`（main 分支已长期未更新，dev 领先 1700+ 提交） |
| 技术栈 | pnpm monorepo、SolidJS + Vite（前端）、Tauri 2（桌面壳）、Bun（服务端） |
| OpenCode 版本 | `v1.2.27`（由 `constants.json` 中 `opencodeVersion` 控制） |

---

## 二、OpenWork 与 OpenCode 的关系

```
┌──────────────────────────────────────────────┐
│               OpenWork（桌面应用）              │
│  SolidJS UI  ←→  OpenWork Server  ←→  Tauri  │
└────────────────────────┬─────────────────────┘
                         │ sidecar 子进程
                         ▼
┌──────────────────────────────────────────────┐
│                  OpenCode                     │
│  AI 编码代理核心（CLI + REST serve 模式）       │
│  会话管理 / Agent / Skill / MCP / 工具调用     │
└──────────────────────────────────────────────┘
```

| 层级 | 组件 | 角色 |
|------|------|------|
| 底层引擎 | **OpenCode** | AI 编码代理核心，类似 Claude Code / Codex 的开源替代 |
| 中间层 | **OpenWork Orchestrator** | CLI 编排器，负责管理所有 sidecar 子进程的生命周期 |
| 上层应用 | **OpenWork** | 基于 OpenCode 的桌面 GUI 应用 |

**核心设计**：OpenWork 通过 Orchestrator 以 sidecar 子进程方式启动并管理 OpenCode，对外暴露 OpenWork Server API（端口 8787），前端 UI 通过该 API 与 OpenCode 交互。

---

## 三、完整项目结构

```
openwork/
├── apps/
│   ├── app/              → 前端 UI（SolidJS + Vite + Tailwind）
│   ├── desktop/          → Tauri 桌面壳（Rust）
│   │   └── src-tauri/
│   │       ├── tauri.conf.json   → 版本号、updater 端点、sidecar 列表
│   │       └── Cargo.toml        → Rust 依赖
│   ├── server/           → OpenWork Server（Bun，代理并扩展 OpenCode API）
│   ├── orchestrator/     → CLI 编排器（Bun，核心启动 + 状态隔离逻辑）
│   │   └── src/cli.ts    → 8600+ 行，所有启动逻辑所在
│   ├── opencode-router/  → Slack / Telegram / WhatsApp 路由器（Bun）
│   ├── share/            → 分享功能
│   ├── story-book/       → 组件故事书
│   └── ui-demo/          → UI 组件快速预览（v0.11.199 新增）
├── packages/
│   ├── ui/               → 共享 UI 组件（React + Solid 双框架）
│   └── docs/             → 文档
├── ee/                   → 企业版（Den 服务、Landing 页面等）
├── constants.json        → OpenCode 版本号（opencodeVersion）
└── pnpm-lock.yaml
```

---

## 四、OpenCode 二进制获取策略

OpenWork 自带管理 OpenCode 二进制，**默认不使用系统已安装的 opencode**。

### 4.1 获取优先级（`--opencode-source` 控制）

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | **Bundled（打包内置）** | 构建时通过 `prepare-sidecar.mjs` 从 GitHub releases 下载，打包至 `apps/desktop/src-tauri/sidecars/` |
| 2 | **Downloaded（运行时下载）** | Orchestrator 启动时从 `github.com/different-ai/openwork/releases` 下载，版本由 `constants.json` 控制 |
| 3 | **External（手动指定）** | 通过 `--opencode-bin <path>` 或 `OPENWORK_OPENCODE_BIN` 环境变量指定，需同时开启 `--allow-external` |

```bash
# 使用系统已安装的 opencode
export OPENWORK_OPENCODE_BIN=$(which opencode)
export OPENWORK_ALLOW_EXTERNAL=1
openwork start

# 或通过 CLI 参数
openwork start --opencode-bin /path/to/opencode --allow-external
```

### 4.2 sidecar 列表（`tauri.conf.json`）

Tauri 打包时捆绑的 sidecar 二进制：

```json
"externalBin": [
  "sidecars/opencode",
  "sidecars/openwork-server",
  "sidecars/opencode-router",
  "sidecars/openwork-orchestrator",
  "sidecars/chrome-devtools-mcp",
  "sidecars/versions.json"
]
```

---

## 五、运行时服务架构

Orchestrator 启动后管理以下三个子进程：

```
openwork start
    │
    ├── opencode serve          → AI 核心（随机端口，仅本地）
    │     └── REST API: /session /agent /skill /mcp ...
    │
    ├── openwork-server         → OpenWork API 代理（默认端口 8787）
    │     └── 代理 OpenCode + 扩展 AgentLab / Den 等功能
    │
    └── opencode-router         → 消息路由（按 workspace 配置决定是否启动）
          └── Slack / Telegram / WhatsApp → OpenCode session
```

**端口说明：**

| 服务 | 默认端口 | 说明 |
|------|----------|------|
| OpenWork Server | `8787` | 前端 UI 连接的主要 API 端点 |
| OpenCode serve | 随机 | 仅本地访问，OpenWork Server 转发 |
| OpenCode Router 健康检查 | 随机（沙箱内 `3005`） | 消息路由器状态 |

---

## 六、编译与启动

### 6.1 前置条件

| 工具 | 版本要求 |
|------|----------|
| Node.js | 推荐 22+ |
| pnpm | 10.27.0 |
| Bun | 1.3.9+ |
| Rust 工具链 | stable（Tauri 需要） |
| Xcode Command Line Tools | macOS 必须 |

### 6.2 常用命令

```bash
# 安装依赖
pnpm install --frozen-lockfile

# 启动完整桌面应用（含 Tauri，必须在前台交互式终端运行）
pnpm dev
# 等价于：
./scripts/dev-setup.sh

# 仅启动前端 UI（不含 Tauri，端口 5173）
pnpm dev:ui

# 重启服务
./scripts/dev-setup.sh --restart

# 停止所有服务
./scripts/dev-setup.sh --stop

# 检查运行状态
./scripts/dev-setup.sh --status

# 构建生产版本
pnpm build
```

### 6.3 `pnpm dev` 启动流程

```
pnpm dev
  │
  ├─ 1. tauri-before-dev.mjs      → 准备 sidecars（检查/下载 opencode 等二进制）
  ├─ 2. Vite dev server           → 启动前端 UI（端口 5173）
  └─ 3. Tauri                     → 启动桌面应用窗口，加载 http://localhost:5173
            │
            └─ Orchestrator       → 以 sidecar 子进程启动
                    ├─ opencode serve
                    ├─ openwork-server
                    └─ opencode-router（可选）
```

> **注意**：Tauri 需要 TTY，必须在前台交互式终端运行，不支持后台执行。

### 6.4 直接使用 Orchestrator CLI

```bash
# 在某个项目目录启动
openwork start --workspace /path/to/my-project

# 以 serve 模式运行（输出日志，不使用 TUI）
openwork serve --workspace /path/to/my-project

# 检查服务健康状态
openwork status

# 管理工作区
openwork workspace list
openwork workspace add --directory /path/to/project --name my-project
openwork workspace switch <id>
```

---

## 七、配置目录隔离机制

### 7.1 全局配置：已隔离，互不干扰

**本地 OpenCode CLI 使用的目录（标准 XDG）：**

```
~/.config/opencode/         → 全局配置（opencode.json、providers 等）
~/.local/share/opencode/    → 数据（SQLite 数据库、日志、auth token 等）
~/.cache/opencode/          → 缓存
```

**OpenWork 管理的 OpenCode 目录：**

生产模式（`OPENWORK_DEV_MODE` 未设置）：
```
~/.openwork/openwork-orchestrator/opencode-config/<workspace-id>/
```
OpenWork 通过设置 `OPENCODE_CONFIG_DIR` 环境变量将 OpenCode 的配置目录重定向到此处。

开发模式（`OPENWORK_DEV_MODE=1`）：
```
~/.openwork/openwork-orchestrator/openwork-dev-data/
  ├── home/                    → 伪造的 HOME（OPENCODE_TEST_HOME）
  ├── xdg/
  │   ├── config/              → 伪造的 XDG_CONFIG_HOME
  │   ├── data/                → 伪造的 XDG_DATA_HOME
  │   ├── cache/               → 伪造的 XDG_CACHE_HOME
  │   └── state/               → 伪造的 XDG_STATE_HOME
  └── config/opencode/         → OPENCODE_CONFIG_DIR 实际指向
```

OpenWork 开发模式会设置以下环境变量注入到 OpenCode 子进程，实现完全隔离：

```
OPENWORK_DEV_MODE=1
HOME=<rootDir>/home
OPENCODE_TEST_HOME=<rootDir>/home
XDG_CONFIG_HOME=<rootDir>/xdg/config
XDG_DATA_HOME=<rootDir>/xdg/data
XDG_CACHE_HOME=<rootDir>/xdg/cache
XDG_STATE_HOME=<rootDir>/xdg/state
OPENCODE_CONFIG_DIR=<rootDir>/config/opencode
```

### 7.2 项目级配置：共用，属于设计意图

以下文件由本地 OpenCode CLI 和 OpenWork 共同读写（均指向同一项目目录）：

```
<项目>/
  ├── .opencode/
  │   ├── agent/         → Agent 定义（*.md）
  │   ├── agents/        → Agent 定义（plural 格式）
  │   ├── skills/        → Skill 定义（<name>/SKILL.md）
  │   └── openwork.json  → OpenWork 特有配置（消息路由等）
  ├── opencode.json      → OpenCode 项目级配置
  └── opencode.jsonc     → 同上（支持注释格式）
```

这是设计如此，让 OpenWork 能直接复用已有的项目配置。

### 7.3 潜在冲突点

| 冲突类型 | 说明 | 规避方式 |
|----------|------|----------|
| 端口冲突 | 本地 opencode serve 与 OpenWork 启动的 opencode 抢占端口 | 不要同时运行两个实例 |
| 文件竞争 | 同一项目 `.opencode/` 目录被两个进程并发写入 | 同上 |
| SQLite 锁 | 两个 opencode 实例操作同一工作区数据库 | 同上 |

**安全使用建议**：不要在同一项目目录下同时运行本地 opencode CLI 和 OpenWork。全局配置完全隔离，无需担心。

---

## 八、环境变量完整参考

### 8.1 核心运行控制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENWORK_DEV_MODE` | `""` | 开发模式开关（`1`/`true`/`yes`/`on` 均可） |
| `OPENWORK_DATA_DIR` | `~/.openwork/openwork-orchestrator` | Orchestrator 数据目录覆盖 |
| `OPENWORK_RUN_ID` | 随机 UUID | 日志关联 ID |
| `OPENWORK_LOG_FORMAT` | `pretty` | 日志格式（`pretty` / `json`） |
| `OPENWORK_VERBOSE` | `""` | 输出额外诊断信息 |

### 8.2 OpenCode 二进制管理

| 变量 | 说明 |
|------|------|
| `OPENWORK_OPENCODE_BIN` | 自定义 OpenCode 二进制路径（需同时设 `OPENWORK_ALLOW_EXTERNAL=1`） |
| `OPENWORK_ALLOW_EXTERNAL` | 允许使用外部二进制（仅开发/调试用） |
| `OPENWORK_OPENCODE_SOURCE` | 二进制来源优先级：`auto` / `bundled` / `downloaded` / `external` |
| `OPENWORK_SIDECAR_SOURCE` | sidecar 来源：`auto` / `bundled` / `downloaded` / `external` |
| `OPENWORK_SIDECAR_DIR` | sidecar 缓存目录 |
| `OPENWORK_SIDECAR_BASE_URL` | sidecar 下载基础 URL 覆盖 |
| `OPENWORK_SIDECAR_MANIFEST_URL` | sidecar manifest 文件 URL 覆盖 |
| `OPENWORK_SERVER_BIN` | 自定义 openwork-server 二进制路径 |

### 8.3 OpenCode 运行时配置

| 变量 | 说明 |
|------|------|
| `OPENWORK_OPENCODE_PORT` | OpenCode serve 端口覆盖（默认随机） |
| `OPENWORK_OPENCODE_HOST` | OpenCode serve 绑定主机 |
| `OPENWORK_OPENCODE_BIND_HOST` | OpenCode 监听地址覆盖 |
| `OPENWORK_OPENCODE_WORKDIR` | OpenCode 工作目录 |
| `OPENWORK_OPENCODE_HOT_RELOAD` | 是否启用热重载（`true` / `false`，默认 `true`） |
| `OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS` | 热重载防抖时间（默认 700ms） |
| `OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS` | 热重载冷却时间（默认 1500ms） |
| `OPENWORK_OPENCODE_CORS` | OpenCode CORS 允许的来源 |
| `OPENCODE_CONFIG_DIR` | OpenCode 配置目录（OpenWork 管理时自动注入） |
| `OPENCODE_ASSET` | 指定下载的 OpenCode asset 文件名 |

### 8.4 OpenWork Server 配置

| 变量 | 说明 |
|------|------|
| `OPENWORK_HOST` | OpenWork Server 绑定主机（默认 `127.0.0.1`） |
| `OPENWORK_REMOTE_ACCESS` | 设为 `1` 则在 `0.0.0.0` 上监听（用于局域网分享） |
| `OPENWORK_TOKEN` | 客户端访问 token |
| `OPENWORK_HOST_TOKEN` | Host token（用于审批功能） |
| `OPENWORK_CORS_ORIGINS` | CORS 允许来源（逗号分隔或 `*`） |
| `OPENWORK_APPROVAL_MODE` | 操作审批模式：`manual` / `auto` |
| `OPENWORK_URL` | OpenWork Server URL 覆盖 |
| `OPENWORK_SERVER_URL` | 同上 |

### 8.5 认证配置

| 变量 | 说明 |
|------|------|
| `OPENWORK_OPENCODE_USERNAME` | OpenCode Basic Auth 用户名（覆盖随机生成） |
| `OPENWORK_OPENCODE_PASSWORD` | OpenCode Basic Auth 密码（覆盖随机生成） |
| `OPENCODE_SERVER_USERNAME` | 同上（兼容格式） |
| `OPENCODE_SERVER_PASSWORD` | 同上（兼容格式） |
| `OPENWORK_OPENCODE_AUTH` | OpenCode 认证控制 |

### 8.6 OpenCode Router（消息路由）

| 变量 | 说明 |
|------|------|
| `OPENWORK_OPENCODE_ROUTER` | 是否启用 OpenCode Router（默认由 workspace 配置决定） |
| `OPENCODE_ROUTER_BIN` | 自定义 Router 二进制路径 |
| `OPENCODE_ROUTER_CONFIG_PATH` | Router 配置文件路径 |
| `OPENCODE_ROUTER_DATA_DIR` | Router 数据目录（默认 `~/.openwork/opencode-router`） |
| `OPENCODE_ROUTER_HEALTH_PORT` | Router 健康检查端口 |
| `OPENCODE_URL` | OpenCode serve URL（Router 使用） |

### 8.7 沙箱模式（Docker / Container）

| 变量 | 说明 |
|------|------|
| `OPENWORK_SANDBOX_IMAGE` | 沙箱容器镜像 |
| `OPENWORK_SANDBOX_PERSIST_DIR` | 沙箱持久化目录 |
| `OPENWORK_SANDBOX_MOUNT` | 额外挂载规格（`hostPath:subpath[:ro|rw]`） |
| `OPENWORK_SANDBOX_MOUNT_ALLOWLIST` | 允许挂载的主机路径白名单 |
| `OPENWORK_SANDBOX_MOUNT_OPENCODE_CONFIG` | 沙箱内 OpenCode 配置挂载路径 |
| `OPENWORK_DOCKER_BIN` | Docker 可执行文件路径覆盖 |

### 8.8 开发/调试

| 变量 | 说明 |
|------|------|
| `OPENWORK_DEV_OPENCODE_IMPORT_CONFIG_DIR` | 开发模式下导入的 OpenCode 配置目录 |
| `OPENWORK_DEV_OPENCODE_IMPORT_DATA_DIR` | 开发模式下导入的 OpenCode 数据目录 |
| `OPENWORK_WORKSPACE` | 工作区路径 |
| `OPENWORK_COLOR` | 强制启用 / 禁用 ANSI 颜色输出 |
| `OPENWORK_DAEMON_PORT` | Orchestrator 守护进程端口 |

---

## 九、CLI 完整命令参考

```
openwork <command> [options]

命令：
  start          启动 OpenCode + OpenWork Server + OpenCodeRouter（含 TUI 界面）
  serve          启动服务并流式输出日志（不使用 TUI）
  daemon         守护进程模式（多工作区 router）
    run          前台运行
    start        后台启动
    stop         停止
    status       查看状态
  workspace      管理工作区
    add          添加工作区
    add-remote   添加远程工作区
    list         列出所有工作区
    switch       切换当前工作区
    info         查看工作区信息
    path         输出工作区路径
  instance       管理工作区实例
    dispose      销毁实例
  approvals      审批管理
    list         列出待审批请求
    reply        批准或拒绝请求
  files          文件会话管理
    session      管理文件会话
    catalog      文件目录
    events       SSE 事件流
    read/write/mkdir/delete/rename
  status         检查 OpenCode/OpenWork 健康状态

关键选项：
  --workspace <path>        工作区目录（默认当前目录）
  --opencode-bin <path>     自定义 opencode 路径（需 --allow-external）
  --allow-external          允许外部二进制
  --opencode-source <mode>  auto | bundled | downloaded | external
  --sandbox <mode>          none | auto | docker | container
  --remote-access           局域网分享模式
  --approval <mode>         manual | auto
  --data-dir <path>         数据目录
  --tui / --no-tui          控制交互式面板
  --detach                  启动后后台运行
  --verbose                 输出详细诊断
  --log-format <fmt>        pretty | json
```

---

## 十、关键文件速查

| 文件 | 用途 |
|------|------|
| `constants.json` | OpenCode 版本号（`opencodeVersion`） |
| `apps/orchestrator/src/cli.ts` | 核心启动逻辑、二进制获取、目录隔离（8600+ 行） |
| `apps/desktop/scripts/prepare-sidecar.mjs` | 构建时 sidecar 下载/构建脚本 |
| `apps/desktop/src-tauri/tauri.conf.json` | Tauri 版本号、updater 端点、sidecar 列表 |
| `apps/desktop/src-tauri/Cargo.toml` | Rust 包版本（需与 tauri.conf.json 同步） |
| `apps/desktop/src-tauri/src/updater.rs` | Tauri 自动更新逻辑（检测 DMG/AppTranslocation） |
| `apps/server/src/server.ts` | OpenWork Server 路由（skills、agent、agentlab 等） |
| `apps/server/src/mcp.ts` | MCP 配置读取 |
| `apps/opencode-router/src/opencode.ts` | OpenCode SDK 客户端封装 |
| `scripts/dev-setup.sh` | 一键开发环境脚本 |

---

## 十一、版本管理注意事项

OpenWork 有两处版本号需要同步：

1. `apps/desktop/src-tauri/tauri.conf.json` → `"version"` 字段
2. `apps/desktop/src-tauri/Cargo.toml` → `version` 字段

Tauri 自动更新器会对比本地版本与 GitHub releases 的 `latest.json`，如两处版本落后于 GitHub 最新发布版，会触发"更新可用"通知。每次合并上游后需同步更新这两个文件。

```bash
# 当前版本: 0.11.199
# updater 端点: https://github.com/different-ai/openwork/releases/latest/download/latest.json
```

---

## 十二、常见问题

**Q：启动时提示"Update available"但我不想更新**

本地 `tauri.conf.json` 版本号低于 GitHub 最新版导致。将两个版本文件更新到与 GitHub 一致即可消除提示。

**Q：如何使用本地开发版 OpenCode**

```bash
export OPENWORK_OPENCODE_BIN=/path/to/local/opencode
export OPENWORK_ALLOW_EXTERNAL=1
pnpm dev
```

**Q：OpenWork 会不会影响我全局的 opencode 配置**

不会。OpenWork 通过设置 `OPENCODE_CONFIG_DIR` 和 XDG 环境变量，将 OpenCode 配置完全重定向到 `~/.openwork/` 目录下，不会读写 `~/.config/opencode/`。

**Q：可以在同一个项目里同时运行 opencode CLI 和 OpenWork 吗**

技术上可以，但项目级 `.opencode/` 目录和 SQLite 数据库可能出现并发访问冲突，不建议同时运行。

**Q：`pnpm dev` 不能在后台运行**

Tauri 需要 TTY，必须在前台交互式终端。可以使用 `openwork start --detach` 以无 TUI 方式后台运行。

---

## 十三、并发与多用户访问能力分析

### 13.1 三个层次的并发能力

| 维度 | 并发支持 | 说明 |
|------|----------|------|
| 同一 workspace 多 Session | ✅ 支持 | Session 状态独立（`busy`/`idle` per-session），可同时运行 |
| 多 Workspace 并行 | ✅ 支持 | 通过 `directory` 参数区分，单 OpenCode 进程原生支持 |
| 多用户同时访问 | ⚠️ 有限支持 | 需借助 `--remote-access`，无用户隔离 |
| 同一 Session 并发 prompt | ❌ 不支持 | 单 session 内串行，`busy` 时需等待或中断 |
| 生产级多租户 | ❌ 不原生支持 | 需要 Den 企业版或自建网关层 |

### 13.2 关键架构事实：单 OpenCode 进程支持多目录并发

OpenCode serve 的所有核心 API 均接受 `directory?` 参数：

```typescript
// Session 创建 - 指定在哪个目录下创建 session
SessionCreateData: { query?: { directory?: string } }

// Session 列表 - 按目录过滤
SessionListData:   { query?: { directory?: string } }  // "Filter sessions by project directory"

// Project 查询
ProjectListData:   { query?: { directory?: string } }
```

**单个 OpenCode serve 进程本身就支持多目录并发**。OpenWork 的"多 workspace"并不是启动多个 OpenCode 进程，而是通过 `directory` 参数让同一个 OpenCode 进程服务不同的项目目录。

Orchestrator daemon 内部也只维护一个 `opencodeChild`：

```typescript
// apps/orchestrator/src/cli.ts - daemon 模式
let opencodeChild: ReturnType<typeof spawn> | null = null;  // 全局唯一

// 多 workspace 路由时，通过 directory 区分
const client = createOpencodeClient({ baseUrl, directory: workspace.path });
```

### 13.3 基于 Workspace 隔离实现多用户并发的方案

用户的核心思路是正确的：**为每个用户创建独立 workspace（目录），即可实现并发隔离**。

```
调度层
    │
    ├── User A → workspace 目录 /workspaces/user-a/  → directory=user-a
    ├── User B → workspace 目录 /workspaces/user-b/  → directory=user-b
    └── User C → workspace 目录 /workspaces/user-c/  → directory=user-c
    │
    └──────────────► 同一个 OpenCode 进程（原生并发）
                           ↕ directory 参数区分
                     Session A1, A2（属于 user-a 目录）
                     Session B1（属于 user-b 目录）
```

**实现步骤：**

1. 为每个用户在文件系统创建独立目录（如 `/workspaces/<user-id>/`）
2. 通过 `POST /workspaces/local` 将该目录注册为 workspace
3. 后续所有操作使用该 workspace 的 `id`，OpenWork Server 转发时自动携带 `directory`
4. 不同用户的 session 天然隔离，互不干扰

不需要为每个用户启动新的 OpenWork / OpenCode 进程，资源开销极低。

### 13.4 Auth 隔离：当前的缺口与解决方案

OpenWork Server 目前使用**单全局 token** 认证，`TokenScope`（`owner`/`collaborator`/`viewer`）只区分读写权限，不区分用户身份。任何持有 token 的客户端都能访问所有 workspace。

**多用户方案对比：**

| 方案 | 复杂度 | 隔离性 | 适用场景 |
|------|--------|--------|----------|
| **A. 单 token + 按 workspace 划分目录** | 低 | 目录隔离，无访问控制 | 内部信任环境、单人多项目 |
| **B. 每用户独立启动 OpenWork 实例（不同端口）** | 中 | 完全隔离 | 用户数量少，可接受资源消耗 |
| **C. 调度网关层：JWT → workspaceId 路由** | 中 | 用户级访问控制 | 自建多用户平台 |
| **D. Den 企业版** | 低（托管） | 完整多租户 | 生产级商业场景 |

**方案 C（推荐自建场景）的架构：**

```
用户请求 (JWT)
    │
    ▼
网关层（Nginx / 自定义 Proxy）
    │ 解码 JWT → 获取 userId → 映射到 workspaceId
    │ 重写请求路径：/api/* → /workspace/<workspaceId>/*
    │
    ▼
OpenWork Server (localhost:8787)
    │ 使用 host-token（内部信任）
    │
    ▼
OpenCode（单进程，directory 参数隔离用户数据）
```

### 13.5 消息路由（OpenCode Router）的并发模型

Slack / Telegram 接入时，`bridge.ts` 使用 `sessionQueue` 对**同一 session** 的消息串行化：

```typescript
// apps/opencode-router/src/bridge.ts
const sessionQueue = new Map<string, Promise<void>>();
// key = `${directory}::${sessionID}`
```

- 同一 session 的消息**串行**处理（避免 prompt 乱序）
- 不同 session / 不同目录的消息**并发**处理
