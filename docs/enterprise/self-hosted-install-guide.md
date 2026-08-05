# Micx Work 企业自托管安装指南（Self-hosted Enterprise Install Guide）

> 适用对象：负责在企业自有基础设施（VPC / 私有云 / Kubernetes / 自营机房）
> 上部署 **Micx Work** 的 IT 团队。本文档面向 **单组织（single-org）** 私有部署：
> 一套部署 = 一个由贵司拥有的工作区，从零起步到第一位 owner 可正常使用。
>
> 本页面为《初始化指南》（`docs/enterprise/initialization-guide.md`）的上游手
> 册；部署完成后进入初始化向导的操作见该文档（A2 Task 2，紧随本文档发布）。

本文档表述基于仓库当前已实现的代码与配置。凡是「尚未实现」的能力，都会用
`[planned] A4` / `[planned] A5` 显式标注，**不要**把它们当作已存在。

---

## 1. 概览与前置条件（Overview & prerequisites）

### 1.1 自托管单组织部署能给你什么

自托管单组织模式让 Micx Work 表现为「一个客户自有的工作区」：

- 一个部署组织（singleton organization），自动选中，禁止创建第二个组织；
- 首个 owner 通过 `DEN_SINGLE_ORG_OWNER_EMAILS` 认领组织所有权；
- 后续用户自动加入该组织，不出现「创建 / 切换团队」界面；
- SSO（SAML/OIDC）与 SCIM 作为正常生产路径；在组织启用 SSO 后，登录体验
  变为「仅 Continue with SSO」；
- 本地优先桌面端通过安装链接（install link）连接回你的 Den。

该模式是**部署策略**，不是独立的数据库模型——内部仍使用 organization /
member / role / worker / MCP resource 等对象，只是单组织对外不暴露创建多租期的
界面。

> 托管 Micx Cloud 仍是多组织（multi_org）。本文档只覆盖自托管单组织。

### 1.2 你需要在动手前准备好的东西（Prerequisites checklist）

| 项 | 说明 | 是必填吗 |
|---|---|---|
| 域名 / DNS | 公开可达的 HTTPS 域名，例如 `micx.example.com`（Den Web）与 `api.micx.example.com`（Den API，可选独立源） | 是 |
| MySQL 兼容数据库 | Den 控制面状态库。用托管 MySQL（含 failover / backup）或自建冗余。生产建议加密 at-rest、TLS 传输 | 是 |
| TLS / HTTPS 终端 | 每个公网服务前都要有 HTTPS；Den Web 的 `/api/den` 反向代理需能到达 Den API | 是 |
| 密钥（Secrets） | `BETTER_AUTH_SECRET`、`DEN_DB_ENCRYPTION_KEY` 至少各 32 字符；MySQL 口令；SMTP 口令（可选） | 是 |
| IdP（身份提供方） | 用于 SAML/OIDC SSO 与 SCIM 的 Microsoft Entra ID 等 | 可选（Owner 引导之后配置） |

> 关于「Micx Cloud 标识 / 品牌」的引用：本仓库与文档沿用外部托管默认值
> （例如 `github.com/different-ai/openwork`、`openworklabs.com`、`micxlabs.com`）。
> 这些是**托管侧的发布物/外部真实链接**，不自托管部署必需；自托管只用到其中
> 与订阅下载、发布物相关的部分（见 6 节）。阻塞网络时参考
> [`docs/enterprise/outbound-access.md`](./outbound-access.md)。

---

## 2. 部署路径（Deployment paths）

生产环境推荐并唯一完整支持的是 **Helm on Kubernetes**。仓库内**没有**生产级
Compose 文件——见 §2.2 说明。

| 路径 | 状态 | 适用 |
|---|---|---|
| (a) Helm on Kubernetes（OCI chart） | 已实现，推荐生产 | K8s / EKS / AKS / GKE / 私有云 |
| (b) Docker Compose 单机 | 仅 dev/testability，**不是**生产部署 | 本地联调、验证 Helm 值，不作为生产随带路径 |

### 2.1 路径 (a)：Helm on Kubernetes（生产推荐）

Chart：`micx-ee`，发布为 OCI 制品：

```
oci://ghcr.io/different-ai/charts/micx-ee
```

工作负载：

- `den-api` 控制面，端口 `8788`
- `den-web` Web 端，端口 `3005`
- `inference`（可选）Micx Models 代理与计量，端口 `8791`

镜像（发布到 GHCR）：

- `ghcr.io/different-ai/micx-den-api`
- `ghcr.io/different-ai/micx-den-web`
- `ghcr.io/different-ai/micx-inference`

图表的权威参考：`packaging/helm/micx-ee/README.md`。以下为最小可用配置。

**Step 0 — 创建命名空间**

```bash
kubectl create namespace micx
```

**Step 1 — 准备私有 GHCR 拉取凭据（若镜像非公开）**

```bash
helm registry login ghcr.io
kubectl create secret docker-registry ghcr-pull-secret \
  --namespace micx \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<github-token>
```

**Step 2 — 编写环境 variables 值文件 `values.prod.yaml`**

```yaml
image:
  tag: "0.1.0"            # 用发布版本号替换

imagePullSecrets:
  - name: ghcr-pull-secret  # 私人 GHCR 时填写

config:
  tenancy:
    # 自托管默认 single_org；托管 Micx Cloud 应显式设 multi_org。
    mode: "single_org"
    singleOrgName: "Micx"
    singleOrgSlug: "default"
    ownerEmails: "admin@example.com"     # 谁可认领组织的 owner
    allowPublicSignup: "false"
    requireEmailVerification: "false"
  public:
    webOrigin: "https://micx.example.com"
    apiOrigin: "https://api.micx.example.com"
    mcpResourceUrl: "https://api.micx.example.com/mcp"
    mcpClaimNamespace: "https://micx.example.com"
    desktopDenBaseUrl: "https://micx.example.com"
    corsOrigins: "https://micx.example.com,https://api.micx.example.com"
    betterAuthTrustedOrigins: "https://micx.example.com"
    webAppHosts: "micx.example.com"
    bootstrapAdminEmails: "admin@example.com"   # 可选平台级 admin，见 §3
    installLinksGatingEnabled: "false"          # 自托管默认每个组织都有下载页
    authCallbackUrl: "https://micx.example.com"
  githubConnector:
    appId: ""
    clientId: ""

secret:
  values:
    databaseUrl: "mysql://micx:REPLACE_DB_PASSWORD@mysql.example.internal:3306/micx_den?sslaccept=accept"
    betterAuthSecret: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"
    denDbEncryptionKey: "REPLACE_WITH_AT_LEAST_32_CHARACTERS"
    emailFrom: "Micx <no-reply@example.com>"
    smtpHost: "smtp.example.com"
    smtpPort: "587"
    smtpUser: "micx@example.com"
    smtpPass: "REPLACE_ME"
    smtpSecure: "false"

ingress:
  enabled: true
  className: nginx        # 只生成 Ingress 资源，不安装控制器；须集群已有兼容控制器
  web:
    host: micx.example.com
  api:
    host: api.micx.example.com
```

> **TLS 说明**：Demo 值 `sslmode=accept` 仅启用加密不校验证书，只用于 smoke；
> 生产用 `customCa` + `sslmode=verify-full|verify-ca` 做严格校验（见
> `packaging/helm/micx-ee/README.md` 的 Custom CA 章节，密钥/CA 须先于
> `helm install` 创建好）。

**Step 3 — 安装 / 升级**

```bash
helm upgrade --install micx-ee oci://ghcr.io/different-ai/charts/micx-ee \
  --version REPLACE_MICX_VERSION \
  --namespace micx \
  --create-namespace \
  -f values.prod.yaml
```

本地从仓库 checkout 渲染或安装（对照图表再查一遍）：

```bash
helm template micx-ee ./packaging/helm/micx-ee -f values.prod.yaml
helm upgrade --install micx-ee ./packaging/helm/micx-ee -f values.prod.yaml
```

**Step 4 — 验证**

```bash
kubectl rollout status deployment/micx-ee-den-api --namespace micx
kubectl rollout status deployment/micx-ee-den-web --namespace micx
kubectl rollout status deployment/micx-ee-inference --namespace micx   # 启用 inference 时

kubectl get pods --namespace micx
curl -i https://micx.example.com/api/health
```

已发布的可访问的供应商手册：

- AWS EKS：`docs/aws-eks-helm.md` + `examples/values.aws-load-balancer.yaml`
- Azure AKS：`docs/azure-aks-helm.md` + `examples/values.azure-ingress.yaml`
- Google GKE：`docs/gcp-gke-helm.md` + `examples/values.gcp-ingress.yaml`

规划中自助页面（托管文档）：

- `packages/docs/start-here/private-network-deployment.mdx`
- `packages/docs/start-here/air-gapped-deployment.mdx`
- `packages/docs/start-here/installer-delivery.mdx`
- `packages/docs/start-here/certificate-trust-and-proxies.mdx`

**数据库迁移**：Helm 的 migration Job 以 `pre-install,pre-upgrade` hook 运行，
空库会打上当前 schema 基线再跑 Drizzle 迁移；还会自动创建
`install_link` 和 `desktop_conn_grant` 两张表（约 `migrations.enabled=true` 时）。
若 `denApi.replicaCount>1`，请确认 worker provisioning 操作幂等或外部选举（见 Chart README 的
Worker Provisioning Recovery 章节）。

### 2.2 路径 (b)：Docker Compose —— 当前**不是**生产路径

仓库中可用的 Compose 文件（`packaging/docker/`）**全部**属于本地开发 / 测试
用途，不构成生产部署模板：

- `docker-compose.den-dev.yml` —— Den 本地**测试性**栈（local testability）。
- `docker-compose.dev.yml` —— Dev 测试栈（headless，不含 Den 控制面）。
- `docker-compose.otel-lgtm.yml` —— OTLP 开发后端。
- `docker-compose.web-local.yml`、`docker-compose.yml` —— 桌面端/预言主机微服务。

因此：**没有**生产级 Docker Compose 模板可用。若要用 Compose 单机跑生产
Micx EE，当前需要自行拼接 `Dockerfile.den` / `Dockerfile.den-web` 与 MySQL，
该路径未经过测试，且没有官方模板支持。生产请走 (a) Helm 路径。
`[planned: A4]` 提供官方单机 / Compose 生产打包。

---

## 3. 控制面（Den）环境变量配置

Den 控制面由 `ee/apps/den-api/.env.example` 与 Helm `values.yaml` 定义真实变量名。
单组织部署关键项：

### 3.1 模式与租户

| 变量 / Helm 值 | 默认 | 含义 |
|---|---|---|
| `DEN_ORG_MODE` / `config.tenancy.mode` | `single_org`（未设置时按 `single_org`） | 部署模式：`single_org` 或 `multi_org` |
| `DEN_SINGLE_ORG_NAME` / `config.tenancy.singleOrgName` | `Micx` | 组织所有者组织的显示名 |
| `DEN_SINGLE_ORG_SLUG` / `config.tenancy.singleOrgSlug` | `default` | 组织所有者组织的 slug |
| `DEN_SINGLE_ORG_OWNER_EMAILS` / `config.tenancy.ownerEmails` | `""` | 逗号分隔、可认领组织 owner 的 email |
| `DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP` / `config.tenancy.allowPublicSignup` | `"false"` | 是否允许公开注册（自托管默认关闭） |
| `DEN_REQUIRE_EMAIL_VERIFICATION` / `config.tenancy.requireEmailVerification` | `"false"` | 单组织模式默认关闭验证码邮箱验证 |

> `config.tenancy.ownerEmails` 控制谁可认领组织 owner；
> `config.public.bootstrapAdminEmails` 单独设置平台 admin 白名单，
> **不会**因此让该用户成为组织 owner。

### 3.2 公开域名 / Auth / CORS

| 变量 / Helm 值 | 示例 | 含义 |
|---|---|---|
| `BETTER_AUTH_URL` / `config.public.webOrigin` | `https://micx.example.com` | Better Auth 外部可到达的 Den Web origin |
| `DEN_API_PUBLIC_URL` | `https://micx.example.com/api/den` | 外部可到达的 Den API base；单源拓扑用 web 代理路径，仅指向 Web origin |
| `DEN_BETTER_AUTH_TRUSTED_ORIGINS` | `https://micx.example.com` | Better Auth 信任来源；邀请链接用第一个非通配符项 |
| `CORS_ORIGINS` / `corsOrigins` | 见 `config.public.corsOrigins` | 逗号分隔的 CORS 与 trusted origins |
| `DEN_MCP_RESOURCE_URL` | `https://api.micx.example.com/mcp` | 公共 MCP resource URL |
| `DEN_MCP_ADDITIONAL_RESOURCES` | `""` | 之外的额外公开 MCP resource URLs |
| `DEN_MCP_CLAIM_NAMESPACE` | 默认 `BETTER_AUTH_URL` | MCP token 的 claim 命名空间；托管默认建议 `https://openworklabs.com` 保留旧 claim |
| `config.public.connectLinkMode` | `exchange` | install-link 交接模式（无需密钥）；`signed` 需专用 Ed25519 |

### 3.3 密钥与邮箱（secret）

| 密钥键（Secret 中） | 环境变量 | 说明 |
|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | MySQL DSN |
| `BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` | 至少 32 字符 |
| `DEN_DB_ENCRYPTION_KEY` | `DEN_DB_ENCRYPTION_KEY` | 加密敏感列，至少 32 字符，与 Better Auth 不同 |
| `EMAIL_FROM` / SMTP 系列 | `EMAIL_FROM`,`SMTP_*` | 事务邮件（留空 `smtpHost` 则停用 SMTP） |
| `DAYTONA_API_KEY` | `DAYTONA_API_KEY` | 仅 `provisioner.mode=daytona` 时需要 |
| `POLAR_ACCESS_TOKEN` | `POLAR_ACCESS_TOKEN` | 启用 Polar 计费门禁时 |
| `OPENROUTER_MANAGEMENT_API_KEY` | `OPENROUTER_MANAGEMENT_API_KEY` | 启用 Micx Models 管理时 |
| `connectLinkPrivateKey` | `DEN_CONNECT_LINK_PRIVATE_KEY` | 仅 `connectLinkMode=signed` 时需要 |

密钥生成建议（乱数，勿用示例值）：
```bash
openssl rand -base64 128   # 用于 BETTER_AUTH_SECRET / DEN_DB_ENCRYPTION_KEY
```

### 3.4 其它部署相关

- **`DEN_ALLOW_PRIVATE_MCP_URLS`**：默认为 `.env.example` 空，保持外部 MCP 的 SSRF 防护；
  仅当 Den 运行在私网内且 MCP 服务器在私有地址时设 `1`（`MICX_DEV_MODE=1` 已豁免本地）。
- **`DEN_PLAN_GATING_ENABLED`**：SSO/SAML + Desktop Policies 的企业套餐门禁（见
  `docs/enterprise-plan-gating.md`）。默认**关**——自托管安装除非显式开启，否则保持
  开源/可插拔。开启后，新增/编辑 SSO 与桌面策略需 Enterprise entitle（更改受 402 门控；
  已配置的继续运行不受影响）。
- **观察性**：`DEN_OBSERVABILITY_BACKEND=none|otel|sentry`；OTLP 走 HTTP/protobuf，
  端口多为 `4318`（gRPC `4317` 不支持）。详见 `packaging/helm/micx-ee/README.md`。
- **诊断**：`DEN_DIAGNOSTICS_ORIGIN` 默认 `https://diagnostic.openworklabs.com`（托管默认，自托管可覆盖）。

---

## 4. 首次启动与 Owner 引导（First boot & owner bootstrap）

### 4.1 幂等创建组织所有者组织

首次用户落地签名时，Den 若发现 singleton 组织不存在，就根据
`DEN_SINGLE_ORG_NAME` / `DEN_SINGLE_ORG_SLUG` 幂等创建，并把**第一个符合条件的用户**
置为组织 owner。

- 若配置了 `DEN_SINGLE_ORG_OWNER_EMAILS`，**仅**列表内邮箱可认领 owner；
- 若没配，第一个到达用户可认领（因此生产必须显式配置 `ownerEmails`）；
- 后续用户自动加入该组织，看不到「创建组织」步骤；再创建组织会返回 single-org 错误。

推荐 Helm 值（第一次用 Owner 即此）：

```yaml
config:
  tenancy:
    mode: single_org
    singleOrgName: "Acme"
    singleOrgSlug: "acme"
    ownerEmails: "admin@acme.com"
    requireEmailVerification: "false"
  public:
    bootstrapAdminEmails: "admin@acme.com"
```

### 4.2 Owner 落地后的初始化

第一个 owner 登录后会落到一个 setup 检查列表：

- 确认组织名
- 配置 SAML/OIDC SSO
- 配置允许的域名与 SSO 要求
- （可选）配置 SCIM
- 邀请 / 预置用户
- 安装桌面端 / 连接 worker

> SSO 配置后，根签名/注册体验变为「仅 Continue with SSO」：raw email/password
> 的登录/注册会被 Den API 拒绝（`single_org_sso_required`）。

**下一步**：完成「零起步到第一个 owner 可用」的完整初始化操作，见
[`docs/enterprise/initialization-guide.md`](./initialization-guide.md)。

---

## 5. 身份（SSO/SAML/OIDC）+ 可选 SCIM

Den 用 Better Auth 承载 SSO/SCIM 底层协议，再包一层 organization 路由与策略。

### 5.1 管理面route

| 面 | 表面 | 运行时 |
|---|---|---|
| SSO 管理 | `/dashboard/sso`, `/v1/sso`, `/v1/sso/saml`, `/v1/sso/oidc` | 每组织一个 SSO 连接；owner/安全 admin 可创建/替换 |
| SAML 回调 | `/api/auth/sso/saml2/sp/acs/micx-sso-<org-id>` | Better Auth 消费响应 |
| SAML 元数据 | `/api/auth/sso/saml2/sp/metadata?providerId=micx-sso-<org-id>` | 存连接后生成 |
| SSO 登录 | `/sso/<org-slug>` | SP-initiated SSO |
| SCIM 管理 | `/dashboard/scim`, `/v1/scim`, `/v1/scim/token` | owner 创建/轮换组织级 SCIM token |
| SCIM 预置 | `/api/auth/scim/v2` | 增删改、取消预置 |

### 5.2 SAML 安全默认（Micx 强制）

- 要求已签名 SAML 断言；
- IdP-initiated 仅接受该 org 的 ACS URL；
- 要求 SAML 时间戳；
- 拒绝已弃用 SAML 算法；
- SSO 登录写入外部身份链接 + JIT 组织 membership；
- 被组织 SSO/SCIM **管理的用户**，邮箱/密码登录被拒绝。

> 目前**不支持** SCIM Group object 预置（可对 Entra 应用分配用户/组来限定范围，
> 但关闭 group object 映射）。

### 5.3 配置示例（Microsoft Entra）

完整手把手流程：`docs/microsoft-entra-sso-scim.md`（含 IdP 与 Micx 双方的填写、
验证、troubleshooting）。要点：

1. Entra 侧建一个非 gallery 企业应用（Micx）。
2. Entra 复制 **Microsoft Entra Identifier / Login URL / 证书(Base64)**；
   Micx `Dashboard -> SSO -> SAML` 填入：**IdP Issuer URL / Domain / SAML Entry Point / IdP Certificate**。
3. Micx 生成 **ACS URL / Metadata URL / Sign-in URL**；回到 Entra **Basic SAML Configuration**
   配到 **Reply URL / Identifier / Sign on URL**。
4. 属性映射须给 Micx：`email`、`displayName`、名称 ID（邮箱式）。
5. SCIM：Micx `Dashboard -> SCIM` 复制 **SCIM base URL** 和新建的 bearer token；
   Entra `Provisioning` 中 `Tenant URL`=SCIM base URL，`Secret Token`=token，开启自动预置。

> 前置：Micx 组织需要先有组织 owner，且在启用企业套餐门禁（`DEN_PLAN_GATING_ENABLED`）
> 的情况下具备 Enterprise entitle，否则保存 SSO 设置会被拒绝（402）。
> 最终公开的 HTTPS webs 与 auth URL 也要先定好，别用临时 HTTP 源做 SAML 认证。

其他 IdP / MCP 相关文档：
`docs/google-workspace-oauth-verification.md`、`docs/external-mcp-oauth.md`。

---

## 6. 本地优先桌面端（Local-first desktop）

桌面端通过**安装链接（install link）**连接回自托管 Den。流程：

1. 从组织的安装链接打开三步页面：下载并运行标准 Micx 安装器。
2. 返回 Den，点击 **打开 Micx**。
3. 在 App 中确认确切的组织与服务器，再完成正常组织登录。

`install_link` 与 `desktop_connect_grant` 两张表由 Helm 迁移 Job 自动创建
（`migrations.enabled=true` 时）。自托管默认每组织都有下载页
（`DEN_INSTALL_LINKS_GATING_ENABLED` 已 Deprecated 且 inert；`bootstrapAdminEmails`
仅用于平台 admin 把组织置灰作 kill switch）。

- 连接交接模式默认 `exchange`（无需密钥）：Micx 会在点击「打开 Micx」时铸新 5 分钟
  单次 use 的 code，仅存其 SHA-256 哈希；交换确认后一次写入 `desktop-bootstrap.json`。
- 可选 `signed` 模式需专用 Ed25519 密钥（`DEN_CONNECT_LINK_MODE=signed` +
  `DEN_CONNECT_LINK_KEY_ID` + `DEN_CONNECT_LINK_PRIVATE_KEY`，且发布版已内嵌公钥）；
  用 `scripts/generate-connect-link-keypair.mjs` 生成。
- 单源拓扑：桌面 `baseUrl` 指向 Den Web 源，API/MCP 经 `/api/den` 代理
  （参考 `docs/org-install-links.md` 中 public origins 与接通 path）。

**拓扑与下载能力说明**

- 互联网直连：Den 对标准 asset 做 302；客户端需可达 `github.com`、release-asset CDN 与
  相应 hosts。
- semi-air-gapped / fully internal：把标准安装器挂载到 `installerArtifacts`（
  `MICX_INSTALLER_ARTIFACTS_DIR` / `/var/lib/micx/installer-artifacts`），浏览器只与
  Den 说话，不需要 `github.com`。

> `micx-<platform>-<version>.<ext>` 文件名规则与 MDM `desktop-bootstrap.json` 写文件
> 路径见 `docs/org-install-links.md`（Win/macOS/Linux 各平台）。

---

## 7. 尚未实现的能力（计划中 / roadmap）

为避免误以为这些能力存在，以下项目**当前未实现**，以 `[planned: A-里程碑]` 标注：

| 能力 | 状态 | 说明 |
|---|---|---|
| 私有模型网关（private model gateway） | `[planned: A4]` | 自托管自行托管推理模型网关（现 `inference` 可选服务，非完整私有模型层）。 |
| 数据主权（数据驻留 / region pinning / 自管存储） | `[planned: A5]` | 控制面仅用 MySQL；对象存储 / worker 数据层托管方案自建。 |
| 正式单机生产 Compose | `[planned: A2]` | 目前只有 dev/testability Compose（见 §2.2）。 |
| worker 生产预置（非 stub） | `[planned: A3]` | `PROVISIONER_MODE=stub/render/daytona` 已实现；本地/私有 sandbox provider 自建 gate。 |
| 自托管计费（Stripe/Polar 由你引） | `[planned: A5]` | 现在 `polar` 仅 hosted 计费门禁可用。 |
| 自托管多组织（多租期） | `[planned: A2]` | 代码存在（`DEN_ORG_MODE=multi_org`），但本文档聚焦单组织；托管 Cloud 才用。 |
| 模型 / 工具 allowlist（集中强制） | `[planned: A4]` | Desktop Policies 的能力在此基础上，服务器端强制 allowlist 尚未完成。 |

如你需要的清单不在上表且你**确实需要**，请先确认 `packaging/helm/micx-ee/README.md`、
`docs/` 或对应 `.env.example` 确认该能力是否存在；不存在就按「尚未实现」处理，不要臆测。

---

## 附：README/引用源文件

- `packaging/helm/micx-ee/Chart.yaml`、`values.yaml`、`README.md`
- `docs/single-org-mode-plan.md`、`docs/org-install-links.md`
- `docs/desktop-app-policies.md`、`docs/enterprise-plan-gating.md`
- `docs/microsoft-entra-sso-scim.md`、`docs/external-mcp-oauth.md`
- `packaging/docker/`（Compose 系列、`Dockerfile.den` / `Dockerfile.den-web`）
- `ee/apps/den-api/.env.example`
- `packages/docs/start-here/self-host.mdx` 及并列 start-here 页面