# OpenWork 桌面应用 · 简体中文翻译

OpenWork 桌面应用（Windows）的简体中文本地化翻译。官方 `zh` 语言包覆盖率约 **63%**（官方 1179 键 vs 英文 1856 键），界面仍有大量缺失键与硬编码英文字符串。本仓库在官方语言包基础上补齐缺失键、修复值为英文的键，并翻译了 UI 中硬编码的英文字符串。

> 目标：让 OpenWork 中文界面接近完整、一致，可提交回官方翻译仓库，也可直接注入本地安装包使用。

## 翻译规模

| 类别 | 数量 | 说明 |
|---|---|---|
| 官方 zh 语言包 | 1179 键 | 官方已有（其中约 50 键值为英文，33 键已在本仓库修复） |
| 新增缺失键 | 712 键 | `zh-new-keys.ts`，官方 zh 缺失、界面回退英文的键 |
| 修复键 | 47 键 | `zh-fixes.ts`：10 个缺失键 + 4 个共享基础键 + 33 个值仍为英文的键 |
| **合并后完整语言包** | **1871 键** | `zh.ts`，可直接作为官方 zh.ts 的提交内容 |
| 硬编码字符串翻译 | 872 条 | `hardcoded-strings.json`，UI 中写死的英文字符串（引擎状态、设置面板、Automations、命令面板、Cloud MCP 健康卡等） |

术语约定：`connect.*` 译为「连接」；`OpenWork`、`OpenCode`、`MCP`、`OpenWork Cloud`、`Den`、`Computer Use`、`Automations` 等品牌/专有名词保留英文。占位符（`{count}`、`{path}` 等）与 HTML 标签全部原样保留。

## 目录结构

```
openwork-zh-translations/
├── README.md
├── docs/
│   └── TERMINOLOGY.md             # 术语对照表（保留英文项 / 固定译法 / 不可译元素）
├── translations/                  # 翻译交付物（可直接提交/审阅）
│   ├── zh.ts                      # ★ 完整合并语言包（官方 + 新增 + 修复），官方格式
│   ├── zh-new-keys.ts             # 712 条新增键翻译
│   ├── zh-fixes.ts                # 47 条修复（缺失 + 共享键 + 英文值覆盖）
│   ├── hardcoded-strings.json     # 872 条硬编码字符串翻译（from → to）
│   ├── hardcoded-strings-notapplied.json  # 71 条未应用（调试记录，可忽略）
│   ├── zh-untranslated-report.json # 合并后仍有英文值、有意保留的 27 键
│   └── zh-missing-vs-en.json      # 官方 zh 缺失键清单（对照用）
└── scripts/
    ├── apply-patch.mjs            # 一键补丁脚本（注入本地安装包）
    ├── verify-batch.mjs           # 字典区命中检查（防误改语言包词典）
    ├── zh-missing-translations.ts # 脚本依赖（与 translations/ 内容一致）
    └── zh-fix-translations.ts     # 脚本依赖
```

> 说明：此前分批翻译的硬编码字符串（batch1-18）已全部并入 `hardcoded-strings.json`
> （872 条，含批量表全部条目且值一致），不单独保留逐批文件，避免重复。

## 使用方法

### 方式一：注入本地安装包（推荐体验）

```powershell
# 1. 完全退出 OpenWork
# 2. 运行补丁脚本
node scripts/apply-patch.mjs
# 3. 重新打开 OpenWork，中文翻译生效
```

- 脚本会自动定位安装目录的 `resources/app-dist/assets/app-*.js`，备份为 `.bak` 后插入翻译；含语法自校验，失败自动回滚。
- 应用升级会覆盖 bundle，升级后重新运行一次即可（脚本幂等：已打补丁时进入增量修复模式）。
- 可通过环境变量 `OW_APP_DIR` 覆盖安装目录。

### 增量补键（高级设置等 22 键）

`apply-patch.mjs` 已覆盖全部语言包键；如需单独验证某批翻译是否误命中语言包词典区：

```powershell
node scripts/verify-batch.mjs <bundle 副本> <翻译表.mjs>
```

输出 `dict zone hits` 应为 0（翻译表只应命中代码区硬编码文案，不得触碰词典内部）。

### 方式二：提交官方翻译仓库

将 `translations/zh.ts` 作为官方 `zh.ts` 的替换内容提交；`zh-new-keys.ts` / `zh-fixes.ts` 提供逐条审阅。

## 翻译内容覆盖范围

- **语言包键**（`app.*`、`settings.*`、`connect.*`、`mcp.*`、`session*`、`composer.*`、`welcome.*`、`memory.*`、`den.*`、`workspace_list.*`、`notifications.*` 等）——缺失键补齐 + 英文值修复。
- **硬编码字符串**：设置面板（Provider/model、引擎状态、端点、组织策略）、Automations 面板、命令面板条目、Cloud MCP 健康卡诊断模板、欢迎页、会话分组、模型选择、Ollama、Computer Use 设置步骤等纯展示文本。

## 生成说明

- 完整语言包 `zh.ts` 从已补丁 bundle 的 `zh` 语言对象提取合并生成（2026-08-07，应用版本见 `app-hsgPuBXp.js`）。
- 硬编码翻译表由对 UI 渲染字符串的审计生成，仅保留在当前 bundle 中确认生效的条目。
- 翻译由人工核对 + 自动审计（唯一性、字典区排除、语法校验）协作完成。
