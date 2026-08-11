# OpenWork 桌面应用 · 简体中文本地化翻译

> OpenWork Desktop (Windows) — Simplified Chinese (zh-CN) Localization

官方 `zh` 语言包覆盖率约 **63%**（官方 1179 键 vs 英文 1856 键），界面仍有大量缺失键与硬编码英文字符串。本仓库在官方语言包基础上补齐缺失键、修复值为英文的键，并翻译了 UI 中硬编码的英文字符串。

---

## 翻译规模

| 类别 | 数量 | 说明 |
|---|---|---|
| 官方 zh 语言包（已有） | 1179 键 | 其中约 50 键值为英文，33 键已在本仓库修复 |
| 新增缺失键 | 712 键 | `zh-new-keys.ts`，官方 zh 缺失、界面回退英文的键 |
| 修复键 | 47 键 | `zh-fixes.ts`：10 缺失键 + 4 共享基础键 + 33 英文值覆盖 |
| **合并后完整语言包** | **1871 键** | `zh.ts`，可直接作为官方 zh.ts 提交 |
| 硬编码字符串翻译 | 302 条 | `apply-settings-hardcoded.mjs`，UI 中写死的英文字符串 |

---

## 目录结构

```
openwork-zh-translations/
├── README.md                               # 本文件
├── docs/
│   └── TERMINOLOGY.md                      # 术语对照表
├── for-upstream/                           # 提交给官方的交付物
│   ├── SUBMIT.md                           # 提交说明
│   └── zh.ts                               # ★ 完整合并语言包（官方格式）
├── translations/                           # 翻译数据文件
│   ├── zh.ts                               # 完整合并语言包（同 for-upstream/zh.ts）
│   ├── zh-new-keys.ts                      # 712 条新增键翻译
│   ├── zh-fixes.ts                         # 47 条修复键
│   ├── hardcoded-strings.json              # 硬编码字符串翻译表（from→to）
│   ├── hardcoded-strings-notapplied.json   # 未应用的硬编码串（调试记录）
│   ├── zh-untranslated-report.json         # 有意保留英文的键
│   └── zh-missing-vs-en.json               # 官方 zh 缺失键清单
└── scripts/
    ├── apply-patch.mjs                     # 语言包一键补丁脚本
    ├── apply-settings-hardcoded.mjs        # 硬编码字符串补丁脚本
    ├── verify-batch.mjs                    # 词典区命中检查
    ├── zh-missing-translations.ts          # 脚本依赖（缺失键）
    └── zh-fix-translations.ts              # 脚本依赖（修复键）
```

---

## 翻译内容覆盖范围

### 一、语言包键（1871 键，通过 `apply-patch.mjs` 注入）

覆盖以下命名空间的缺失键补齐 + 英文值修复：

| 命名空间 | 覆盖内容 |
|---|---|
| `account.*` | 账户菜单、MCP/提供商连接状态 |
| `action.*`、`common.*` | 通用操作（移除、返回、确认等） |
| `composer.*` | 编辑器/作曲器（智能体选择、发送选项、附件排队） |
| `connect.*` | Connect 功能（团队连接、应用市场、诊断报告、安全说明） |
| `context_panel.*` | 上下文面板 |
| `dashboard.*` | 仪表盘 |
| `den.*` | Den 登录/控制台 |
| `extensions.*` | 扩展管理（资料库、应用市场、状态标签） |
| `join_org.*` | 加入组织流程 |
| `mcp.*` | MCP 服务器配置（OAuth、组织连接、快速连接） |
| `memory.*` | 记忆库管理 |
| `model_picker.*`、`models.*` | 模型选择与管理 |
| `notifications.*` | 通知中心 |
| `providers.*` | 提供商管理 |
| `question_modal.*` | 问题模态框 |
| `restrictions.*` | 组织限制提示 |
| `session.*` | 会话管理（命令、状态、诊断） |
| `session_management.*` | 会话分组/置顶/归档 |
| `settings.*` | 设置面板全部标签页标题/描述/字段 |
| `skills.*` | 技能共享 |
| `status.*` | 状态栏 |
| `welcome.*` | 欢迎页/引导流程 |
| `workspace.*`、`workspace_list.*` | 工作区管理 |

### 二、硬编码字符串（302 条，通过 `apply-settings-hardcoded.mjs` 注入）

以下 UI 界面中不走语言包的硬编码英文已全部汉化：

| 界面 | 汉化内容 |
|---|---|
| **设置菜单** | 分组标题（工作区/全局/帮助）+ 9 个 tab 卡片标题/描述（偏好设置/权限/高级/AI 提供商/Cloud/外观/环境变量/更新/恢复）+ Cd/D2t 函数硬编码标题 |
| **Automations** | 列表页（标题/搜索/空状态/新建/编辑/归档/运行/移动分组）+ 表单（名称/说明/计划/时间/时区/模型/天数/占位符/说明文字） |
| **AI 提供商** | 连接/列表（连接提供商/筛选/未连接/搜索/添加）+ OAuth 授权（授权码/粘贴代码/打开浏览器/设备码/确认码）+ OpenWork Den 远程工作器说明 |
| **权限** | 添加文件夹按钮 |
| **更新** | 立即更新/当前版本/发布渠道/稳定版/Alpha 说明 |
| **环境变量** | 说明文字/继续设置/请求的环境变量标题 |
| **外观** | 显示菜单栏 |
| **Cloud 账户** | 组织选择/资源加载/应用市场/工作区身份准备 |
| **高级诊断** | Agent 访问诊断（健康状态/探测步骤/引擎刷新/工具验证）+ OpenCode 配置来源（项目/全局/运行时数据库/注入配置） |
| **插件** | 插件库（安装/搜索/发布阶段/状态徽章/刷新市场） |
| **恢复/迁移** | Electron 迁移/AppImage 桌面集成/构件覆盖 |
| **扩展** | 详情列头（清单/资源/贡献/详情/类型/端点等）+ Computer Use 设置 + 语音模式设置 |
| **MCP** | 连接说明/发现文件/覆盖 |
| **设置导航** | 命令目录标签（打开会话/设置/扩展/文档/反馈等） |

---

## 术语约定

### 保留英文（品牌/专有名词）

- **产品/品牌**：OpenWork、OpenCode、OpenWork Cloud、Den、OpenWork Den、OpenPackage
- **技术术语**：MCP、OAuth、API、JSON、URL、PID、SHA-512/SHA-256、AppImage、Electron、Tauri
- **功能名称**：Connect、Computer Use、Automations、Skills、Library、Marketplace
- **命令/标签页**：Alpha、Beta、Preview（作为版本阶段标识时）
- **路径/标识符**：`openwork-ui-mcp`、`~/Library/Application Support/...`、`OPENWORK_UI_CONTROL_DISCOVERY=...`、`sk-...`、`https://github.com/...`

### 固定译法

| 英文 | 中文 | 备注 |
|---|---|---|
| Agent | 智能体 | |
| Workspace | 工作区 | |
| Session | 会话 | |
| Provider | 提供商 | AI 模型提供商 |
| Plugin | 插件 | |
| Extension | 扩展 | |
| Command | 命令 | |
| Marketplace | 应用市场 | |
| Library | 资料库/库 | |
| Skills | 技能 | |
| Connect | 连接 | OpenWork Connect 功能 |
| Composer | 编辑器 | 聊天输入框区域 |
| Diagnostics | 诊断 | |
| Engine | 引擎 | |
| Runtime | 运行时 | |
| Deployment | 部署 | |

### 不可译元素（原样保留）

- 占位符：`{count}`、`{path}`、`{name}`、`{org}`、`{url}`、`{hostname}`、`{pid}`、`{port}`、`{version}`、`{service}`、`{current}`、`{total}`、`{date}`、`{time}`、`{keys}`、`{value}`、`{host}`、`{newHost}`、`{currentHost}`、`{appName}`、`{clientName}` 等
- HTML 标签与 URL
- 文件路径与命令名

---

## 使用方法

### 方式一：注入本地安装包

```powershell
# 1. 完全退出 OpenWork（确保 4 个进程都结束）
# 2. 切换到脚本目录
cd "C:\Users\admin\OpenWork Chat\openwork-zh-translations\scripts"
# 3. 运行语言包补丁
node apply-patch.mjs
# 4. 运行硬编码字符串补丁
node apply-settings-hardcoded.mjs
# 5. 重新打开 OpenWork，中文翻译生效
```

**脚本特性**：
- 自动定位安装目录的 `resources/app-dist/assets/app-*.js`
- 首次运行自动备份为 `.bak`
- 写盘前语法校验，失败自动回滚
- 幂等：已打补丁时进入增量修复模式，不会重复插入
- 可通过环境变量 `OW_APP_DIR` 覆盖安装目录

### 方式二：提交官方翻译仓库

将 `translations/zh.ts`（或 `for-upstream/zh.ts`）作为官方 `zh.ts` 的替换内容提交。

---

## 技术说明

### 语言包补丁原理（`apply-patch.mjs`）

1. 解析 `zh-missing-translations.ts`（712 条缺失键）和 `zh-fix-translations.ts`（47 条修复键）
2. 在 bundle 中定位 `NAe`（zh 语言包）对象（特征：`{...hu,` + "压缩此会话"）
3. 缺失键 → 追加到对象末尾；修复键 → 替换已有值
4. 用 `vm.runInNewContext` 校验新对象语法合法性
5. 写盘后再校验，失败从 `.bak` 恢复

### 硬编码字符串补丁原理（`apply-settings-hardcoded.mjs`）

1. 维护一份 `from → to` 替换表（302 条），每条都是精确的 UI 显示串
2. 按顺序在 bundle 中 `split/join` 替换
3. 用 `node --check` 校验整个 bundle 语法（bundle 是 ES module，vm 无法解析）
4. 写盘后再校验，失败从 `.bak` 恢复

### 安全设计

- **上下文感知**：每条替换串都带 JSX 属性前缀（如 `children:"..."`、`placeholder:"..."`），避免误伤代码逻辑
- **唯一性验证**：部署前在原始 bundle 上干运行，确认每条串唯一命中
- **语言包保护**：硬编码脚本只替换代码区字符串，不触碰 `TAe`/`OAe`/`NAe`/`PAe` 语言包对象
- **技术标识符保留**：路径、URL、命令名、品牌名不翻译

---

## 已知限制

1. **应用升级会覆盖 bundle** → 升级后重新运行两个脚本即可
2. **部分诊断字段标签保留英文**（如 `search_capabilities`、`execute_capability`）→ 这些是 MCP 工具 ID，非 UI 文案
3. **Automations 状态词**（Running/Completed/Failed/Active/Paused/Archived）→ 这些值同时出现在语言包键值中，为避免破坏语言包结构，未在硬编码脚本中替换
4. **权限策略描述**（`h6` 策略定义数组中的 `description`/`userNotice`）→ 这些是策略配置数据，可能用于序列化匹配，未翻译

---

## 生成信息

- **生成日期**：2026-08-11（OpenWork 桌面应用 Windows 版）
- **语言包结构**：`TAe`(en) / `OAe`(ja) / `NAe`(zh) / `PAe`(vi) 四语言对象
- **翻译流程**：键级对比（en 1856 vs zh 1869）→ 值英文检测 → 人工翻译 → 唯一性验证 → 干运行测试 → 语法校验
- **校验方式**：`node --check`（ES module 兼容）+ 写后验证 + 失败自动回滚

---

## 许可证

本翻译项目遵循 OpenWork 官方许可证。翻译内容可自由使用、修改、分发。
