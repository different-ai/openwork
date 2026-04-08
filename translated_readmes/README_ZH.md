[![Discord](https://img.shields.io/badge/discord-加入-5865F2?logo=discord&logoColor=white)](https://discord.gg/VEhNQXxYMB)

[English](../README.md) | 简体中文 | [其他语言](./README.md)

# OpenWork
> 让您的公司提升 1000 倍的生产力。

我们为 AI 智能体配备您团队已经在使用的工具，并让它们从您的行为中学习。您使用 OpenWork 越多，工具之间的连接就越紧密，积累的知识就越多，能够自动化的工作块就越大。

OpenWork 是 opencode 的最简单界面。双击，选择一个文件夹，即可立即获得三大核心优势：
1. 零摩擦设置 — 您现有的 opencode 配置开箱即用，无需迁移
2. 聊天集成 — WhatsApp 和 Telegram 即时可用（一个令牌，全部搞定）
3. 云端就绪 — 每个应用都可以作为客户端；部署到云端，随时随地访问
> **创建安全智能体工作流程并与团队共享的最简单方式**

它是 "Claude Work" 的**可扩展开源替代品**。


<img width="1292" height="932" alt="Screenshot 2026-01-31 at 16 22 39" src="https://github.com/user-attachments/assets/5742be91-9cfb-4212-b32d-cf2a27b1c093" />


<img width="1292" height="932" alt="Screenshot 2026-01-31 at 13 43 30" src="https://github.com/user-attachments/assets/6639d1ef-c831-406e-a812-87fde403e6d5" />


OpenWork 围绕一个核心理念设计：让您可以轻松地将智能体工作流程作为可重复的、产品化的流程进行交付。

它是一个原生桌面应用程序，底层运行 **OpenCode**，但将其呈现为简洁的引导式工作流程：
- 选择工作区
- 开始运行
- 观察进度 + 计划更新
- 需要时批准权限
- 重用有效的方法（命令 + 技能）

目标：让"智能体工作"感觉像一个产品，而不是终端。

## 其他界面

- **Owpenbot (WhatsApp 机器人)**：为运行中的 OpenCode 服务器提供的轻量级 WhatsApp 桥接器。安装方法：
  - `curl -fsSL https://raw.githubusercontent.com/different-ai/owpenbot/dev/install.sh | bash`
  - 运行 `owpenbot setup`，然后 `owpenbot whatsapp login`，接着 `owpenbot start`
  - 完整设置：https://github.com/different-ai/owpenbot/blob/dev/README.md
- **Openwrk (CLI 主机)**：无需桌面 UI 即可运行 OpenCode + OpenWork 服务器。使用 `npm install -g openwrk` 安装。
  - 文档：[apps/orchestrator/README.md](../apps/orchestrator/README.md)


## 快速开始
在此处下载 dmg：https://github.com/different-ai/openwork/releases（或按照下面的说明从源代码安装）

## 为什么选择 OpenWork

当前 opencode 的 CLI 和 GUI 都以开发者为中心。这意味着专注于文件差异、工具名称，以及在不依赖某种形式的 CLI 的情况下难以扩展的功能。

OpenWork 的设计目标是：
- **可扩展**：技能和 opencode 插件是可安装的模块。
- **可审计**：显示发生了什么、何时发生以及为什么发生。
- **权限控制**：访问特权流程。
- **本地/远程**：OpenWork 可以在本地工作，也可以连接到远程服务器。

## 包含的功能

- **主机模式**：在您的计算机上本地运行 opencode
- **客户端模式**：通过 URL 连接到现有的 OpenCode 服务器
- **会话**：创建/选择会话并发送提示
- **实时流传输**：SSE `/event` 订阅以获取实时更新
- **执行计划**：将 OpenCode 待办事项呈现为时间线
- **权限**：显示权限请求并回复（允许一次/始终允许/拒绝）
- **模板**：保存并重新运行常见工作流程（本地存储）
- **技能管理器**：
  - 列出已安装的 `.opencode/skills` 文件夹
  - 将本地技能文件夹导入到 `.opencode/skills/<skill-name>`
 

## 技能管理器    
<img width="1292" height="932" alt="image" src="https://github.com/user-attachments/assets/b500c1c6-a218-42ce-8a11-52787f5642b6" />


## 适用于本地计算机或服务器
<img width="1292" height="932" alt="Screenshot 2026-01-13 at 7 05 16 PM" src="https://github.com/user-attachments/assets/9c864390-de69-48f2-82c1-93b328dd60c3" />


## 快速开始

### 系统要求

- Node.js + `pnpm`
- Rust 工具链（用于 Tauri）：通过 `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` 安装
- Tauri CLI：`cargo install tauri-cli`
- 已安装 OpenCode CLI 且可在 PATH 中使用：`opencode`

### 安装

```bash
pnpm install
```

OpenWork 现在位于 `packages/app`（UI）和 `packages/desktop`（桌面外壳）中。

### 运行（桌面版）

```bash
pnpm dev
```

### 运行（仅 Web UI）

```bash
pnpm dev:ui
```

### Arch 用户：

```bash
curl -fsSL https://opencode.ai/install | bash -s -- --version "$(node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync('constants.json','utf8')); process.stdout.write(String(parsed.opencodeVersion||'').trim().replace(/^v/,''));")" --no-modify-path
```

## 架构（高级）

- 在**主机模式**中，OpenWork 启动：
  - `opencode serve --hostname 127.0.0.1 --port <free-port>`
  - 以您选择的项目文件夹作为进程工作目录。
在主机模式下，OpenWork 直接在您的计算机上后台启动 OpenCode 服务器。
当您选择项目文件夹时，OpenWork 使用该文件夹在本地运行 OpenCode 并将桌面 UI 连接到它。
这允许您完全在您的机器上运行智能体工作流程、发送提示并查看进度，而无需依赖远程服务器。

- UI 使用 `@opencode-ai/sdk/v2/client` 来：
  - 连接到服务器
  - 列出/创建会话
  - 发送提示
  - 订阅 SSE 事件（即“服务器发送事件”，用于从服务器向 UI 流式传输实时更新）
  - 读取待办事项和权限请求



## 文件夹选择器

文件夹选择器使用 Tauri 对话框插件。
功能权限在以下文件中定义：
- `packages/desktop/src-tauri/capabilities/default.json`

## OpenCode 插件

插件是扩展 OpenCode 的**原生**方式。OpenWork 现在通过从技能选项卡读取和写入 `opencode.json` 来管理它们。

- **项目范围**：`<workspace>/opencode.json`
- **全局范围**：`~/.config/opencode/opencode.json`（或 `$XDG_CONFIG_HOME/opencode/opencode.json`）

您仍然可以手动编辑 `opencode.json`；OpenWork 使用与 OpenCode CLI 相同的格式：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-wakatime"]
}
```

## 有用的命令

```bash
pnpm dev
pnpm dev:ui
pnpm typecheck
pnpm build
pnpm build:ui
pnpm test:e2e
```

## 故障排除

### Linux / Wayland (Hyprland)

如果 OpenWork 在启动时因 WebKitGTK 错误（如 `Failed to create GBM buffer`）而崩溃，请在启动前禁用 dmabuf 或合成。尝试以下环境标志之一。

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork
```

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 openwork
```

## 安全说明

- OpenWork 默认隐藏模型推理和敏感工具元数据。
- 主机模式默认绑定到 `127.0.0.1`。

## 贡献

- 在进行更改之前，请查看 `AGENTS.md` 以及 `VISION.md`、`PRINCIPLES.md`、`PRODUCT.md` 和 `ARCHITECTURE.md` 以了解产品目标。
- 在仓库内工作之前，确保已安装 Node.js、`pnpm`、Rust 工具链和 `opencode`。
- 每次检出后运行一次 `pnpm install`，然后在打开 PR 之前使用 `pnpm typecheck` 加上 `pnpm test:e2e`（或目标脚本子集）验证您的更改。
- 按照 `AGENTS.md` 中描述的 `.opencode/skills/prd-conventions/SKILL.md` 约定，将新的 PRD 添加到 `packages/app/pr/<name>.md`。

## 面向团队和企业

有兴趣在您的组织中使用 OpenWork？我们很乐意听取您的意见 — 请发送邮件至 [benjamin.shafii@gmail.com](mailto:benjamin.shafii@gmail.com) 与我们讨论您的用例。

## 许可证

MIT — 请参见 `LICENSE`。
