<!--
[INPUT]: 依赖 Agentic Outreach 的产品边界与 B2B 外联阶段门
[OUTPUT]: 对外提供覆盖证据、瀑布计划、双账本、完整性审批与交接的统一领域词汇
[POS]: agentic-outreach 的 Ubiquitous Language，约束文档、Skill、账本和用户沟通使用同一含义
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->
# Agentic Outreach — Domain Context

## Ubiquitous Language

**Outreach Brief** — The frozen statement of target market, buyer persona, qualifying signal, freshness window, geography, exclusions, volume, budget, and approval policy for one run.

**Evidence** — A factual observation about a company or person with a source URL, observation time, provider, and confidence. An inference is labeled separately and never presented as evidence.

**Lead** — A company-person opportunity evaluated against the Outreach Brief. A company without a relevant persona may remain a company candidate but is not a sendable Lead.

**Qualification** — The evidence-backed decision that a Lead is `qualified`, `review`, or `rejected`. Qualification precedes paid contact acquisition.

**Contact Purchase** — A paid or quota-consuming provider action that returns a real contact channel. It is distinct from public research and requires Contact Purchase Approval.

**Contact Purchase Approval** — Explicit user consent covering provider, eligible Lead count, unit-price assumption, currency, and worst-case total. Silence and earlier general permission are not approval.

**Contact Plan** — The frozen external acquisition route for eligible Leads: managed waterfall, single provider, or customer-owned composed waterfall. It includes charging semantics, a first-verified stop rule, contract versions, and hashes for the plan and eligible Lead set.

**Native Meter** — The provider's actual billable unit, such as credits, lookups, or verified results. It is approved and reconciled separately from billing currency so exchange or plan assumptions cannot hide consumption.

**Campaign** — The approved audience, evidence-bound messages, timing, sender, suppression rules, and stop conditions for a run.

**Launch Approval** — Explicit user consent for a specific Campaign revision, audience count, sender, and schedule. Draft approval is not Launch Approval.

**Campaign Integrity** — SHA-256 identities for provider-ready content, sorted audience, sender, and live provider contract. A mismatch after approval invalidates Launch Approval before any send.

**Suppression** — A rule preventing contact or future messages because of unsubscribe, bounce, duplicate, exclusion, previous outreach, policy, or user instruction.

**Run** — The durable business record connecting one Outreach Brief to evidence, spend, approvals, external provider references, Campaign, replies, and Handoff.

**Action Key** — A stable identifier for one external mutation within a Run. It prevents accidental repeat purchase, duplicate CRM write, or duplicate send after retries or session restart.

**Reply State** — The normalized business outcome of a reply: `positive`, `negative`, `unsubscribe`, `out_of_office`, `bounce`, or `unknown`.

**Handoff** — The owner, context, reply state, evidence, and next action required after the automation pauses or completes.

**Control Center** — A derived, buyer-readable view of a Run's state, next action, funnel, evidence freshness, dual-ledger spend, approvals, Campaign integrity, external references, and outcomes. `run.json` remains authoritative.
