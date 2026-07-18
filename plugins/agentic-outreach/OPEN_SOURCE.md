<!--
[INPUT]: 依赖上游官方仓库、官方 MCP 文档、许可证原文、2026-07-18 活跃度检查与 2026-07-19 Origami 官方基准
[OUTPUT]: 对外提供 Outreach 开源复用清单、采用/延后/规避决策和商业产品假设
[POS]: agentic-outreach 的持续研究账本，防止重复造轮子与许可证误用
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->
# Open-source and commercial research

Checked: **2026-07-18 (Asia/Shanghai)**. Activity dates below refer to the latest default-branch commit observed through the official GitHub API on that date, not a guarantee of future maintenance.

## Executive decision

The first version should compose existing providers, not become another enrichment database or workflow engine:

1. Prefer a direct first-party MCP/API Adapter for latency, fidelity, and fewer failure domains.
2. Use Activepieces MCP for long-tail one-off actions and durable scheduled/webhook flows.
3. Import Firecrawl's maintained lead-generation and lead-research Skills instead of copying their scraping playbooks.
4. Keep AGPL/BSL/source-available systems outside the product boundary unless their hosted API or MCP is called as an external service.
5. Defer a native durable runtime until product evidence proves Activepieces is insufficient.
6. Prefer an external managed contact waterfall over composing providers; only use a customer-owned Activepieces waterfall when no aggregate contract fits.

## Reuse matrix

| Project | 2026 activity observed | License boundary | Decision |
|---|---:|---|---|
| [Activepieces](https://github.com/activepieces/activepieces/commit/ecc9e843ce50) | 2026-07-17; release v0.86.3 | [Core MIT; enterprise directories excluded](https://github.com/activepieces/activepieces/blob/main/LICENSE) | **Adopt** as the long-tail action and durable-flow Adapter. |
| [Firecrawl MCP server](https://github.com/firecrawl/firecrawl-mcp-server/commit/3eb1115b1f28) | 2026-07-08 | [MIT](https://github.com/firecrawl/firecrawl-mcp-server/blob/main/LICENSE) | **Adopt externally** for live public-web evidence when connected. |
| [Firecrawl workflows](https://github.com/firecrawl/firecrawl-workflows/commit/1a6b30273113) | 2026-06-19 | [ISC](https://github.com/firecrawl/firecrawl-workflows/blob/main/LICENSE) | **Import**, especially `firecrawl-lead-gen` and `firecrawl-lead-research`; do not rewrite them. |
| [Composio](https://github.com/ComposioHQ/composio/commit/c34401e35504) | 2026-07-16 | [SDK MIT](https://github.com/ComposioHQ/composio/blob/master/LICENSE); hosted backend/service remains external | **Optional Adapter** when an organization already uses Composio/Rube. |
| [Hatchet](https://github.com/hatchet-dev/hatchet/commit/bd056df4b7f7) | 2026-07-17 | [MIT](https://github.com/hatchet-dev/hatchet/blob/main/LICENSE) | **Defer**. It is a credible native durable runtime, but duplicates Activepieces in v1. |
| [OpenMeter](https://github.com/openmeterio/openmeter/commit/3885445fd4bf) | 2026-07-18 | [Apache-2.0](https://github.com/openmeterio/openmeter/blob/main/LICENSE) | **Defer** until managed credits and usage billing are implemented. |
| [Nango](https://github.com/NangoHQ/nango/commit/f6d7550332a9) | 2026-07-17 | [Elastic License 2.0](https://github.com/NangoHQ/nango/blob/master/LICENSE) | **Do not embed** in a competing managed connector product; use only as an external customer-owned service if selected. |
| [Pipedream](https://github.com/PipedreamHQ/pipedream/commit/c622c98b5271) | 2026-07-17 | [Source-available license](https://github.com/PipedreamHQ/pipedream/blob/master/LICENSE) restricting commercial/competitive use | **Do not embed**; an external hosted Adapter remains possible. |
| [Restate](https://github.com/restatedev/restate) | 2026-07-18 | [BSL 1.1](https://github.com/restatedev/restate/blob/main/LICENSE) with delayed conversion | **Defer/avoid for v1**; no need to accept its service restriction while Activepieces covers the seam. |

Firecrawl's core crawler is AGPL-3.0. The product should call its hosted service or MIT MCP server unless the deployment deliberately accepts the AGPL boundary.

Commercial contact data is intentionally not copied into OpenWork. The [Origami 2026 benchmark](./ORIGAMI_BENCHMARK_2026.md) found no public first-party Origami MCP and legal restrictions around reselling its service; use its official Skill/API with a customer-owned account unless a written embedded agreement exists. FullEnrich's official MCP and documented reseller/sub-account route make it the stronger managed-service candidate when the product, contract, and current pricing fit. These are procurement findings, not hard-coded dependencies.

## Why Activepieces is the leverage point

Activepieces' official MCP exposes discovery and execution primitives rather than forcing OpenWork to maintain hundreds of provider-specific branches:

- [`ap_research_pieces`](https://www.activepieces.com/docs/mcp/tools) finds integrations.
- `ap_get_piece_props` returns the current provider action contract.
- `ap_list_connections` resolves configured identities without exposing secrets.
- `ap_run_action` validates and executes a one-off action in a disposable flow.
- `ap_build_flow` creates persistent scheduled or webhook-driven work.
- Its [durable execution model](https://www.activepieces.com/docs/install/architecture/durable-execution) avoids replaying completed steps after worker failure.

Examples already present in the official catalog include [Apollo](https://www.activepieces.com/pieces/apollo) for people/company/job/news data and [Reply.io](https://www.activepieces.com/mcp/reply-io) for contacts, campaigns, and reply-aware status changes. These are examples, not hard dependencies.

## Commercial wedge

The buyer is not paying for “AI-written cold email.” They are paying for a controlled conversion from current market signal to a safe, send-ready opportunity:

- provenance for every qualifying fact;
- no paid contact spend before qualification;
- worst-case and actual spend visibility;
- provider-native credits and currency reconciled in separate ledgers;
- approvals cryptographically bound to the exact plan, audience, content, sender, and live contract;
- cost per qualified contact, not just number of rows;
- explicit purchase and launch gates;
- resume without duplicate charges or sends;
- reply-driven pause and human handoff.

Packaging hypothesis to validate with usage data:

- **Starter:** bring-your-own providers, manual runs, evidence ledger.
- **Pro:** scheduled signal monitoring, managed credits, reply synchronization, cost analytics.
- **Team:** shared budgets, approval roles, suppression lists, CRM handoff.
- **Enterprise:** self-hosting, data residency, audit export, organization policy.

These tiers are product hypotheses, not implemented entitlements.

## Refresh protocol

Before a major architecture or procurement decision, refresh this file if it is older than 30 days:

1. Check the official repository's default-branch commit and latest release.
2. Re-read the repository's current license text; do not trust a package badge.
3. Re-read official MCP/API documentation for authentication, schemas, pricing semantics, and durable-execution claims.
4. Record the new checked date and what changed.
5. Keep a provider behind an Adapter even when it is currently preferred.
