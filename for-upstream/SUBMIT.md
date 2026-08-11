# 向 different-ai/openwork 提交简体中文翻译（完整步骤）

## 提交物

| 文件 | 说明 |
|---|---|
| `for-upstream/zh.ts` | 适配官方结构的完整中文包（1871 键，含官方 automationsEnglish 展开约定） |

提交目标文件（覆盖官方现有文件）：
```
apps/app/src/i18n/locales/zh.ts
```

提交价值（已用官方 dev 分支实测对比）：
- 官方 `en.ts` 1863 键 → 我们的文件 **0 缺失**
- 官方 `zh.ts` 现仅 1159 键（**708 个键无翻译**、33 个键值仍是英文）→ 全部补齐
- automations.* 4 键（官方暂时用共享英文副本）→ 显式覆盖为中文
- 术语遵循官方注释约定：OpenCode / OpenPackage / OpenWork 保留英文，MCP 不译为"应用"

---

## 一、准备（约 10 分钟）

### 1. 注册 GitHub 账号（如还没有）
- 打开 https://github.com/signup ，用邮箱注册（免费）。
- 记下用户名（下文中用 `YOUR_USERNAME` 代替）。

### 2. 检查本机 git
```powershell
git --version
```
若提示不存在，去 https://git-scm.com/download/win 下载安装（一路下一步即可）。

### 3. 让 git 记住你的身份（重要，否则 push 会被拒）
在本机任意 PowerShell 执行：
```powershell
git config --global user.name "YOUR_USERNAME"
git config --global user.email "你注册用的邮箱"
```

### 4. 配置 GitHub 登录凭据
二选一：

**方式 A：浏览器登录（推荐，最简单）**
- 之后 push 时如果弹出 GitHub 登录窗口，用浏览器完成登录即可。

**方式 B：Personal Access Token（无弹窗、可脚本化）**
1. 浏览器打开 https://github.com/settings/tokens → Generate new token (classic)
2. 勾选 `repo` 权限 → 生成 → **立即复制** token（只显示一次）
3. 本机 PowerShell 执行（token 会存进 Windows 凭据管理器，只输一次）：
```powershell
git config --global credential.helper manager
```
之后 push 提示输入用户名时填 `YOUR_USERNAME`，密码处粘贴 token。

> 注意：token 等同密码，不要发给任何人、不要写进代码或提交文件。

---

## 二、Fork 官方仓库（约 2 分钟）

1. 浏览器打开 https://github.com/different-ai/openwork
2. 右上角点 **Fork** → 默认选项即可 → Create fork
3. 完成后你会有自己的副本：`https://github.com/YOUR_USERNAME/openwork`

---

## 三、克隆到本机并创建分支

打开 PowerShell，逐条执行（路径随意，建议放 `C:\Users\admin\Desktop\`）：

```powershell
# 1. 克隆你自己的 fork（注意是 YOUR_USERNAME）
git clone https://github.com/YOUR_USERNAME/openwork.git
cd openwork

# 2. 官方主分支是 dev，切到 dev 并保持最新
git checkout dev
git pull

# 3. 创建自己的分支（名字自拟，建议带语义）
git checkout -b feat/zh-locale-full
```

---

## 四、替换中文翻译文件

```powershell
# 把准备好的中文包复制到官方路径（覆盖官方半成品 zh.ts）
Copy-Item "C:\Users\admin\OpenWork Chat\openwork-zh-translations\for-upstream\zh.ts" `
  "apps\app\src\i18n\locales\zh.ts"
```

### 提交前自检（照抄执行，应全部通过）
```powershell
# 1. 确认只改了一个文件（+ zh.ts）
git status

# 2. 看差异规模（+1871 行左右，确认没有误删 import 行）
git diff --stat

# 3. 看文件头：必须保留第一行
#    import { automationsEnglish } from "./automations";
git diff apps/app/src/i18n/locales/zh.ts | Select-Object -First 15
```

---

## 五、提交并推送

```powershell
git add apps/app/src/i18n/locales/zh.ts
git commit -m "feat(i18n): complete Simplified Chinese translation (zh)

- Cover all 1863 en.ts keys (0 missing); official zh.ts only had 1159
- Translate the 708 keys that were missing in official zh.ts
- Fix 33 values that were still English in official zh.ts
- Override automations.* shared English copy with Chinese
- Keep terminology per project convention: OpenCode, OpenPackage,
  OpenWork, MCP stay untranslated"

git push -u origin feat/zh-locale-full
```

> 如果 push 弹出登录，选"用浏览器登录"，或用上面准备的 token。
> 若报 `Permission denied` / `403`，说明用户名或 token 不对，回第一步检查。

---

## 六、发起 Pull Request（约 3 分钟）

1. 浏览器打开 https://github.com/YOUR_USERNAME/openwork
2. 上方会出现黄色提示条：`feat/zh-locale-full had recent pushes` → 点 **Compare & pull request**
3. 确认页面顶部为：
   - `base repository: different-ai/openwork`  `base: dev`
   - `head repository: YOUR_USERNAME/openwork`  `compare: feat/zh-locale-full`
4. 标题与说明（可直接复制）：

**标题**
```
feat(i18n): complete Simplified Chinese translation (zh)
```

**正文**
```
## Summary
Complete the Simplified Chinese (zh) locale. The current official zh.ts
only translates 1159 of 1863 en.ts keys; this PR:

- Adds the missing 708 keys (full coverage of en.ts, verified 0 missing)
- Fixes 33 values that were left as English in the official zh.ts
  (e.g. settings.server_endpoints_*, settings.runtime_config_*)
- Overrides the shared automationsEnglish copy with Chinese
- Keeps project naming convention: OpenCode / OpenPackage / OpenWork /
  MCP stay in English

## Verification
- Compared against official en.ts on `dev`: 1863/1863 keys covered
- Compared against current official zh.ts: 1159/1159 keys kept
- `node --check` passes; `export default { ...automationsEnglish, ... }`
  structure preserved (no changes needed in automations.ts)
- Terminology follows the header convention already present in the file

## Files changed
- apps/app/src/i18n/locales/zh.ts
```

5. 点 **Create pull request**

---

## 七、之后会发生什么

- 维护者（different-ai 团队）会收到 PR 通知，通常几天内 review。
- 如果 CI（lint / tsc）失败，PR 页面会显示红色 ❌，把报错复制给我，我来修。
- 如果维护者要求改动，直接在本地改 → `git add` + `git commit` + `git push`，PR 会自动更新。
- 合并后官方新版本就会带完整简体中文。

---

## 常见问题

**Q：我电脑上不了 github.com / 公司封锁？**
A：用另一台能上网的电脑做第二~六步；文件 `for-upstream/zh.ts` 是纯文本，拷过去即可。

**Q：没有自己的 GitHub 账号，也不想注册？**
A：可以把 `for-upstream/zh.ts` 交给任何有 GitHub 账号的人，让他按二~六步提交。

**Q：`git clone` 很慢或失败？**
A：项目较大，可加参数 `git clone --depth 1`（只要最新一次提交，够用）。

**Q：PR 之后官方会不会和我的版本冲突？**
A：zh.ts 之外的改动不影响本 PR；如果 review 期间官方又改了 zh.ts，我帮你重新生成合并。
