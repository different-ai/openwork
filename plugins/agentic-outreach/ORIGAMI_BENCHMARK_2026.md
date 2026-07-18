<!--
[INPUT]: 依赖 Origami 2026-07-19 官方产品页、API/Skill、GitHub、价格与法律条款，以及 OpenWork agentic-outreach 当前实现
[OUTPUT]: 对外提供 Origami 数据链、Agent 接入、商业约束与 OpenWork 差距的可执行基准
[POS]: agentic-outreach 的竞品与采购决策基准，区分已证实事实、合理推断和营销冲突
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->
# Origami Benchmark 2026：B2B Outreach 数据链与 OpenWork 差距

核查日期：**2026-07-19（Asia/Shanghai）**。结论只采用 Origami 官方站点、官方文档、官方 Skill、官方 GitHub，以及候选外部服务自己的官方文档。页面文案和价格会变，正式采购前应重新核查。

状态标记：

- **事实**：官方产品、开发者或法律文档直接支持。
- **推断**：由多个官方事实组合得出的产品/架构判断，不宣称为厂商披露。
- **冲突**：官方营销页与正式文档/条款不一致；以结账页、账户内展示和签署协议为准。

## 1. 核心结论

**Origami 不是一个单独的数据供应商。它是一个 Agent-native GTM 编排层：用自然语言选择多种实时数据源，把结果落成可审阅表格，评分后才购买联系人，再在同一产品里启动邮件/LinkedIn 序列。** Origami 自己的[条款](https://origami.chat/terms)也明确写成“retrieve, aggregate, enrich, verify”第三方及公开数据，而非声称拥有全部底层数据。

对“能调别人的 MCP/API 就绝不自己做；易变事实实时抓；实际联系方式直接买”的产品原则，它最值得抄的不是具体供应商，而是四个产品化决定：

1. **实时发现与付费联系人严格分层**：先免费/低成本形成候选和证据，再对合格对象购买联系方式。
2. **联系方式按结果收费并做 provider waterfall**：失败不收费，用户不必管理每个供应商。
3. **研究、表格、外联处在一个对象模型里**：避免 CSV 搬运和跨系统丢状态。
4. **Agent 既是入口也是控制面**：自然语言能创建、追问、修改、暂停和恢复，但高风险动作仍需要人审阅。

OpenWork 当前的 `agentic-outreach` 已经把证据、资格评分、两次审批、预算、幂等、抑制和恢复协议写对了；真正缺的是**预装且可验证的供应商组合、统一的付费联系人语义、持久调度/回调、Campaign 执行面、共享 Inbox 与 CRM 状态同步**。也就是说，差距主要在“可交付的商业系统”，不是再写一层 prompt。

## 2. Origami 的实际数据链

```text
自然语言 brief / CSV / API / CRM context
                |
                v
Agent 解释 ICP、数量、地区、信号和输出字段
                |
                v
按任务路由数据源
  ├─ 公开实时源：网站、Google Maps、社媒、新闻、职位、商店
  ├─ 专业数据库：融资、技术栈、流量、公司/人员数据
  └─ 用户数据：CSV、表格、CRM 去重上下文、文档
                |
                v
Workspace → Table → Row/Cell → enrichment / score
                |
                v
资格过滤、去重、补列、实时证据与成本预估
                |
                v
付费联系人 waterfall（成功才扣费）
                |
                v
Campaign / Email + LinkedIn Sequencer / CRM 或 CSV
                |
                v
回复自动停序列 → 共享 Inbox / webhook → 人工接管
```

这条链来自[AI Prospecting 产品页](https://origami.chat/products/ai-research-agents)、[v2 对象模型](https://docs.origami.chat/agents/objects)、[Sequencer 产品页](https://origami.chat/products/sequencer)和[Webhooks 文档](https://docs.origami.chat/webhooks/overview)。

### 2.1 输入与规划

- **事实**：用户可以用自然语言描述目标；Agent 选择数据源并实时填充表格。已有名单可通过 CSV 输入后再补列。[AI Prospecting](https://origami.chat/products/ai-research-agents)
- **事实**：v2 API 可直接创建 Agent 并异步运行，也可操作 workspace、table、row、enrichment run、campaign、sequence、scheduled agent、project 和 credits。[官方 API 索引](https://docs.origami.chat/llms.txt) · [官方 OpenAPI v2](https://github.com/Origami-Agents/mintlify-docs/blob/main/openapi-v2.yaml)
- **推断**：Origami 的核心 IP 更像“数据源路由 + 表格对象模型 + 商业状态机”，不是单一搜索算法。

### 2.2 发现层：哪些数据实时抓

官方页面公开的源/数据类别如下。这里的“实时”是产品声明，不代表所有字段都逐次从原站拉取；专业数据库仍可能有自身刷新周期。

| 目标 | 官方披露的来源或数据 | 主要用途 |
|---|---|---|
| 本地商家 | Google Maps、本地 listings、州执照数据库、网站和评论 | 传统公司库覆盖差的门店、承包商、专业服务商。[Local Business](https://origami.chat/products/local-business) |
| 公司 | 公司网站、社媒、公司/人员数据库、技术栈、融资、新闻 | 行业、人数、地域、技术、融资、增长等 firmographic/technographic 筛选。[Company Search](https://origami.chat/products/company-search) |
| 人员 | 专业/社交资料、公司归属、职位和 seniority | 找角色、组织关系和公开资料，再决定是否付费补联系方式。[People Search](https://origami.chat/products/people-search) |
| 招聘信号 | 官方称聚合 100+ job boards，包括 Indeed、Greenhouse、Lever、Workday | 用在招岗位、首次招聘某角色、扩张方向判断需求。[Hiring Signals](https://origami.chat/products/hiring-signals) |
| 融资信号 | Crunchbase、新闻及公司数据 | 识别融资轮次、金额、时间与随后招聘/扩张。[Funding Signals](https://origami.chat/products/funding-signals) |
| 技术与流量 | BuiltWith、Similarweb、站点抓取 | 判断技术栈、迁移、流量和市场成熟度。[Signal Detection](https://origami.chat/products/signal-detection) |
| 电商 | Shopify、WooCommerce、BigCommerce、Magento 及店铺/流量数据 | 找特定品类、平台、流量或技术组合的商家。[E-commerce](https://origami.chat/products/ecommerce) |
| 创作者 | Instagram、YouTube、TikTok、Twitch 等公开资料 | 按平台、受众、主题和规模找 creator。[Creator Search](https://origami.chat/products/creator-search) |
| 开放 Web | Google、真实浏览器、公开网页和自定义 URL | 处理专业数据库没有的长尾字段及最新事件。[Web Scraping](https://origami.chat/products/web-scraping) · [Real-Time Data](https://origami.chat/products/real-time-data) |

**事实**：主产品页写“15+ built-in data sources”，并列出社媒/公司、Google Maps、100+ job boards、Shopify/WooCommerce、技术栈、融资、新闻和 X 等。[AI Prospecting](https://origami.chat/products/ai-research-agents)

**冲突**：同一官方站点的[Guide](https://origami.chat/guide)使用“50+ sources”口径，而产品页使用“15+ built-in”。这可能分别指底层 endpoint/站点和用户可选 source family，但官方没有给出统一定义。采购时只按已列明 source 与实际试跑覆盖率判断，不按总数营销。

### 2.3 结构化、资格判断和证据

- **事实**：数据进入 spreadsheet-style 的 Workspace/Table/Row/Cell；Column 类型包括 input、enrichment、score、sequence。[对象模型](https://docs.origami.chat/agents/objects)
- **事实**：用户可新增 email、phone、employee count、tech stack、funding history 或任意自定义列；资格结果可标成 pass/fail/unsure。[AI Prospecting](https://origami.chat/products/ai-research-agents)
- **事实**：API 的 enrichment run 可返回状态、计数、消耗 credits 与逐行结果；Agent run 是异步对象，需要轮询终态。[对象模型](https://docs.origami.chat/agents/objects)
- **推断**：Origami 的表格是 provenance 和 spend 的核心数据面，但官方公开页没有承诺每个单元格必带原始 URL、抓取时间和可导出的证据链。OpenWork 不应放弃自己更严格的 `source_url + observed_at + evidence_provider` 契约。

## 3. 联系人 waterfall：最直接的商业价值

截至核查日，[官方 Pricing](https://origami.chat/pricing)披露的顺序和价格是：

| 联系方式 | 顺序 | 成功价格 | 未找到 |
|---|---|---:|---:|
| Verified email | Findymail → LeadMagic → Wiza → People Data Labs → Prospeo | 3 credits/成功 email | 0 |
| Verified phone | Bytemine → People Data Labs → LeadMagic → Wiza → Findymail → Forager → Prospeo → ContactOut → Zeliq | 15 credits/成功 phone | 0 |

官方同时声明“0% markup”“pass provider pricing through at cost”。这是一条营销声明，不是可审计的成本证明；若 OpenWork 将来代收 credits，必须在供应商合同和账单层验证，而不是直接继承该说法。

联系人链条的产品语义应拆成：

```text
qualified lead
  → 选择 email / phone
  → 按固定顺序询问 provider
  → 命中后验证
  → 成功才记账并停止 waterfall
  → 未命中继续下一个 provider
  → 全失败则 0 联系人费用
  → 保存 provider、verification、cost 和外部 reference
```

- **事实**：Pricing 明确列出 waterfall 顺序、成功扣费和失败免费。[Pricing](https://origami.chat/pricing)
- **事实**：条款称 verified-contact lookup 仅成功时扣费，同时把联系方式按“as is”提供且不保证准确。[Terms §6, §11, §25](https://origami.chat/terms)
- **事实**：公开 OpenAPI 对 Outreach 写明“provider internals redacted”。官方没有承诺在 row/cell/enrichment response 中返回实际命中的 Findymail、PDL 等上游 provider。[OpenAPI v2](https://github.com/Origami-Agents/mintlify-docs/blob/main/openapi-v2.yaml)
- **不确定**：官方页面没有公开电话验证的完整方法、号码类型判断、最新验证时间或 SLA；“verified phone”不能自动等同“可接通”。
- **产品启示**：OpenWork 必须统一 `not_found / unverified / verified / failed / suppressed`，并将“供应商声称 verified”与“实际送达/接通”分开统计。若 Origami 没有返回上游 attribution，账本只能诚实记录 `Origami waterfall + Origami run/cell ID`，不能猜测是哪一家命中。

## 4. Sequencer 与闭环

Origami 的[Sequencer](https://origami.chat/products/sequencer)不是简单导出器，而是内建执行面：

- Email 与 LinkedIn/social 可各自最多 10 steps，并支持 wait/reply branch。
- 一个 table、filtered view 或单行都可由 Agent enrol；可让 Agent 换文案、改 angle 或暂停。
- 多邮箱/社媒账号轮换、每账号 daily cap、lead timezone send window。
- 回复进入共享 Inbox，真实回复会自动暂停该 lead 的后续触达。
- 官方称域名 reputation signal 触发时可暂停；也提供第三方 warmup，条款明确 warmup credentials 会交给第三方 provider。[Terms §14](https://origami.chat/terms)
- v2 API 支持 campaign 的创建、编辑、launch/send、pause/resume、stats，以及 sequence 的读、stop、delete。[对象模型](https://docs.origami.chat/agents/objects)

Webhooks 当前只覆盖 Sequencer 事件：

| 事件 | 语义 |
|---|---|
| `sequence.message.sent` | Email/LinkedIn DM 已发送 |
| `sequence.reply.received` | 入站回复匹配到序列 |
| `sequence.connection.requested` | LinkedIn 邀请已发出 |
| `sequence.connection.accepted` | LinkedIn 邀请已接受 |

官方[Webhooks 文档](https://docs.origami.chat/webhooks/overview)说明它仍是 beta，采用签名事件、at-least-once 交付和最多 10 次尝试；消费者必须用稳定 `webhook-id` 去重。

**冲突**：官方 `origami-webhooks`/`origami-api-v2` Skill 与 v2 OpenAPI 提到 `table.run.completed`，声称 `enrich=true` 的 API enrichment batch 可收到完成事件；但公开 [Webhooks overview](https://docs.origami.chat/webhooks/overview)和 [openapi-webhooks.yaml](https://github.com/Origami-Agents/mintlify-docs/blob/main/openapi-webhooks.yaml)的事件 catalog 没有它。Agent/UI table run 和 Agent run 完成即使按 Skill 说法也仍需轮询。生产实现应把 `GET enrichment run/table run` 轮询作为可靠路径，只有真实账户 canary 验证后才启用该 webhook。

### CRM 冲突

- **营销事实**：[AI Prospecting](https://origami.chat/products/ai-research-agents)写可以 push to HubSpot or Salesforce。
- **正式文档事实**：[CRM Integrations](https://origami.chat/docs/crm-integrations)写当前 Attio、Salesforce、HubSpot 仅 read-only，用于 dedupe/filter 和生成 CRM schema/knowledge context；write-back 仍在考虑。
- **结论**：OpenWork 不应承诺 Origami CRM 回写。现阶段把它视为 read-only context/dedupe，实际 write-back 走已有 CRM MCP/API，并保持单独审批和幂等键。

## 5. Agent API、Skill 与 MCP 边界

### 5.1 API 是正式可调用面，但 v2 仍为 beta

- Base URL：`https://origami.chat/api/v2`。[Terms 定义](https://origami.chat/terms)
- Auth：Bearer API key；没有 API 权限的套餐返回 `402 SUBSCRIPTION_REQUIRED`。[Authentication](https://docs.origami.chat/authentication)
- API key 是 parent-wide；`x-origami-project` 把请求限定到 child project。Project 可设 `monthlyCredits` 上限，但仍共享 parent wallet 和并发池。[对象模型](https://docs.origami.chat/agents/objects)
- 当前 OpenAPI/官方 Skill 还支持 project `enforcement=hard|soft` 与 `usage.spent/reserved`；`hard` 可阻止超预算的新消耗。这是 Origami credits 原生治理，不等同 OpenWork 的 USD 预算或供应商账单。[OpenAPI v2](https://github.com/Origami-Agents/mintlify-docs/blob/main/openapi-v2.yaml)
- Rate limit：每 IP 300 req/min、每组织 100 req/min；Agent 并发 Starter 1、Pro 3、Scale 10、Ultra 20、Enterprise unlimited。[Authentication](https://docs.origami.chat/authentication)
- Run 是异步对象；超并发返回 `429` 和 `Retry-After`。API 支持资源化 JSON、cursor pagination、对象 ID 关联。[对象模型](https://docs.origami.chat/agents/objects)
- Scheduled Agent 有 CRUD、enable/disable、manual trigger 和 run history；创建后默认 disabled。[官方 API 索引](https://docs.origami.chat/llms.txt)
- 官方 OpenAPI 与文档源码在公开的 [Origami-Agents/mintlify-docs](https://github.com/Origami-Agents/mintlify-docs) 仓库，许可证 MIT；这只授权文档/规范代码，不授权 Origami 服务或第三方数据的转售。

### 5.2 官方已经给 Agent Skill，不需要我们重写 Origami adapter 知识

官方 [Skill manifest](https://origami.chat/skills/manifest.json) 当前列出：

| Skill ID | 核查时版本 |
|---|---|
| `origami-api-v2` | `4cbd6245c2148f8c` |
| `origami-list-building` | `4599c57125e955c8` |
| `origami-sequencer` | `b15e90e7b3eafcb4` |
| `origami-scheduled-agents` | `60c258492e0814b4` |
| `origami-webhooks` | `794283e88ef8aff9` |

[官方安装器](https://origami.chat/skills/install.sh)支持 Cursor、Claude、Codex 和 `.agents` 目录；[安装文档](https://docs.origami.chat/agents/skill)给出使用方式。OpenWork 若支持 Origami，应**拉取并锁定官方 Skill 版本，再通过通用 REST/API capability 调用**，不要复制 endpoint 说明到自有 Skill 后长期漂移。

### 5.3 Origami 没有公开的第一方 MCP Server

截至核查日：

- 官方 API 索引、Skill manifest、产品页和公开 GitHub 中未发现类似 `https://mcp.origami...` 的第一方 MCP endpoint。
- [Privacy Policy](https://origami.chat/privacy-policy)说明用户可把 custom MCP server 接入 Origami，代表 **Origami 可以消费外部 MCP**；它不等于 **Origami 向外提供 MCP**。
- 因此 OpenWork 接 Origami 的现实路径是 **官方 Skill + REST API v2**，不是等待一个不存在的公开 MCP。

“未发现”是基于公开官方材料的否定性结论；Enterprise 私有能力可能存在，需向 `hello@origamiagents.com` 书面确认。

## 6. 价格与计费冲突

截至核查日，[公开 Pricing](https://origami.chat/pricing)为：

| Plan | 公开价格 | Credits | Model / 主要限制 |
|---|---:|---:|---|
| Free | $0 | 1,000 一次性 | Lite；20 Agent messages；1 workspace；每表 30 rows；不可付费联系人/CSV/Sequencer/API |
| Starter | $29/mo | 2,000/mo | Lite；40 workspaces；10 个 workspace 并行；联系人、CSV、Sequencer |
| Pro | $129/mo | 9,000/mo | Max；200 workspaces；20 并行 |
| Scale | $499/mo | 40,000/mo | Max；1,000 workspaces；50 并行；Slack support |
| Enterprise | Custom | Custom | unlimited 并行；SSO/SCIM/SLA |

需要在产品里显式标红的冲突：

| 议题 | 营销页 | 正式条款/文档 | 处理原则 |
|---|---|---|---|
| Sequencer sender 费用 | “unlimited”“no per-mailbox fee” | Paid plan 含若干免费 Senders，额外 Sender 按月收费；DFY mailbox/domain 另收费。[Terms §6](https://origami.chat/terms) | 以账户 Billing/Checkout 为准，报价前 live fetch |
| 什么消耗 credits | Pricing 写“Only data costs credits”，聊天/transform/export free | Terms 把 AI columns、web research、message generation、Agent/API runs 也列为 billable actions | 在执行前调用账户/credits 接口并展示预计上限，不能硬编码营销口径 |
| CRM write-back | 产品页称 push 到 HubSpot/Salesforce | CRM docs 写 read-only，write-back considering | 当前按 read-only 建模 |
| Source 数量 | 产品页 15+ | Guide 50+ | 不用总数评估；用具体 source、覆盖率和任务试跑 |
| 套餐 | 公开价格页无 Ultra | Terms 与 Sequencer 页面列出 Ultra | 视为非公开/账户内套餐，不能据此报价 |
| API entitlement | Auth 文档列出各套餐 Agent 并发数 | 公开 Pricing 没写 Starter/Pro/Scale 哪些包含 API；Terms 只说 eligible paid plan | 连接前调用 `/account`/实测 `402`，采购前要求书面确认 |

其他正式计费事实：credits 活跃付费账户通常约三个 billing cycles 后过期，free/lapsed 约 60 天；overage 可设上限；未用 credits 通常不退款；API 需要 eligible paid plan。[Terms §6–7](https://origami.chat/terms)

## 7. 法律与产品化边界

Origami 的法律边界会直接决定 OpenWork 的接法：

- 服务许可仅限客户内部业务使用，non-transferable、non-sublicensable。[Terms §5](https://origami.chat/terms)
- 不得 resell、sublicense、time-share 或向第三方提供 Service/API，除非书面授权。[Terms §12, §16](https://origami.chat/terms)
- 第三方数据仅限 internal GTM；不得再销售、再分发或用来构建竞争数据产品。[Terms §11](https://origami.chat/terms)
- 客户是 controller，Origami 是 processor；客户承担 notice、consent、opt-out/deletion、anti-spam、suppression 和平台条款责任。[Terms §11–13](https://origami.chat/terms)
- Origami 明确不是 system of record；客户需要自行保留重要数据。[Terms §10](https://origami.chat/terms)
- AI output、联系人数据、准确性、送达和结果都没有保证。[Terms §8, §25](https://origami.chat/terms)

**结论**：

1. OpenWork 可以提供 **BYO Origami account/API key** 的内部 GTM 编排，但仍要让最终客户接受其条款。
2. OpenWork 不应默认把 Origami credits 包装成自己的 managed credits，也不应 white-label、转售数据或把 API 开放给下游客户。
3. 若要 agency/multi-client/embedded 模式，必须向 Origami 取得明确的 reseller/embedded/API 书面授权和数据处理条款。
4. 对 managed contact credits，更清晰的候选是公开提供 reseller agreement/sub-API accounts 的 FullEnrich，见第 9 节。

## 8. OpenWork 当前基线：已经有什么

基于本工作树的 [README](./README.md)、[核心 Skill](./skills/agentic-outreach/SKILL.md)、[Domain Context](./CONTEXT.md)和[开源复用账本](./OPEN_SOURCE.md)：

### 已实现且方向正确

- `search_capabilities` / `execute_capability` 是真实能力轨道，可把外部 MCP/API 融合到统一调用面，不需要把 provider SDK 塞进插件；广搜只返回轻量摘要，执行前再读取一个精确 schema。
- 组织连接目录已经提供 Apollo 与 FullEnrich 官方远程 MCP 的一键 OAuth 预设；Exa 继续使用 API-key MCP，Activepieces 因实例 URL 不同而保持自定义连接。
- Skill 强制 live evidence、`source_url + observed_at`、先资格判断后付费联系人、Contact Purchase Approval 与 Launch Approval 两次审批。
- 联系方式购买优先外部 managed waterfall；OpenWork 不实现 provider order，只冻结外部 capability、成功计费语义、first-verified stop rule、eligible Lead 集合和 plan hash。
- `run.json` 已同时治理 billing currency 与 provider-native meter，包含 quote snapshot、worst case、reservation、actual 与 remaining；联系人批准同时绑定两套上限。
- Campaign Launch Approval 已绑定 content、audience、sender、live provider contract 与 monitor plan 五份 SHA-256；发送前重新读取外部对象和 schema，关闭审批后被篡改的 TOCTOU 缺口。
- reply/delivery 由外部 durable flow 执行；OpenWork 记录 `event_received` / `event_applied`、稳定 fingerprint、cursor、暂停证明、Handoff 和可验证的 outcome attribution。
- `dashboard.md` 已成为由 Run、Ledger 与 append-only events 派生的 buyer-facing Control Center，展示 funnel、freshness、双账本、完整性、外部引用、monitor health 与 cost per positive reply。

### 当前仍未成为完整生产商品

- Apollo/FullEnrich OAuth 入口与外部执行契约已实现，但没有客户凭据，尚未跑真实 paid-contact、sender 或 CRM production mutation；Fraimz 使用确定性 provider stand-in 证明真实应用路径，不冒充供应商 E2E。
- 没有持续发现新购买信号的 Signal Watch、time-bounded recurring policy 与 Opportunity Inbox；当前研究仍由一次性 Outreach Run 发起。
- 没有统一 Campaign 列表、共享 Inbox、sender-health 面板或组织级 suppression system of record；单个 Run 只持有自己的可审计状态。
- 没有托管 credits、机构/客户子账户、审批角色、统一账单与 reseller 合同；当前正确边界仍是 BYO provider。
- CRM writeback 只定义了授权与幂等协议；没有用户指定 CRM、对象、匹配键和字段时，系统只生成本地 Handoff。
- Activepieces/Exa 的 schedule、webhook 与 Tables 可以组成常驻执行层，但 OpenWork 还没有把它们产品化成经过批准、可暂停、可到期、可晋升为 Outreach Run 的 Signal Watch。

**推断**：OpenWork 的治理协议和真实 UI 证明已经超过“纸面规范”，但生产商品仍取决于真实账户 canary、持续 Signal Watch、组织级 suppression/CRM 上下文和团队治理。买家不会为协议文本付费，他们会为“持续出现新机会、花费可控、一次批准不越权、回复可归因”付费。

## 9. 按商业付费价值排序的 Gap List

排序依据不是开发难度，而是客户愿意持续付费的强度。

| 排名 | 商业 gap | 为什么有人付费 | OpenWork 应拥有 | 应复用的外部能力 |
|---:|---|---|---|---|
| 1 | **已验证联系人 coverage + 成功计费 waterfall** | 找不到正确 email/phone，前面所有研究都无法变现；客户愿意为命中率、少退信和失败不收费买单 | 统一 contact request/receipt、审批、预算、provider provenance、结果归一和效果统计 | 首选 [FullEnrich MCP](https://help.fullenrich.com/en/articles/14190120-mcp-server)/API；已有 Apollo 客户可直接用 [Apollo MCP](https://docs.apollo.io/docs/apollo-mcp)；不要自建联系人库/验证器 |
| 2 | **可交付的发送与回复闭环** | 发件账号、warmup、轮换、daily cap、bounce/reply/unsubscribe 比生成文案难得多 | Launch Approval、幂等 enrollment、跨 provider 抑制、reply normalization、handoff | 邮件优先复用 [Instantly API](https://developer.instantly.ai/) 或客户现有 sequencer；Apollo 用户直接走 MCP sequence；长尾经 Activepieces persistent flow |
| 3 | **长尾实时信号与可引用证据** | 传统 B2B 库的静态 title/company 不够形成购买时机；新鲜、稀缺信号直接提升回复率 | Evidence schema、freshness、source citation、qualification-before-spend、跨源去重 | 优先 [Exa Agent/Websets MCP](https://exa.ai/docs/reference/websets-mcp)；公开网页 fallback 用 Firecrawl MCP/workflows；不要自建 crawler |
| 4 | **一键可用的 provider bundle 与 preflight** | 用户不愿自己猜该接哪个工具、权限是否足够、哪一步会扣费 | 推荐组合、OAuth/API key connection、sample dry run、capability/schema/credit/sender readiness 页面 | 直接注册第一方 MCP；没有 MCP 的 provider 通过 Activepieces；Origami 用官方 Skill + REST |
| 5 | **durable signal monitor + webhook/reply state machine** | “今天跑一次”价值有限，持续监测招聘/融资/换职并及时触达才形成订阅 | Run state、schedule、event dedupe、retry、resume、budget window、human handoff | v1 复用 Activepieces durable flows；Exa Websets webhooks；只有证据证明不够时才引入 Hatchet |
| 6 | **CRM context、去重与安全回写** | 避免打到客户/已流失/正在销售中的联系人；将 outcome 回到真实系统 | CRM schema context、dedupe rules、suppression、审批后的幂等 writeback | 直接使用 HubSpot/Salesforce/Attio 第一方 MCP/API 或 Activepieces；不要经 Origami 承诺 writeback |
| 7 | **团队/代理商治理与 managed credits** | 多客户预算、审批人、审计、成本归因决定 agency/enterprise 能否采购 | project isolation、RBAC、USD + provider-credit 双账本、per-client cap、reserved spend、invoice reconciliation、data retention | 优先选择公开支持 embedded/reseller 的 provider；有真实付费需求后再加 OpenMeter；Origami 需另签授权 |
| 8 | **统一 Campaign/Inbox 体验与 ROI analytics** | 运营人员需要看 coverage、成本、sent/reply/positive/bounce 和下一步，而不是读 NDJSON | review UI、shared inbox、provider-neutral metrics、cost per qualified verified contact/positive reply | 数据仍从外部 sequencer/CRM 拉；OpenWork 只做统一视图和控制，不复刻 sender infrastructure |

### 最小可售版本

最小可售版本不应该试图复刻 Origami 全栈。应该只把前三个 gap 跑通：

```text
Exa/Firecrawl 发现实时证据
  → OpenWork 资格判断 + Contact Purchase Approval
  → FullEnrich/Apollo 购买 verified contact
  → OpenWork Launch Approval
  → Instantly/Apollo/客户 sequencer 发送
  → Activepieces/webhook 同步 reply、bounce、unsubscribe
  → OpenWork 统一 ledger、handoff、cost/outcome
```

这条链中 OpenWork 只拥有治理和语义层：**Evidence、Qualification、Approval、Budget、Idempotency、Suppression、Run、Handoff**。所有易变 provider logic 都在 MCP/API/Activepieces 后面。

## 10. 最重要的产品/服务：采购与接入顺序

### 1. Apollo MCP：最快补齐标准 B2B 全链条

[Apollo 官方 MCP](https://docs.apollo.io/docs/apollo-mcp)提供远程 Streamable HTTP + OAuth，endpoint 为 `https://mcp.apollo.io/mcp`；官方页面当前称 240M+ contacts，并支持公司/人员搜索、enrichment、job postings、contacts/lists、sequence、enrollment、单发邮件和 analytics。People search 不返回完整联系方式，需明确调用 enrichment，正好符合“先筛选、再付费”的原则。

**用法**：作为默认 corporate B2B bundle；直接注册第一方 MCP，不写 Apollo adapter。若 OpenWork 做公开集成/多租户，走 Apollo 的 partner OAuth/marketplace 流程，不共享客户 API key。

### 2. Exa Agent/Websets MCP：实时开放 Web 与长尾实体

[Exa Websets MCP](https://exa.ai/docs/reference/websets-mcp)可创建/预览实体集合、异步搜索、结构化 enrichment、CSV import 和 webhook；官方现建议多数 Agentic list-building 优先使用主 Exa MCP 的 Agent tools。它适合找“数据库里没有、但网页上现在发生”的公司/人员/事件，并保留来源。

**用法**：做 live discovery/evidence，不把 Exa 当联系人真值或发送器。OpenWork 已有 Exa capability rail 证据，应先把基本 search 升级成 outreach-specific Websets/Agent 模板和 webhook 流程。

### 3. FullEnrich MCP/API：最适合联系方式 waterfall 与嵌入商业化

[FullEnrich MCP](https://help.fullenrich.com/en/articles/14190120-mcp-server)支持搜索、批量 enrichment、CSV/JSON 导出，远程 endpoint `https://mcp.fullenrich.com/mcp`；搜索先免费预览，enrichment 前会确认。其[公开 Pricing](https://fullenrich.com/pricing)称 25+ source waterfall，work email 1 credit、mobile 10、personal email 3，并明确 Scale 面向“products embedding FullEnrich”，提供 reseller agreement 和 sub-API accounts。

**用法**：BYO 模式直接 MCP；managed credits/embedded 模式优先谈 FullEnrich reseller，而不是默认转售 Origami。

### 4. Instantly API：把邮件 deliverability 交给专门系统

[Instantly SuperSearch](https://help.instantly.ai/en/articles/11364248-supersearch)也覆盖联系人/信号，但它更值得买的部分是发送账号、warmup、campaign 和 deliverability；[Warmup 文档](https://help.instantly.ai/en/articles/5975329-how-warm-up-works-and-why-it-s-important)与[开发者 API](https://developer.instantly.ai/)给出专门执行面。

**用法**：没有合适第一方 MCP 时，通过 Activepieces 或其 API；OpenWork 不实现 SMTP rotation、warmup 或 sender reputation 引擎。联系人数据转售仍需遵守 Instantly 自身条款。

### 5. Clay MCP：给高级 GTM Ops 的可配置底座

[Clay](https://www.clay.com/use-cases/data-enrichment)公开称 200+ providers、waterfall、AI web research、signals、CRM sync 和 native sequencer；[Clay MCP](https://university.clay.com/docs/mcp-settings)让管理员控制 rep、credit limits 与可调用 Functions。

**用法**：对已经使用 Clay 或需要高度自定义 waterfall/Functions 的企业，直接接 MCP；OpenWork 不应再造 Clay 的可视化表格/瀑布配置器。Clay 强大但配置和成本心智更重，不必作为所有客户的默认依赖。

### 6. Origami Skill/API：全栈 benchmark 与 BYO 备选，不是默认嵌入底座

Origami 最接近“一家把全链都包了”的产品；对想快速得到完整体验的 BYO 客户，它可由[官方 Skill](https://docs.origami.chat/agents/skill) + API v2 接入。问题是 v2/webhooks 仍 beta、没有公开 MCP、正式条款限制转售/第三方 API 提供，且 CRM 与 sender 定价有文档冲突。

**用法**：作为客户自有账户的可选 end-to-end provider、竞品基准和试验平台。只有拿到书面 embedded/reseller 权利后，才考虑作为 OpenWork managed backend。

## 11. 推荐的产品决策

1. **不要造数据源、crawler、verifier、sequencer 或 CRM adapter。** 继续坚持 capability seam。
2. **先做三套经过验证的 connection recipe**：
   - `Apollo only`：标准 B2B 的搜索 → 联系人 → sequence。
   - `Exa + FullEnrich + Instantly`：长尾实时信号 → waterfall 联系人 → 邮件执行。
   - `Clay customer-owned`：高级团队复用其现有 provider/Functions。
3. **将 provider capability 标准化成少量业务 contract，而不是统一所有 API**：`discover_entities`、`fetch_evidence`、`quote_contact`、`acquire_contact`、`create_campaign`、`enroll`、`list_replies`、`suppress`。实际 schema 仍由 `search_capabilities(detail=schema)` live 获取。
4. **建立 outreach preflight**：连接状态、计划权限、credits、联系人成功计费语义、sender、webhook、CRM、suppression source，一次性可见并可试跑。
5. **把付费联系人做成原子闸门**：审批前禁止创建/运行 contact enrichment column；审批后只对冻结 audience 的 row 执行，并同时记录 credits cap、USD 换算快照、actual credits 和 provider reference。
6. **Launch 前重新读取并 hash**：保存 provider campaign ID、audience hash、完整内容 hash、官方 Skill manifest hash 与 API schema version。外部对象与审批快照不一致就作废审批，不能只信本地 `campaign_revision`。
7. **第一阶段只做 BYO provider**。Managed credits 等到 FullEnrich/Apollo/Origami 等书面商业协议和真实采购量成立后再做，避免法律和现金流陷阱。
8. **保存 OpenWork 自己的证据与审计账本**。所有 provider 都不是 system of record；provider 输出需落成可导出的 provenance、spend 和 outcome。

## 12. 品味自检

- **KISS/YAGNI**：没有建议自建五个已成熟的基础设施，只补 OpenWork 的治理闭环和接入体验。
- **DIP/OCP**：领域协议依赖 capability contract，不依赖 Apollo/Exa/FullEnrich 的具体 SDK；新增 provider 不改核心 Run 语义。
- **SRP**：发现、联系人购买、触达、CRM 分属外部能力；OpenWork 只负责证据、资格、审批、预算、状态和交接。
- **风险隔离**：营销声明、正式文档冲突和法律限制均单独标记；没有把“provider verified”说成“保证可达”。
- **数据最小化**：先资格判断再购买联系方式，减少不必要的个人数据处理和费用。

## 13. 一手来源索引

Origami：

- [AI Prospecting](https://origami.chat/products/ai-research-agents)
- [Pricing 与联系人 waterfall](https://origami.chat/pricing)
- [Sequencer](https://origami.chat/products/sequencer)
- [CRM Integrations](https://origami.chat/docs/crm-integrations)
- [Terms of Service（2026-06-29）](https://origami.chat/terms)
- [Privacy Policy](https://origami.chat/privacy-policy)
- [API docs index](https://docs.origami.chat/llms.txt)
- [v2 objects](https://docs.origami.chat/agents/objects)
- [Authentication / rate limits](https://docs.origami.chat/authentication)
- [Webhooks](https://docs.origami.chat/webhooks/overview)
- [Official Skill](https://docs.origami.chat/agents/skill)
- [Skill manifest](https://origami.chat/skills/manifest.json)
- [Official GitHub docs/OpenAPI](https://github.com/Origami-Agents/mintlify-docs)

可复用外部能力：

- [Apollo MCP](https://docs.apollo.io/docs/apollo-mcp)
- [Exa Websets MCP](https://exa.ai/docs/reference/websets-mcp)
- [FullEnrich MCP](https://help.fullenrich.com/en/articles/14190120-mcp-server) · [Pricing/embedded](https://fullenrich.com/pricing)
- [Clay data enrichment](https://www.clay.com/use-cases/data-enrichment) · [Clay MCP](https://university.clay.com/docs/mcp-settings)
- [Instantly API](https://developer.instantly.ai/) · [SuperSearch](https://help.instantly.ai/en/articles/11364248-supersearch)
