// OpenWork 设置面板硬编码字符串汉化补丁（上下文感知，仅替换 UI 显示串）
// ------------------------------------------------------------------
// 作用：替换设置面板中不走语言包的硬编码英文 UI 串：
//   A. 设置面板首页分组标题（Ewt 组件）：Workspace / Global / Help
//   B. Swt/Cwt 数组的 title/desc（设置 tab 卡片）
//   C. Cd()/D2t() 函数中 3 处硬编码 tab 标题/描述
// 安全：仅替换精确匹配的显示字符串，不动任何代码逻辑/标识符；
//       写盘前 vm 语法校验，失败自动回滚。
// 用法：node apply-settings-hardcoded.mjs [bundle路径]
//       不带参数则自动定位安装目录 bundle
// 注意：运行前请完全退出 OpenWork
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_DIR = process.env.OW_APP_DIR ?? 'C:/Users/admin/AppData/Local/Programs/@openworkdesktop/resources/app-dist/assets';

function findBundle() {
  if (!fs.existsSync(APP_DIR)) throw new Error('未找到 OpenWork 安装目录: ' + APP_DIR);
  const files = fs.readdirSync(APP_DIR).filter((f) => /^app-[A-Za-z0-9_-]+\.js$/.test(f));
  if (files.length !== 1) throw new Error('app bundle 匹配数异常: ' + files.join(', '));
  return path.join(APP_DIR, files[0]);
}

const bundlePath = process.argv[2] ?? findBundle();
let t;
try { t = fs.readFileSync(bundlePath, 'utf8'); }
catch { throw new Error('无法读取 bundle（请先完全退出 OpenWork）: ' + bundlePath); }

// 替换表：from -> to（精确字符串，全部为 UI 显示串）
const replacements = [
  // A. 设置面板首页分组标题
  ['children:"Workspace"', 'children:"工作区"'],
  ['children:"Global"', 'children:"全局"'],
  ['children:"Help"', 'children:"帮助"'],
  // B. Swt 数组（Preferences/Permissions/Advanced）
  ['title:"Preferences",desc:"Default model, reasoning, and compaction."', 'title:"偏好设置",desc:"默认模型、推理与压缩。"'],
  ['title:"Permissions",desc:"Authorized folders and file access."', 'title:"权限",desc:"已授权文件夹与文件访问。"'],
  ['title:"Advanced",desc:"Runtime, engine, and developer options."', 'title:"高级",desc:"运行时、引擎与开发者选项。"'],
  // B. Cwt 数组（AI Providers/Cloud/Appearance/Environment/Updates/Recovery）
  ['title:"AI Providers",desc:"Connect services that provide AI models."', 'title:"AI 提供商",desc:"连接提供 AI 模型的服务。"'],
  ['title:"Cloud",desc:"OpenWork Cloud account and organization."', 'title:"Cloud",desc:"OpenWork Cloud 账户与组织。"'],
  ['title:"Appearance",desc:"Theme, font size, and display."', 'title:"外观",desc:"主题、字体大小与显示。"'],
  ['title:"Environment",desc:"Environment variables and paths."', 'title:"环境变量",desc:"环境变量与路径。"'],
  ['title:"Updates",desc:"App version and update channel."', 'title:"更新",desc:"应用版本与更新渠道。"'],
  ['title:"Recovery",desc:"Reset onboarding and clear data."', 'title:"恢复",desc:"重置引导并清除数据。"'],
  // C. Cd() 函数 tab 标题硬编码
  ['return"AI Providers"', 'return"AI 提供商"'],
  ['return"Preferences"', 'return"偏好设置"'],
  ['return"Permissions"', 'return"权限"'],
  ['return"Settings"', 'return"设置"'],
  // C. D2t() 函数 tab 描述硬编码
  ['return"Connect services that provide AI models"', 'return"连接提供 AI 模型的服务"'],
  ['return"Default model, reasoning, and compaction"', 'return"默认模型、推理与压缩"'],
  ['return"Authorized folders and file access"', 'return"已授权文件夹与文件访问"'],
  ['return"Overview of all settings"', 'return"所有设置总览"'],
  // D. AI 提供商列表界面标题（title:"AI Providers",description:"Models you can use in your workspace."）
  ['title:"AI Providers",description:"Models you can use in your workspace."', 'title:"AI 提供商",description:"你可以在工作区使用的模型。"'],
  // E. Automations 设置界面（列表页）
  ['children:"Automations"', 'children:"自动化任务"'],
  ['children:"Scheduled durably in Den and executed by your connected desktop."', 'children:"由 Den 持久调度并由你已连接的桌面执行。"'],
  ['"New Automation"', '"新建自动化任务"'],
  ['placeholder:"Search Automations"', 'placeholder:"搜索自动化任务"'],
  ['"No matching Automations"', '"没有匹配的自动化任务"'],
  ['"No Automations yet"', '"还没有自动化任务"'],
  ['"Try a different search."', '"尝试其他搜索。"'],
  ['"Create one to run useful work on a schedule, even while your computer is offline."', '"创建一个，即可按计划运行有用的工作，即使电脑离线也能执行。"'],
  ['"Back to Automations"', '"返回自动化任务"'],
  ['children:"Create Automation"', 'children:"创建自动化任务"'],
  ['children:"It becomes active as soon as you create it."', 'children:"创建后立即生效。"'],
  ['children:"Edit Automation"', 'children:"编辑自动化任务"'],
  ['children:"Saving creates an immutable revision for future runs."', 'children:"保存会为后续运行创建不可变修订。"'],
  ['"Create and activate"', '"创建并激活"'],
  ['"Automation created and active"', '"自动化任务已创建并激活"'],
  ['"Automation updated"', '"自动化任务已更新"'],
  ['"Automation activated"', '"自动化任务已激活"'],
  ['"Automation deactivated. A run already in progress will continue."', '"自动化任务已停用。已在进行的运行将继续。"'],
  ['"Automation queued"', '"自动化任务已排队"'],
  ['"Run now"', '"立即运行"'],
  ['"Archive Automation"', '"归档自动化任务"'],
  ['"Archive Automation?"', '"归档此自动化任务？"'],
  ['"Move to Group"', '"移动到分组"'],
  ['"No run selected."', '"未选择运行。"'],
  ['"No runs yet."', '"还没有运行。"'],
  ['"Next run"', '"下次运行"'],
  ['`Last run: ${z.latestRun.status}`', '`上次运行：${z.latestRun.status}`'],
  ['`Next: ${X0(z.automation.nextDueAt)}`', '`下次：${X0(z.automation.nextDueAt)}`'],
  // F. Automations 表单（zY 组件）
  ['htmlFor:"automation-name",children:"Name"', 'htmlFor:"automation-name",children:"名称"'],
  ['htmlFor:"automation-instructions",children:"Instructions"', 'htmlFor:"automation-instructions",children:"说明"'],
  ['htmlFor:"automation-frequency",children:"Schedule"', 'htmlFor:"automation-frequency",children:"计划"'],
  ['htmlFor:"automation-once-at",children:"Run at"', 'htmlFor:"automation-once-at",children:"运行时间"'],
  ['htmlFor:"automation-time",children:"Time"', 'htmlFor:"automation-time",children:"时间"'],
  ['htmlFor:"automation-timezone",children:"Timezone"', 'htmlFor:"automation-timezone",children:"时区"'],
  ['htmlFor:"automation-model",children:"Model"', 'htmlFor:"automation-model",children:"模型"'],
  ['children:"Days"', 'children:"天数"'],
  ['children:"Once"', 'children:"一次"'],
  ['children:"Daily"', 'children:"每天"'],
  ['children:"Weekly"', 'children:"每周"'],
  ['"Current model is no longer available"', '"当前模型不再可用"'],
  ['"Each claimed run starts a fresh task in your desktop OpenCode runtime."', '"每次认领的运行都会在你的桌面 OpenCode 运行时中启动一个新任务。"'],
  ['"Den keeps the schedule and run history. Your signed-in desktop claims each occurrence and executes it with the selected model in its local OpenCode runtime. If the desktop is unavailable before the claim deadline, the occurrence is recorded as missed."', '"Den 负责维护计划与运行历史。你已登录的桌面会认领每次运行，并使用所选模型在其本地 OpenCode 运行时中执行。若在认领截止前桌面不可用，该次运行将被记录为错过。"'],
  ['"Runs use this model and reasoning level in your desktop runtime."', '"运行会在你的桌面运行时中使用此模型与推理级别。"'],
  ['placeholder:"Daily project summary"', 'placeholder:"每日项目摘要"'],
  ['placeholder:"Describe the outcome, sources to check, and what a useful result should include."', 'placeholder:"描述期望结果、要检查的来源，以及有用的结果应包含什么。"'],
  ['children:"Cancel"', 'children:"取消"'],
  // G. Automations 列表页剩余串
  ['children:"Result"', 'children:"结果"'],
  ['"This Cloud thread no longer matches the selected run."', '"此 Cloud 线程不再匹配所选运行。"'],
  ['"Future runs will stop. Durable run history will remain available in Den."', '"未来的运行将停止。持久化的运行历史仍保留在 Den 中。"'],
  ['confirmLabel:"Archive"', 'confirmLabel:"归档"'],
  ['"Automation archived"', '"自动化任务已归档"'],
  ['"Run cancellation requested"', '"已请求取消运行"'],
  // H. AI 提供商界面（连接/列表）
  ['children:"Connect providers"', 'children:"连接提供商"'],
  ['children:"Sign in to services or use providers managed by your organization."', 'children:"登录服务，或使用由你的组织管理的提供商。"'],
  ['placeholder:"Filter providers by name or ID"', 'placeholder:"按名称或 ID 筛选提供商"'],
  ['children:"Choose how you\'d like to connect."', 'children:"选择你希望如何连接。"'],
  ['children:"OpenCode Zen gives you access to the best coding models. Free models keep working without a key."', 'children:"OpenCode Zen 让你使用最好的编码模型。免费模型无需密钥即可继续使用。"'],
  ['children:"Frontier intelligence, hand picked for your team\'s most ambitious work."', 'children:"前沿智能，为团队最具雄心的项目精心挑选。"'],
  ['children:"Not connected"', 'children:"未连接"'],
  ['children:"Search for a provider."', 'children:"搜索提供商。"'],
  ['children:"No providers match your search."', 'children:"没有匹配你搜索的提供商。"'],
  ['children:"Open Connect"', 'children:"打开连接"'],
  ['children:"No AI model connected."', 'children:"未连接任何 AI 模型。"'],
  ['children:"Add a provider to run tasks."', 'children:"添加提供商以运行任务。"'],
  // H2. AI 提供商 OAuth/设备码授权
  ['children:"Finish OAuth by pasting the authorization code."', 'children:"粘贴授权码以完成 OAuth。"'],
  ['children:"Complete sign-in in your browser, then paste the code here."', 'children:"在浏览器中完成登录，然后将代码粘贴到此处。"'],
  ['label:"Authorization code"', 'label:"授权码"'],
  ['placeholder:"Paste code"', 'placeholder:"粘贴代码"'],
  ['children:"Open browser again"', 'children:"重新打开浏览器"'],
  ['children:"Waiting for browser confirmation."', 'children:"正在等待浏览器确认。"'],
  ['children:"You\'ll need to sign in to your OpenAI account and provide the code below."', 'children:"你需要登录你的 OpenAI 账户并提供下面的代码。"'],
  ['children:"The first time you do this you\'ll need to enable Device auth in your account settings."', 'children:"首次操作时，你需要在账户设置中启用设备授权。"'],
  ['children:"ChatGPT > Account Settings > Security > Enable device code authorization"', 'children:"ChatGPT > 账户设置 > 安全 > 启用设备代码授权"'],
  ['children:"Sign in in the browser tab we just opened. We will complete the connection automatically."', 'children:"在我们刚打开的浏览器标签页中登录。我们将自动完成连接。"'],
  ['children:"Confirmation code"', 'children:"确认码"'],
  ['children:"Authorization checks will start after you click Open Browser."', 'children:"点击打开浏览器后，授权检查将开始。"'],
  ['children:"This window will close once the provider is connected."', 'children:"提供商连接后，此窗口将关闭。"'],
  ['children:"Using OpenWork Den Remote Workers? Click here"', 'children:"正在使用 OpenWork Den 远程工作器？点击此处"'],
  ['children:"OpenWork Den remote workers"', 'children:"OpenWork Den 远程工作器"'],
  ['children:"To get back online, you have two options:"', 'children:"要恢复在线，你有两个选项："'],
  ['children:"Email support"', 'children:"邮件支持"'],
  // I. 权限界面（Add folder 按钮）
  ['[a.jsx(Qa,{className:"size-4"}),"Add folder"]', '[a.jsx(Qa,{className:"size-4"}),"添加文件夹"]'],
  // J. 更新界面
  ['children:"Update now"', 'children:"立即更新"'],
  ['children:"Takes about 30 seconds. Your files and sessions come along."', 'children:"大约需要 30 秒。你的文件和会话会一并保留。"'],
  ['children:"Current version"', 'children:"当前版本"'],
  ['children:"Release channel"', 'children:"发布渠道"'],
  ['children:"Stable gets fully tested releases. Alpha includes the very latest changes but may be less polished (macOS only)."', 'children:"稳定版提供经过全面测试的版本。Alpha 包含最新更改，但可能不够完善（仅 macOS）。"'],
  ['label:"Stable"', 'label:"稳定版"'],
  ['label:"Alpha"', 'label:"Alpha"'],
  ['children:"Technical details"', 'children:"技术详情"'],
  // K. 外观界面
  ['children:"Display menu bar"', 'children:"显示菜单栏"'],
  ['children:"Show the native desktop menu bar."', 'children:"显示原生桌面菜单栏。"'],
  // L. 环境变量界面
  ['children:"Environment variables can only be edited from a local desktop workspace."', 'children:"环境变量只能从本地桌面工作区编辑。"'],
  ['children:"Continue setup"', 'children:"继续设置"'],
  ['title:"Requested environment variable"', 'title:"请求的环境变量"'],
  // M. Cloud 账户/组织连接界面
  ['children:"Your organization"', 'children:"你的组织"'],
  ['children:"Choose your organization"', 'children:"选择你的组织"'],
  ['children:"Select the organization whose cloud resources should be connected to this workspace."', 'children:"选择其云资源应连接到当前工作区的组织。"'],
  ['children:"Loading organizations..."', 'children:"正在加载组织..."'],
  ['placeholder:"Search organizations..."', 'placeholder:"搜索组织..."'],
  ['children:"No organizations match your search."', 'children:"没有匹配你搜索的组织。"'],
  ['children:"Loading available resources..."', 'children:"正在加载可用资源..."'],
  ['children:"You have access to the following resources."', 'children:"你可以访问以下资源。"'],
  ['children:"No resources have been configured for this organization yet."', 'children:"该组织尚未配置任何资源。"'],
  ['children:"Add AI providers or marketplaces from the OpenWork Cloud dashboard."', 'children:"从 OpenWork Cloud 控制台添加 AI 提供商或应用市场。"'],
  ['children:"Providers are added to your workspace automatically. Marketplaces are available from Cloud settings."', 'children:"提供商会自动添加到你的工作区。应用市场可从 Cloud 设置中获取。"'],
  ['children:"Preparing workspace identity"', 'children:"正在准备工作区身份"'],
  ['children:"Preparing workspace..."', 'children:"正在准备工作区..."'],
  ['children:"Workspace identity is ready"', 'children:"工作区身份已就绪"'],
  ['children:"Why restart?"', 'children:"为什么需要重启？"'],
  ['children:"Continue without restarting"', 'children:"不重启继续"'],
  ['children:"Show more"', 'children:"显示更多"'],
  ['title:"Marketplaces"', 'title:"应用市场"'],
  ['description:"App stores with extensions and plugins for your workspace."', 'description:"包含扩展与插件的工作区应用商店。"'],
  ['children:"Select an organization"', 'children:"选择一个组织"'],
  ['children:"Choose the organization to use with this workspace. Sign out to switch later."', 'children:"选择要与当前工作区一起使用的组织。之后可退出登录以切换。"'],
  // N. 高级诊断界面（Agent 访问诊断）
  ['children:"Agent access diagnostics"', 'children:"Agent 访问诊断"'],
  ['children:"Technical details for OpenWork Cloud MCP delivery. Tokens and Authorization headers are redacted before display or copy."', 'children:"OpenWork Cloud MCP 交付的技术详情。令牌与授权头在显示或复制前会被脱敏。"'],
  ['children:"OpenWork Cloud MCP health"', 'children:"OpenWork Cloud MCP 健康状态"'],
  ['children:"Use this when support needs exact runtime state. The main Connect card stays user-facing."', 'children:"当支持人员需要确切的运行时状态时使用。主连接卡片保持面向用户。"'],
  ['children:"Show sanitized health JSON"', 'children:"显示脱敏健康 JSON"'],
  ['children:"No Cloud MCP health has been loaded for this workspace yet."', 'children:"尚未为当前工作区加载 Cloud MCP 健康状态。"'],
  ['children:"Copy sanitized diagnostic"', 'children:"复制脱敏诊断"'],
  ['children:"Run Test now to load diagnostics for this workspace."', 'children:"立即运行测试以加载当前工作区的诊断。"'],
  ['children:"Direct probe steps"', 'children:"直接探测步骤"'],
  ['children:"Last engine refresh"', 'children:"上次引擎刷新"'],
  ['children:"Cloud tools verified for this workspace"', 'children:"已为当前工作区验证云工具"'],
  ['children:"Agent access ready"', 'children:"Agent 访问已就绪"'],
  ['children:"This workspace can search and run your organization\'s shared capabilities."', 'children:"当前工作区可以搜索并运行你组织的共享能力。"'],
  ['children:"Agent access to connected services"', 'children:"对已连接服务的 Agent 访问"'],
  ['children:"Lets agents use the exact OpenWork Cloud tools for this active workspace and organization."', 'children:"让 Agent 为当前活动工作区与组织使用确切的 OpenWork Cloud 工具。"'],
  ['children:"First issue"', 'children:"首个问题"'],
  ['children:"Recommended action"', 'children:"建议操作"'],
  // N2. 高级诊断界面（OpenCode 配置来源）
  ['children:"Default agent"', 'children:"默认 Agent"'],
  ['children:"Providers / models"', 'children:"提供商 / 模型"'],
  ['children:"Agents / plugins"', 'children:"Agent / 插件"'],
  ['children:"MCP / permissions"', 'children:"MCP / 权限"'],
  ['children:"Disabled providers"', 'children:"已禁用的提供商"'],
  ['children:"Show raw JSON"', 'children:"显示原始 JSON"'],
  ['children:"OpenCode config sources"', 'children:"OpenCode 配置来源"'],
  ['children:"Move OpenWork-managed config"', 'children:"移动 OpenWork 管理的配置"'],
  ['children:"Desired OpenWork runtime config"', 'children:"期望的 OpenWork 运行时配置"'],
  ['children:"Show desired JSON"', 'children:"显示期望 JSON"'],
  ['children:"OpenCode source breakdown"', 'children:"OpenCode 来源明细"'],
  ['children:"Runtime database"', 'children:"运行时数据库"'],
  ['children:"Legacy OpenWork metadata"', 'children:"旧版 OpenWork 元数据"'],
  ['children:"User opencode.jsonc"', 'children:"用户 opencode.jsonc"'],
  ['children:"Runtime DB JSON"', 'children:"运行时数据库 JSON"'],
  ['title:"Project opencode config"', 'title:"项目 opencode 配置"'],
  ['title:"Global opencode config"', 'title:"全局 opencode 配置"'],
  ['title:"OpenWork runtime DB"', 'title:"OpenWork 运行时数据库"'],
  ['title:"OpenWork injected config"', 'title:"OpenWork 注入的配置"'],
  ['placeholder:"openwork://..."', 'placeholder:"openwork://..."'],
  ['description:"Workspace-level OpenCode config owned by the user/project."', 'description:"由用户/项目拥有的工作区级 OpenCode 配置。"'],
  ['description:"User-level OpenCode config under ~/.config/opencode."', 'description:"位于 ~/.config/opencode 下的用户级 OpenCode 配置。"'],
  ['description:"OpenWork-managed runtime values stored outside workspace files."', 'description:"存储在工作区文件之外的 OpenWork 管理运行时值。"'],
  ['description:"The object OpenWork injects into OpenCode at runtime."', 'description:"OpenWork 在运行时注入到 OpenCode 的对象。"'],
  // O. 插件界面
  ['children:"OpenCode Plugins"', 'children:"OpenCode 插件"'],
  ['children:"Install a plugin from GitHub"', 'children:"从 GitHub 安装插件"'],
  ['children:"Works with Claude Code plugins: a repo with .claude-plugin/plugin.json bundling an MCP server, skills, and commands."', 'children:"兼容 Claude Code 插件：一个包含 .claude-plugin/plugin.json 的仓库，打包了 MCP 服务器、技能与命令。"'],
  ['label:"GitHub repository"', 'label:"GitHub 仓库"'],
  ['placeholder:"https://github.com/slackapi/slack-mcp-plugin"', 'placeholder:"https://github.com/slackapi/slack-mcp-plugin"'],
  ['children:"Will install"', 'children:"将安装"'],
  ['children:"Partially set up"', 'children:"部分设置"'],
  ['children:"Hidden"', 'children:"已隐藏"'],
  ['children:"Disabled"', 'children:"已禁用"'],
  ['children:"Setup"', 'children:"设置"'],
  ['children:"Shared by your organization"', 'children:"由你的组织共享"'],
  ['children:"This library item is not available in the current workspace."', 'children:"此库项目在当前工作区不可用。"'],
  ['children:"Built-in OpenWork extensions are disabled by your organization. Use Show hidden to review blocked built-ins."', 'children:"内置的 OpenWork 扩展已被你的组织禁用。使用“显示隐藏”查看被阻止的内置项。"'],
  ['placeholder:"Search library..."', 'placeholder:"搜索库..."'],
  ['children:"No library items found"', 'children:"未找到库项目"'],
  ['children:"Preview"', 'children:"预览"'],
  ['children:"Beta"', 'children:"Beta"'],
  ['children:"Release stage"', 'children:"发布阶段"'],
  ['placeholder:"opencode-wakatime"', 'placeholder:"opencode-wakatime"'],
  ['label:"Refresh marketplace extensions"', 'label:"刷新应用市场扩展"'],
  ['description:"Force a fresh sync of organization marketplace plugins from the cloud."', 'description:"强制从云端重新同步组织应用市场的插件。"'],
  // P. 恢复/迁移界面
  ['children:"Electron alpha migration"', 'children:"Electron Alpha 迁移"'],
  ['children:"Debug-only Tauri controls. Preparing migration data is non-destructive; installing requires a URL and two confirmations."', 'children:"仅调试用的 Tauri 控件。准备迁移数据是非破坏性的；安装需要 URL 和两次确认。"'],
  ['children:"Prepare migration data"', 'children:"准备迁移数据"'],
  ['children:"OpenWork.app.migrate-bak"', 'children:"OpenWork.app.migrate-bak"'],
  ['children:"Uses latest-mac.yml from the rolling alpha release."', 'children:"使用滚动 Alpha 版本中的 latest-mac.yml。"'],
  ['children:"Advanced manual artifact override"', 'children:"高级手动构件覆盖"'],
  ['children:"Electron artifact URL"', 'children:"Electron 构件 URL"'],
  ['title:"Requires a trusted artifact URL. macOS keeps OpenWork.app.migrate-bak for rollback."', 'title:"需要可信的构件 URL。macOS 会保留 OpenWork.app.migrate-bak 用于回滚。"'],
  ['placeholder:"Paste a trusted Electron .zip/.exe/AppImage URL"', 'placeholder:"粘贴可信的 Electron .zip/.exe/AppImage URL"'],
  ['placeholder:"recommended"', 'placeholder:"推荐"'],
  ['children:"sha512 from latest-mac.yml"', 'children:"来自 latest-mac.yml 的 sha512"'],
  ['children:"sha256 override (legacy optional)"', 'children:"sha256 覆盖（旧版可选）"'],
  ['placeholder:"Only needed when the artifact provider gives sha256 instead of latest-mac.yml sha512"', 'placeholder:"仅当构件提供方给出 sha256 而非 latest-mac.yml 的 sha512 时才需要"'],
  ['children:"Open backup in Finder"', 'children:"在 Finder 中打开备份"'],
  ['children:"Electron alpha channel"', 'children:"Electron Alpha 渠道"'],
  ['children:"Use alpha feed"', 'children:"使用 Alpha 源"'],
  ['children:"Return to stable"', 'children:"返回稳定版"'],
  ['children:"alpha-macos-latest/latest-mac.yml"', 'children:"alpha-macos-latest/latest-mac.yml"'],
  ['children:"releases/latest/download/latest-mac.yml"', 'children:"releases/latest/download/latest-mac.yml"'],
  ['children:"AppImage desktop integration"', 'children:"AppImage 桌面集成"'],
  ['children:"Control the launcher, icon, and openwork:// callback for this AppImage."', 'children:"控制此 AppImage 的启动器、图标与 openwork:// 回调。"'],
  ['children:"Integrate"', 'children:"集成"'],
  ['children:"Repair"', 'children:"修复"'],
  ['children:"Remove"', 'children:"移除"'],
  ['children:"Use manager launcher"', 'children:"使用管理器启动器"'],
  ['children:"Recheck"', 'children:"重新检查"'],
  // Q. 扩展界面（详情列头）
  ['children:"Extension manifest"', 'children:"扩展清单"'],
  ['children:"Resources"', 'children:"资源"'],
  ['children:"Contributions"', 'children:"贡献"'],
  ['children:"Details"', 'children:"详情"'],
  ['children:"Type"', 'children:"类型"'],
  ['children:"Endpoint"', 'children:"端点"'],
  ['children:"Launch"', 'children:"启动"'],
  ['children:"Location"', 'children:"位置"'],
  ['children:"Authentication"', 'children:"身份验证"'],
  ['children:"OAuth required"', 'children:"需要 OAuth"'],
  ['children:"Status"', 'children:"状态"'],
  ['children:"Visibility"', 'children:"可见性"'],
  ['children:"Availability"', 'children:"可用性"'],
  ['children:"Trigger"', 'children:"触发"'],
  ['children:"Skill content"', 'children:"技能内容"'],
  ['children:"What this enables"', 'children:"此功能的作用"'],
  ['children:"Show"', 'children:"显示"'],
  ['title:"Extension update available"', 'title:"扩展更新可用"'],
  ['title:"Extension removed by admin"', 'title:"扩展已被管理员移除"'],
  ['title:"New extension available"', 'title:"新扩展可用"'],
  // Q2. Computer Use 设置
  ['children:"Computer Use setup (Mac only)"', 'children:"Computer Use 设置（仅 Mac）"'],
  ['children:"Computer Use only works on Mac. Connect the local MCP server and grant the macOS permissions it needs to control apps."', 'children:"Computer Use 仅适用于 Mac。连接本地 MCP 服务器，并授予其控制应用所需的 macOS 权限。"'],
  ['title:"1. Connect Computer Use MCP"', 'title:"1. 连接 Computer Use MCP"'],
  ['title:"2. Grant macOS permissions"', 'title:"2. 授予 macOS 权限"'],
  ['label:"Computer Use MCP"', 'label:"Computer Use MCP"'],
  ['label:"macOS accessibility runtime"', 'label:"macOS 辅助功能运行时"'],
  ['label:"Accessibility and Screen Recording"', 'label:"辅助功能与屏幕录制"'],
  ['label:"Verify Computer Use MCP"', 'label:"验证 Computer Use MCP"'],
  ['label:"MCP server connected"', 'label:"MCP 服务器已连接"'],
  ['label:"Accessibility permission"', 'label:"辅助功能权限"'],
  ['label:"Screen Recording permission"', 'label:"屏幕录制权限"'],
  ['label:"Accessibility"', 'label:"辅助功能"'],
  ['label:"Screen Recording"', 'label:"屏幕录制"'],
  ['description:"Adds the local Computer Use server to this workspace so Composer can use the computer-control tools."', 'description:"将本地 Computer Use 服务器添加到当前工作区，以便 Composer 使用计算机控制工具。"'],
  ['description:"Opens the OpenWork Computer Use helper. Grant both permissions there, then click Verify below."', 'description:"打开 OpenWork Computer Use 助手。在其中授予两项权限，然后点击下方的“验证”。"'],
  // Q3. 语音模式设置
  ['children:"Realtime voice"', 'children:"实时语音"'],
  ['children:"Ready by default"', 'children:"默认就绪"'],
  ['children:"Voice Mode uses OpenAI Realtime and the same OpenWork UI control surface exposed through OpenWork UI MCP."', 'children:"语音模式使用 OpenAI Realtime，以及通过 OpenWork UI MCP 暴露的同一 OpenWork UI 控制面。"'],
  ['children:"OpenAI key detected"', 'children:"已检测到 OpenAI 密钥"'],
  ['children:"Voice Mode will use OPENAI_REALTIME_API_KEY when present, otherwise OPENAI_API_KEY from OpenWork environment variables."', 'children:"语音模式在存在 OPENAI_REALTIME_API_KEY 时使用它，否则使用 OpenWork 环境变量中的 OPENAI_API_KEY。"'],
  ['children:"OpenAI API key"', 'children:"OpenAI API 密钥"'],
  ['placeholder:"sk-..."', 'placeholder:"sk-..."'],
  ['children:"Saved as OPENAI_API_KEY in OpenWork\'s local env store. The renderer only receives short-lived Realtime client secrets."', 'children:"以 OPENAI_API_KEY 保存在 OpenWork 的本地环境存储中。渲染进程只接收短期有效的 Realtime 客户端密钥。"'],
  ['children:"Test Realtime"', 'children:"测试 Realtime"'],
  ['label:"Realtime client-secret minting"', 'label:"Realtime 客户端密钥签发"'],
  // R. MCP 界面（说明文字，技术标识符/路径不译）
  ['children:"How to connect another client"', 'children:"如何连接其他客户端"'],
  ['children:"OpenWork desktop starts a private localhost bridge automatically."', 'children:"OpenWork 桌面端会自动启动一个私有的 localhost 桥接。"'],
  ['children:"Do not point clients at the random localhost bridge URL directly."', 'children:"不要将客户端直接指向随机的 localhost 桥接 URL。"'],
  ['children:"Claude Desktop, Codex, Cursor"', 'children:"Claude Desktop、Codex、Cursor"'],
  ['children:"Discovery"', 'children:"发现"'],
  ['children:"Production discovery file"', 'children:"生产发现文件"'],
  ['children:"Dev discovery file"', 'children:"开发发现文件"'],
  ['children:"Override"', 'children:"覆盖"'],
  ['children:"Current override"', 'children:"当前覆盖"'],
  ['children:"Add MCPs and integrations"', 'children:"添加 MCP 与集成"'],
  ['children:"Connect an extension"', 'children:"连接扩展"'],
  // S. 设置导航/命令目录
  ['label:"Open sessions"', 'label:"打开会话"'],
  ['label:"Open general settings"', 'label:"打开常规设置"'],
  ['label:"Open extensions"', 'label:"打开扩展"'],
  ['label:"Open provider settings"', 'label:"打开提供商设置"'],
  ['label:"Open authorized folder settings"', 'label:"打开已授权文件夹设置"'],
  ['label:"Open appearance settings"', 'label:"打开外观设置"'],
  ['label:"Open a settings panel"', 'label:"打开设置面板"'],
  ['label:"Go back"', 'label:"后退"'],
  ['label:"Go forward"', 'label:"前进"'],
  ['label:"Open settings from the account menu"', 'label:"从账户菜单打开设置"'],
  ['label:"Open OpenWork docs"', 'label:"打开 OpenWork 文档"'],
  ['label:"Send feedback"', 'label:"发送反馈"'],
  ['label:"New tab"', 'label:"新建标签页"'],
  ['label:"Library"', 'label:"库"'],
  ['label:"AI model providers"', 'label:"AI 模型提供商"'],
  ['label:"Voice mode"', 'label:"语音模式"'],
  ['label:"File management"', 'label:"文件管理"'],
  ['label:"Write and run code"', 'label:"编写并运行代码"'],
  ['label:"Computer use"', 'label:"计算机使用"'],
  ['label:"Skills"', 'label:"技能"'],
  ['label:"Share sessions"', 'label:"共享会话"'],
];

let newT = t;
const applied = [];
const missing = [];
for (const [from, to] of replacements) {
  const count = newT.split(from).length - 1;
  if (count === 0) {
    missing.push(from);
    continue;
  }
  newT = newT.split(from).join(to);
  applied.push(from + '  ->  ' + to + '  (x' + count + ')');
}

if (applied.length === 0) {
  console.log('无需修改（所有目标串均未找到）。');
  process.exit(0);
}

// 写盘前语法校验（用 node --check 校验整个 bundle，能解析 ES module）
function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

// 先写临时文件做语法校验，通过后再写真实文件
const tmpCheck = bundlePath + '.tmpcheck.js';
fs.writeFileSync(tmpCheck, newT, 'utf8');
if (!syntaxCheck(tmpCheck)) {
  fs.rmSync(tmpCheck, { force: true });
  console.error('语法验证失败，未写入任何文件！');
  process.exit(1);
}
fs.rmSync(tmpCheck, { force: true });

// 备份 + 写盘
const bak = bundlePath + '.settings.bak';
if (!fs.existsSync(bak)) fs.copyFileSync(bundlePath, bak);
fs.writeFileSync(bundlePath, newT, 'utf8');

// 写后校验
if (!syntaxCheck(bundlePath)) {
  console.error('写后验证失败！尝试从备份恢复…');
  fs.copyFileSync(bak, bundlePath);
  console.error('已恢复备份: ' + bak);
  process.exit(1);
}
console.log('写后验证通过：bundle 语法合法。');

console.log('已打补丁: ' + bundlePath);
console.log('替换 ' + applied.length + ' 处：');
for (const a of applied) console.log('  ' + a);
if (missing.length) {
  console.log('未找到（跳过）' + missing.length + ' 处：');
  for (const m of missing) console.log('  ' + m);
}
console.log('备份: ' + bak);
console.log('请完全退出并重新打开 OpenWork 以生效。');