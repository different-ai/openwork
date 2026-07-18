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
- A resumable run ledger with provider references, actual spend, replies, and handoff state.

The plugin does not ship a scraper, enrichment database, email verifier, or sequencer. It discovers the organization's current MCP/API capabilities at runtime and calls the selected provider's exact schema. Direct provider MCPs are preferred; Activepieces is the long-tail Adapter for providers that do not expose a suitable first-party MCP.

## Architecture

The core **Module** is the Outreach domain protocol in one Skill. Its public **Interface** is deliberately small: a natural-language request plus OpenWork's `search_capabilities` / `execute_capability` rail. `CapabilityMatch` is the **Seam**; direct MCPs and Activepieces are **Adapters** behind it. That gives the Module **Depth**: one workflow hides qualification, two approvals, budget math, provenance, idempotency, and reply handoff without leaking vendor branches into the caller. Provider changes stay local to capability selection, preserving **Locality**; the same rail gives high **Leverage** across every connected provider.

Two rejected designs clarify the boundary:

- Embedding provider SDKs would offer tighter compile-time integration but create credential handling, schema drift, duplicated retries, and vendor-specific release work inside OpenWork.
- Separate Apollo/Exa/Instantly Skills would ship quickly but scatter the same budget, approval, provenance, and resume rules across shallow modules.

The chosen design centralizes durable business invariants and leaves volatile provider execution outside the product. Managed waterfalls such as a connected FullEnrich- or Origami-class capability are preferred when their contract exposes verification and result-based billing. A customer-owned Activepieces flow is the fallback composition seam; OpenWork does not become the waterfall.

Every paid-contact decision freezes a canonical plan and eligible-audience hash. Every launch freezes content, audience, sender, and provider-contract hashes and verifies them again immediately before sending. This closes the gap between “the user approved something” and “the provider received exactly what was approved.”

## Install

Import this GitHub plugin directory through OpenWork's plugin marketplace flow, or point the Claude-compatible plugin importer at:

```text
plugins/agentic-outreach
```

The OpenWork Cloud Control MCP connection must be available to the worker. Add or authorize the external providers your organization chooses; the plugin reports the exact human action when a connection is missing.

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
- `run.json`: authoritative current state, native/currency budgets, frozen plan hashes, approvals, and external references.
- `events.ndjson`: append-only intent/result journal with input/result hashes for safe resume and dedupe.
- `handoff.md`: replies, paused leads, owner, and next action.

No contact purchase or external send occurs without explicit approval in the current conversation.
