# Micx Work 管理员初始化指南（Owner Initialization & Break-glass Guide）

> 适用对象：Micx Work **单组织（single-org）自托管**部署的第一位 owner（组织所有者）
> 与 IT / 安全管理员。本文档覆盖：部署完成后的**首次 owner 初始化**、SSO/SCIM 管理、
> 桌面端与安装链接推送、以及**兜底恢复（break-glass / recovery）**。
>
> 本文档是《自托管安装指南》（[`self-hosted-install-guide.md`](./self-hosted-install-guide.md)）
> 的下游操作手册：安装指南讲「怎么把栈跑起来」，本文档讲「跑起来之后第一位 owner
> 怎么把组织投入使用，以及出事之后怎么恢复」。

本文档表述基于仓库当前已实现的代码与配置（权威源详见文末「引用源文件」）。
凡是「尚未实现」的能力，一律以 `[planned: A#]` 显式标注，**不要**当作已存在。

---

## 1. 角色（Roles）

单组织部署仍使用 organization / member / role 对象，只是一套部署对外表现为一个组织。
角色常量见 `ee/apps/den-api/src/organization-role-hierarchy.ts`：

| 角色 | 值 | 说明 |
|---|---|---|
| **owner（所有者）** | `owner` | 唯一受保护的**组织 owner**。可管理所有权、SSO/SCIM、成员上下限与降级。owner 无法从组织中被移除（移除被 `owner_role_locked` 拒绝）。 |
| **super-admin（超级管理员）** | `super-admin` | 拥有 owner 之外的全部权限。**所有权转移的接收方必须是活跃 super-admin**。 |
| **admin（管理员）** | `admin` | 常规管理操作。 |
| **member（成员）** | `member` | 只能使用。单组织模式下，owner 之后的其余用户一律落入此角色。 |

### 关于受保护的 owner

- 单组织部署始终有**且仅有一个组织**；owner 用于护栏关键配置（SSO/SCIM、所有权转移、
  组织不可移除）。owner 一旦存在，之后的用户按 `member` 加入。
- 权限级别：owner 拥有 super-admin 的全部能力，另有专属的所有权与安全配置能力。
- 单组织内部仍使用组织级 RBAC——这里描述的 scope 位于**组织层**，不涉及租户级
  platform admin（见 §6 的 `bootstrapAdminEmails`）。

---

## 2. 首次运行与 Owner 认领（First-run owner bootstrap）

> 前置：你的部署已是 `single_org` 模式（Helm `config.tenancy.mode: single_org`，空 /
  未设置时即按 `single_org`）。安装细节见
> [`self-hosted-install-guide.md`](./self-hosted-install-guide.md) §2.1 / §3.1。

### 2.1 单例组织如何自动创建

当 Den API 首次看到「第一个落地用户签名」时，若单例组织尚不存在，会依据
`DEN_SINGLE_ORG_NAME` / `DEN_SINGLE_ORG_SLUG` **幂等**创建该组织，并把**第一个符合条件的用户**
置为组织 owner（`ee/apps/den-api/src/orgs.ts → ensureSingletonOrganizationForUser`）。
创建是幂等的：并发首个请求用固定 slug + 重复键重查，保证不会创建出两个组织。

### 2.2 谁能认领 owner（ownerEmails 门控）

| 配置（环境变量 / Helm 值） | 行为 |
|---|---|
| `DEN_SINGLE_ORG_OWNER_EMAILS` / `config.tenancy.ownerEmails` 为空 | 第一个到达的用户可认领 owner。**生产不推荐**（存在任意抢先认领风险）。 |
| 配置了逗号分隔邮箱列表 | **仅**列表内邮箱可认领 owner；其余用户在创建「第一个组织」这一步被拒（`isSingleOrgOwnerEmailEligible`）。 |

认领规则（`ee/apps/den-api/src/single-org-policy.ts`）：

- 单例组织存在且 `activeOwnerCount > 0` → 所有人按 `member` 加入，**不再授予 owner**。
- 单例组织存在但 `activeOwnerCount === 0`（例如 owner 被转移降级后、或从未有 owner）
  → 命中 owner 门控邮箱的用户重新成为 owner（这是 §6 兜底恢复的基础）。
- owner 门控适用 `single_org_policy`，与 `config.public.bootstrapAdminEmails` 是**两回事**：
  bootstrap admin 只种出平台级 admin，**不会**因此成为组织 owner。

**推荐 Helm 值（第一位 owner 即此）**：

```yaml
config:
  tenancy:
    mode: single_org
    singleOrgName: "Acme"
    singleOrgSlug: "acme"
    ownerEmails: "admin@acme.com"        # 谁能认领组织 owner（可多个，逗号分隔）
    requireEmailVerification: "false"   # 单组织默认关闭验证码邮箱验证
  public:
    bootstrapAdminEmails: "admin@acme.com"   # 可选：平台级 admin 白名单（见 §6）
```

> 生产务必**显式**配置 `ownerEmails`。留空时第一个到达用户即 owner，属高风险默认。

### 2.3 第一位 owner 的 setup 检查清单

第一个 owner 登录后落到一个 **setup 状态页**，逐项确认组织是否可投入使用：

1. **确认组织名**（org name）— 沿用 `singleOrgName`，确认显示名正确。
2. **配置 SAML / OIDC SSO** — 见 §3。
3. **配置允许的域名与 SSO 要求**（configured domains 与 `requireSso`）— 见 §3.3。
4. **（可选）配置 SCIM** 用户预置 — 见 §3.4。
5. **邀请 / 预置用户** — 见 §5。
6. **安装桌面端 / 连接 worker** — 见 §4 与 §7（worker 自托管连接见 §7）。

> 一旦组织配置了 SSO，根签名/注册体验变为「仅 Continue with SSO」：raw
> email/password 的登录/注册会被 Den API 拒绝（`single_org_sso_required`），
> `ee/apps/den-api/src/routes/auth/index.ts`。

---

## 3. SSO（SAML/OIDC）+ SCIM 管理员配置

> 前置条件：组织已有 owner；若启用了企业套餐门禁（`DEN_PLAN_GATING_ENABLED`），
> 组织需具备 **Enterprise entitlement**，否则保存 SSO 设置被以 HTTP 402 拒绝
> （`SSO / SAML requires an Enterprise plan`）。默认自托管**不**开这门禁，见
> [`enterprise-plan-gating.md`](../enterprise-plan-gating.md)。

### 3.1 管理面路由

Den 用 Better Auth 承载 SSO/SCIM 底层协议，再包一层组织级路由与策略
（`ee/apps/den-api/src/auth.ts`、`routes/org/sso.ts`）：

| 面 | 表面 | 运行时 |
|---|---|---|
| SSO 管理 | `/dashboard/sso`，API `/v1/sso`、`/v1/sso/saml`、`/v1/sso/oidc` | 每组织一个 SSO 连接；owner/security admin 可创建/替换 |
| SAML 回调 | `/api/auth/sso/saml2/sp/acs/micx-sso-<org-id>` | Better Auth 消费响应 |
| SAML 元数据 | `/api/auth/sso/saml2/sp/metadata?providerId=micx-sso-<org-id>` | 存连接后生成 |
| SSO 登录 | `/sso/<org-slug>` | SP-initiated SSO |
| SCIM 管理 | `/dashboard/scim`，`/v1/scim`、`/v1/scim/token` | owner 创建/轮换组织级 SCIM token |
| SCIM 预置 | `/api/auth/scim/v2` | 增删改、取消预置 |

Micx 强制这些 SAML 安全默认：

- 要求已签名 SAML 断言；
- IdP-initiated 仅接受该 org 的 ACS URL；
- 要求 SAML 时间戳；拒绝已弃用 SAML 算法；
- SSO 登录写入外部身份链接 + JIT 组织 membership；
- 被组织 SSO/SCIM 管理的用户，邮箱/密码登录被拒（`single_org_sso_required`）。

> 目前**不支持** SCIM Group object 预置（可用 Entra 应用分配用户/组限定范围，
> 但关闭 group 映射）`[planned: A-里程碑]`。

### 3.2 Microsoft Entra 单点登录配置（在 Den Web → Dashboard → SSO → SAML）

完整手把手流程见 [`microsoft-entra-sso-scim.md`](../microsoft-entra-sso-scim.md)。要点：

1. Entra 侧建一个非 gallery 企业应用（Micx），并分配测试用户/组。
2. 从 Entra 复制 **Microsoft Entra Identifier / Login URL / Certificate (Base64)**：
   - `IdP Issuer URL` ← Entra **Microsoft Entra Identifier**（是 IdP issuer，不是 app Identifier）。
   - `SAML Entry Point` ← Entra **Login URL**。
   - `IdP Certificate` ← Entra Base64 证书。
   - `Domain` ← 该 SSO 覆盖的邮箱域，如 `example.com`。
3. Micx 生成 **ACS URL / Metadata URL / Sign-in URL**；回 Entra **Basic SAML
   Configuration** 配 **Reply URL**(=ACS)、**Identifier/Entity ID**（=Micx audience，
   非 `sts.windows.net` issuer）、**Sign-on URL**。
4. 属性映射须给 Micx：`email`、`displayName`、邮箱式 Name ID。
5. 自定义域（如 `example.com`）需在 Micx 申请 TXT token、发 DNS `TXT`、点击
   **Verify domain**；`*.onmicrosoft.com` 域则由 Entra tenant 自动验证。

### 3.3 允许的域名与 `requireSso`

- 配置**允许的域名** + **SSO 要求（`requireSso`）** 后，根登录/注册体验变为「仅
  Continue with SSO」；`requireSso` 写组织设置（`PATCH /v1/org`）在启用套餐门禁时会
  受 402 门限（`enterprise-plan-gating.md`）。
- 组织级设置中可同时维护 **allowedDesktopVersions**（桌面版本钉紧，仅 Enterprise）。
- 被 SSO 覆盖的域，raw email/password 会被拒（§3.1）。

### 3.4 SCIM（可选）预置

- Micx **Dashboard → SCIM** 复制 **SCIM base URL**，创建/轮换并**立即复制** bearer token
  （token 只在创建/轮换时显示一次）。
- Entra App → **Provisioning → Automatic** → `Tenant URL` = SCIM base URL，
  `Secret Token` = bearer token，`Test Connection`，设置范围与映射（`userName` ↔
  `userPrincipalName`/`mail`），打开 **Provisioning Status**。
- 可在 Micx 开启 **Create teams from SCIM groups**（团队预置）；关闭则保留组元数据不建队。

> 前置：允许的公共 HTTPS web 与 auth URL 需已定稿，SAML 不要在临时 HTTP origin 上做。

---

## 4. 桌面端与安装链接

本地优先桌面端通过**安装链接（install link）**连接回自托管 Den。完整机制见
[`org-install-links.md`](../org-install-links.md)。默认：**自托管每个组织都有下载页**，
且 `DEN_INSTALL_LINKS_GATING_ENABLED` 已 Deprecated 且 inert（kill switch 通过
`bootstrapAdminEmails` 的 `/admin` 把组织置灰实现）。

### 4.1 三步安装流程（给成员的链路）

管理员把组织的安装链接发给成员，打开后是三步页：

1. 下载并运行标准 Micx 安装器。
2. 返回 Den，点击 **打开 Micx**。
3. 在 App 中确认确切的组织与服务器，再完成正常组织登录。

- `install_link` 与 `desktop_conn_grant` 两张表由 Helm 迁移 Job 自动创建
  （`migrations.enabled=true`）。
- 交接模式默认 `exchange`（无密钥）：点击「打开 Micx」时，Den 铸一个**新的** 5 分钟
  单次 use 的 code，只存其 SHA-256 哈希；确认后一次写入 `desktop-bootstrap.json`。
- 可选 `signed` 模式需专用 `DEN_CONNECT_LINK_MODE=signed` + `DEN_CONNECT_LINK_KEY_ID`
  + `DEN_CONNECT_LINK_PRIVATE_KEY`，且发布版已内嵌对应公钥；用
  `scripts/generate-connect-link-keypair.mjs` 生成。发布版未内嵌公钥前**不要**开 `signed`。
- MDM 替代：通过公共安装器直接写 `desktop-bootstrap.json`
  （`${XDG_CONFIG_HOME}/micx/desktop-bootstrap.json`，Win 用 `%LOCALAPPDATA%\micx\...`）。

> 单源拓扑：桌面 `baseUrl` 指向 Den Web origin，API/MCP 走 `/api/den` 代理；
> 参考 `org-install-links.md` 的 public origins 与接通 path。

### 4.2 桌面端策略（Desktop Policies）

管理员通过 **org 桌面策略**批量管控成员桌面能力：可选 provider / model / 扩展 / 应用版本
门控，桌面 app 自动执行，无需 MDM 脚本（详见
[`desktop-app-policies.md`](../desktop-app-policies.md)）。

- 策略目录：`packages/types/src/den/desktop-policies.ts` 的 `desktopPolicyDefinitions` 是唯一真源；
  布尔策略 false=受限，true/undefined=不拦截；多策略间按 `calculateEffectiveDesktopPolicy()` OR 合并。
- 新增/编辑策略经由 `/v1/desktop-policies`、`/v1/desktop-policies/:id`；
  开启 `DEN_PLAN_GATING_ENABLED` 时这些写操作需 **enterprise entitlement**（无则 402）。
- 禁止**自定义 provider**、`allowCustomProviders`、`allowMultipleWorkspaces`、`allowZenModel`、
  `allowedDesktopVersions` 为主要门控项，桌面 App 的
  `useCheckDesktopRestriction()` / `useDesktopRestriction()` 封装消费。

> 策略只作用于「在 Ent/组织配置的」成员；owner 是配置方而非被约束方。**移除策略**与
> **所有 GET** 永不被门禁，降级/删除始终可行。

---

## 5. 邀请 / 预置用户

用户进入组织的三种路径，由管理员在本组织控制：

1. **组织邀请链接**：owner/admin 生成邀请；接受链接用 `DEN_BETTER_AUTH_TRUSTED_ORIGINS`
   首个非通配符项（单源拓扑就是 Den Web origin）。
2. **SSO JIT**：启用 SSO 后，SSO 登录即时把用户建立 external identity link 并落到单例组织。
3. **SCIM 预置**：组织级 SCIM token + IdP（如 Entra）自动创建/更新/取消预置用户；
   被 SCIM/SSO 管理的用户在组织内禁止邮箱/密码登录（见 §3）。

> 单模式下，这些路径都自动落到唯一组织，不出现「选择团队 / 创建团队」界面；再创建组织会
> 返回 single-org 错误（`POST /v1/org` 被拒）。

---

## 6. Break-glass 与恢复（Recovery）

> 本节只描述代码/文档**实际支持**的路径；不支持的一律标 `[planned]`。

### 6.1 概述与保障载体

单组织用以下**两个独立门控**支撑出问题时的可恢复性：

- **`DEN_SINGLE_ORG_OWNER_EMAILS` / `config.tenancy.ownerEmails`**：owner 认领门控（§2.2）。
- **`DEN_BOOTSTRAP_ADMIN_EMAILS` / `config.public.bootstrapAdminEmails`**：可选「平台级
  admin」白名单，启动时 seed；平台 admin 与组织 owner **互不干扰**（不因此成为 owner）。

平台 admin 与 owner 门控彼此独立，任一路都可用来恢复另一路。

### 6.2 常见事件与处置

**A. owner 丢失（无可恢复的 owner）**

当组织 `activeOwnerCount === 0` 且又**没有 platform admin** 能代劳时，owner 门控邮箱命中
的用户会被重新授权为 owner（`single-org-policy.ts: resolveSingleOrgMembershipRole`）。
流程：把组织 owner 门控邮箱设为你信任的备用成员邮箱 → 让该邮箱登录（或通过 SSO/SCIM 预置）
→ 该用户下一次访问组织时被授予 owner。

> 若组织还有平台 admin（`bootstrapAdminEmails` 种子），可由该 admin 在
> `/admin` 列出机构、调整成员角色，或直接登记新的 owner 门控邮箱，同样能恢复 owner。

**B. SSO 锁定（SSO 配置错误导致全员无法进入）**

- 因 SSO 连接配置错误导致的登录失败：SSO 的**读/删除**永不门禁（`enterprise-plan-gating.md`），
  **GET** 与 **DELETE** 始终可行 → owner/security admin 可打开 Dashboard 删除或重建 SSO 连接；
  移除对某域绑定的 SSO 后，该域用户不再被判定为「SSO/SCIM 管理的用户」，即不再拒绝邮箱/密码登录。
- 若连 owner 也因此无法进入：用 §6.2-A 的平台 admin 路径，或先用未绑定 SSO 的 owner
  门控邮箱重建 owner 会话。

**C. 所有权转移（owner → super-admin）**

组织 owner 可在组织成员页把所有权转给**任一位活跃 super-admin**
（`transferOrganizationOwnership`）；目标不是 super-admin 时调用被拒（
`"Choose an active workspace super-admin to become owner."`）。转移会：

- 新目标 roles 加入 `owner`（去掉原 owner 专属位）；
- **原 owner 与其它 owner 全部降级为 `super-admin`**；
- 刷新相关 API key 与 session credentials。

> owner **不可从组织移除**（`owner_role_locked`），唯一「移除 owner」的方式是转移所有权后
> 再也非 owner，再正常移除/删除成员。

**D. SCIM 预置误删唯一 owner 的防护**

代码与策略保护 SCIM 不得移除唯一 owner（§3.1 + `organization-member-guards.ts` 的
`validateOrganizationMemberRemoval` 拒绝 owner 移除），避免预置误操作把组织 owner 清空。

**E. 升级 / 数据损坏兜底**

- 迁移 Job 幂等（`__drizzle_migrations` + 唯一键），`helm upgrade/install` 重跑即可；
  `replicaCount>1` 时确认 worker provisioning 幂等或外部选举（见 Helm README 的
  Worker Provisioning Recovery）。
- 数据库是 Den 状态库（MySQL）；做常规备份/恢复演练可覆盖成员、SSO、安装链接等全部状态。

### 6.3 尚无的恢复能力（未实现，勿当已有）

- **彻底离线 / 手动托管 owner 重置工具**：当前「重认领 owner」依赖
  `DEN_SINGLE_ORG_OWNER_EMAILS` + 用户自行登录；无「CLI 一键改 owner」工具。
  `[planned: A2]` 提供 owner 重置 CLI / bootstrap-token 路径。
- **SCIM 撤销 / PII 回收**：SCIM 撤销会删除全局用户，仅当该用户无其他活跃组织成员身份时
  （`microsoft-entra-sso-scim.md`）；当前无统一的「回收 PII」管理入口 `[planned]`。
- **自有数据主权 / 计费数据导出**：见 §7 的 `[planned: A5]` 表项。

---

## 7. 尚未实现能力显式标注（planned）

为避免误以为这些已存在，对照 **[`self-hosted-install-guide.md`](./self-hosted-install-guide.md)
§7 的「尚未实现」表**，与本初始化有关的、当前 **未实现** 的能力如下：

| 能力 | 状态 | 说明 |
|---|---|---|
| 生产 worker 预置（非 stub） | `[planned: A3]` | `PROVISIONER_MODE=stub/render/daytona` 已实现；本地/私有 sandbox provider 需自建 gate。 |
| worker 连接（connect worker）自托管路径 | `[planned: A3]` | 桌面 connect 见 §4；完整自托管 worker 预置还差一步。 |
| 自托管计费（Stripe/Polar 你连） | `[planned: A5]` | 现在 `polar` 仅 hosted 计费门禁可用。 |
| 数据主权 / 驻留 / 自管存储 | `[planned: A5]` | 控制面仅用 MySQL；对象存储 / worker 数据层托管方案需自建。 |
| 模型 / 工具 allowlist（集中强制） | `[planned: A4]` | Desktop Policies 之上，服务器端集中强制 allowlist 尚未完成。 |
| 单组织 owner 重置 CLI 工具 | `[planned: A2]` | 见 §6.3，仅有 owner 门控邮箱 / 平台 admin 路径。 |

> 权威参考：安装与供应链 `self-hosted-install-guide.md` §7；其余依赖能力以
> `packaging/helm/micx-ee/README.md`、`ee/apps/den-api/.env.example`、`docs/` 相应文档为准
> ——不存在就按「尚未实现」处理，不要臆测。

---

## 附：引用源文件

- `docs/single-org-mode-plan.md`；`docs/enterprise/self-hosted-install-guide.md`（A2 T1）
- `ee/apps/den-api/src/orgs.ts`、`org.ts`、`single-org-policy.ts`、`organization-member-guards.ts`、
  `organization-role-hierarchy.ts`、`routes/auth/index.ts`；`ee/apps/den-api/src/env.ts`
- `packaging/helm/micx-ee/values.yaml`、`ee/apps/den-api/.env.example`
- `docs/microsoft-entra-sso-scim.md`、`docs/org-install-links.md`
- `docs/desktop-app-policies.md`、`docs/enterprise-plan-gating.md`