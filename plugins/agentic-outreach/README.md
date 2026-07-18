<!--
[INPUT]: 依赖插件清单、agentic-outreach Skill 与 OpenWork 的插件导入/能力轨道
[OUTPUT]: 对外提供 Agentic Outreach 的价值说明、商业护栏、安装前提、运行流程和产物索引
[POS]: agentic-outreach 插件的产品入口，面向购买者解释结果与控制权而非供应商实现
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->
# Agentic Outreach

Turn a B2B target into an evidence-backed, approval-controlled outreach run without copying data-provider or sequencer logic into OpenWork.

## What the buyer gets

- Live prospect evidence with source URLs and observation timestamps.
- Qualification before any paid contact lookup.
- A managed contact-waterfall preference without reimplementing provider logic.
- Native provider credits and billing currency tracked as separate approved ledgers.
- A worst-case cost preview and hash-bound approval before contact purchase.
- A short, evidence-grounded sequence with suppression, dedupe, and unsubscribe controls.
- A second approval bound to exact content, audience, sender, and live provider contract.
- A buyer-facing Control Center showing state, funnel, spend, integrity, outcomes, and next action.
- A durable external reply monitor with event dedupe, pause-before-handoff, cursor-safe resume, and optional authorized CRM writeback.
- A resumable Run ledger with provider references, actual spend, replies, attributed outcomes, and cost per positive reply.

The plugin does not ship a scraper, enrichment database, email verifier, or sequencer. It discovers the organization's current MCP/API capabilities at runtime and calls the selected provider's exact schema. Direct provider MCPs are preferred; Activepieces is the long-tail Adapter for providers that do not expose a suitable first-party MCP.

## Architecture

The core **Module** is the Outreach domain protocol in one Skill. Its public **Interface** is deliberately small: a natural-language request plus OpenWork's `search_capabilities` / `execute_capability` rail. `CapabilityMatch` is the **Seam**; direct MCPs and Activepieces are **Adapters** behind it. That gives the Module **Depth**: one workflow hides qualification, two approvals, budget math, provenance, idempotency, and reply handoff without leaking vendor branches into the caller. Provider changes stay local to capability selection, preserving **Locality**; the same rail gives high **Leverage** across every connected provider.

Two rejected designs clarify the boundary:

- Embedding provider SDKs would offer tighter compile-time integration but create credential handling, schema drift, duplicated retries, and vendor-specific release work inside OpenWork.
- Separate Apollo/Exa/Instantly Skills would ship quickly but scatter the same budget, approval, provenance, and resume rules across shallow modules.

The chosen design centralizes durable business invariants and leaves volatile provider execution outside the product. Managed waterfalls such as a connected FullEnrich- or Origami-class capability are preferred when their contract exposes verification and result-based billing. A customer-owned Activepieces flow is the fallback composition seam; OpenWork does not become the waterfall.

Every paid-contact decision freezes a canonical plan and eligible-audience hash. Every launch freezes content, audience, sender, provider-contract, and monitor-plan hashes and verifies them again immediately before sending. This closes the gap between “the user approved something” and “the provider received exactly what was approved.”

After a proven launch, an approved external monitor handles webhooks and scheduled fallback. OpenWork deduplicates provider events, applies sender suppression before advancing the cursor, and attributes replies, meetings, opportunities, wins, and revenue only when an external reference proves them. CRM writeback is forbidden unless the Brief names the CRM, match key, and writable fields or the user separately approves it.

## Install

Import this GitHub plugin directory through OpenWork's plugin marketplace flow, or point the Claude-compatible plugin importer at:

```text
plugins/agentic-outreach
```

The OpenWork Cloud Control MCP connection must be available to the worker. Add or authorize the external providers your organization chooses; the plugin reports the exact human action when a connection is missing.

## Fastest path to first value

An organization admin can now find **Apollo** and **FullEnrich** directly in OpenWork Connections and complete their official browser OAuth flows—no API-key plumbing or local server. The recommended bundle is intentionally replaceable:

- **Exa** or Firecrawl Skills for current public evidence;
- **FullEnrich MCP** for managed, waterfall-verified contact acquisition, or **Apollo MCP** when the customer already runs Apollo and wants one account for search, enrichment, records, and sequences;
- **Instantly API** through the customer's Activepieces connection for specialized email delivery and reply events, or Apollo's own sequence tools when they fit;
- **Activepieces MCP** as the customer-owned long-tail Adapter for instance-specific APIs, schedules, and webhooks.

When FullEnrich is selected, preview and import its maintained [official Skills](https://github.com/FullEnrich/fullenrich-skills) rather than copying its credit checks or tool guidance. Activepieces has a customer-instance-specific MCP URL, so it stays a custom connection instead of a misleading global preset.

## Run

Use `/outreach` followed by a target and constraints, for example:

```text
/outreach Find 50 US Series B security companies that hired compliance leaders in the last 30 days. Buy only verified VP+ emails, cap spend at $25, and never send without my approval.
```

Each run lives under `.openwork/outreach/<run-id>/`:

- `brief.md`: frozen ICP, signal, budget, exclusions, and approval policy.
- `lead-ledger.csv`: evidence, qualification, contact state, cost, and provider provenance.
- `campaign.md`: subjects, touches, evidence bindings, suppression rules, and launch plan.
- `dashboard.md`: derived Outreach Control Center for funnel, dual-ledger spend, approvals, integrity, outcomes, and next action.
- `run.json`: authoritative current state, native/currency budgets, frozen contact/Campaign/monitor hashes, approvals, event cursor, attributed outcomes, and external references.
- `events.ndjson`: append-only intent/result journal with input/result hashes for safe resume and dedupe.
- `handoff.md`: deduped reply evidence, pause/suppression proof, CRM policy, owner, unit economics, and next action.

No contact purchase or external send occurs without explicit approval in the current conversation.
