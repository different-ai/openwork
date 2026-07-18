<!--
[INPUT]: 依赖 2026-07-19 当前分支、Exa/Activepieces/Firecrawl 官方文档、上游仓库 release/license 元数据与 Origami 基准
[OUTPUT]: 对外提供下一商业模块的缺口审计、Signal Watch 复用边界、供应商事实与验证门
[POS]: agentic-outreach 的滚动产品决策记录，把一次性 Outreach Run 演进为持续机会订阅而不内建调度器、crawler 或表格引擎
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->
# Agentic Outreach ecosystem gap — 2026-07-19

## Decision

The highest-value next module is **Signal Watch → Opportunity Inbox → Promote to Outreach Run**.

The current product can govern one evidence-to-reply run. The missing subscription loop is continuous discovery: keep watching a market, surface only net-new evidence-backed opportunities, and let the user promote selected rows into the already-safe contact and launch pipeline. That is closer to a recurring revenue product than another enrichment column or copy generator.

OpenWork should own the policy and business state, not the execution infrastructure:

```text
Natural-language Watch request
  → OpenWork freezes query, schedule, expiry, spend, exclusions and policy hash
  → Activepieces persistent flow uses Schedule + Exa + Tables
  → live public-business evidence is deduped into an external Opportunity table
  → OpenWork syncs a derived Opportunity Inbox with provenance and unit economics
  → selected opportunities become ordinary Outreach Runs
  → Contact Purchase Approval and Launch Approval remain unchanged
```

## Current-state audit

Already proven on the current branch:

- live capability discovery with exact on-demand schemas;
- Apollo and FullEnrich organization OAuth presets;
- evidence, qualification-before-spend and managed contact-waterfall preference;
- separate native-unit and billing-currency ledgers;
- hash-bound contact and launch approvals;
- durable reply ingestion, event dedupe, pause-before-handoff and external attribution;
- real workspace/Artifact/cross-session proof through Fraimz.

Still missing:

- a time-bounded recurring research authorization;
- persistent live-signal execution before a Campaign exists;
- a cross-cycle opportunity identity and dedupe rule;
- a buyer-readable inbox of new, promoted, dismissed, stale and suppressed opportunities;
- pause, expiry and budget-exhaustion behavior for the external flow;
- inheritance from a watched opportunity into the existing Outreach Run without weakening either approval gate.

## Primary-source findings

### Exa

- [Websets](https://exa.ai/docs/websets/api-guide) supports criteria verification, enrichments, recurring monitors and webhooks; its guide was last modified 2026-06-26.
- The [Websets MCP](https://exa.ai/docs/reference/websets-mcp) can create/preview Websets, searches, enrichments and webhooks, but explicitly says scheduled monitors are **not currently exposed as MCP tools**.
- The Websets guide says Websets is not currently ZDR. A Watch should therefore store only necessary public business evidence by default and disclose the external provider; it must not request email/phone enrichments.
- Exa's official Activepieces piece exposes live search/content actions. It can be placed behind a Schedule trigger without adding an Exa SDK or monitor implementation to OpenWork: [Exa piece](https://www.activepieces.com/pieces/exa).

Decision: use the direct Exa MCP for one-off preview/research when suitable. For recurring v1 execution, let a customer-owned Activepieces flow call its current Exa piece. Do not hard-code Websets REST paths or API keys into OpenWork.

### Activepieces

- The official MCP [tools reference](https://www.activepieces.com/docs/mcp/tools) distinguishes one-shot `ap_run_action` from `ap_build_flow`, which is explicitly intended for persistent schedules and external events. It also requires discovering current piece props and connection IDs before execution.
- The official [Schedule piece](https://www.activepieces.com/pieces/schedule) provides timezone-aware daily/weekly/cron triggers.
- The official [Tables piece](https://www.activepieces.com/pieces/tables) provides record triggers plus create, update, get and find actions; it is sufficient as the external durable queue for v1.
- Upstream `activepieces/activepieces` released [0.86.3 on 2026-07-17](https://github.com/activepieces/activepieces/releases/tag/0.86.3). Its root license keeps core content MIT while excluding enterprise directories.

Decision: Activepieces owns scheduling, retries, connections and the operational table. OpenWork records only the exact flow/table references, piece/contract versions, policy hash, cursor and safe result projection.

### Live-web fallback

- `firecrawl/firecrawl` released [v2.11.0 on 2026-06-19](https://github.com/firecrawl/firecrawl/releases/tag/v2.11.0) and remained active on 2026-07-18.
- Firecrawl core is AGPL-3.0. Use its hosted API or MIT MCP server at the external boundary; do not copy the crawler into OpenWork.

Decision: Firecrawl remains a fallback for public pages Exa cannot cover, never a second default search on every cycle.

### Table/workbench candidates

| Project | 2026 evidence | License boundary | Decision |
|---|---|---|---|
| [Grist Core](https://github.com/gristlabs/grist-core) | v1.7.16 on 2026-06-30; active 2026-07-18 | Apache-2.0 | Credible optional external grid if customers demand formulas/collaboration; defer because OpenWork Artifacts plus Activepieces Tables cover the next proof. |
| [Baserow](https://github.com/baserow/baserow) | v2.3.2 on 2026-07-15; active 2026-07-18 | OSE core MIT; premium/enterprise excluded | Optional external record system, not a dependency for Signal Watch. |
| [NocoDB](https://github.com/nocodb/nocodb) | 2026.07.0 on 2026-07-14; license updated 2026-01-29 | Sustainable Use; internal/non-commercial limits | Do not embed into a competing commercial workbench. Customer-owned external use can remain possible. |

Decision: do not spend a release building or embedding another table UI. The customer pays for net-new opportunities and control, not for spreadsheet chrome.

## Signal Watch business contract

OpenWork owns these stable concepts:

- **Watch Policy** — ICP, signal, source/freshness rules, schedule/timezone, active window, exclusions, notification destination, retention and exact policy hash.
- **Watch Budget** — provider-native units and billing currency per bounded window, with hard stop and no silent renewal beyond the approved expiry.
- **Opportunity Fingerprint** — stable hash of watch, normalized company domain, signal type and provider event/source identity; receipt time is excluded.
- **Opportunity State** — `new`, `shortlisted`, `promoted`, `dismissed`, `stale` or `suppressed`.
- **External Execution Plan** — current Activepieces flow/table references, piece/contract versions, connection identities, next run and cursor.
- **Promotion** — creates a normal Outreach Run with copied evidence provenance and a parent Watch reference. It never purchases a contact or sends.

The activation approval must bind query/criteria, cadence/timezone, expiry, native/currency ceilings, data sink, notification behavior, retention, external contracts and policy hash. Any material change requires reapproval. Pausing or cancelling must disable the external flow before marking the local Watch inactive; ambiguous disable outcomes must be queried before retry.

## Non-negotiable privacy and safety boundary

1. A Watch may collect public company/person-role evidence required for qualification, but no private contact channel.
2. Exa/Websets `email` or `phone` enrichments are forbidden in Watch mode. Contact acquisition remains behind the existing Contact Purchase Approval.
3. No Watch can draft or launch a Campaign automatically. Promotion enters the existing workflow at evidence/qualification.
4. The external table is authoritative for durable scheduled results; the local Inbox is derived and records a cursor, not a second hidden scheduler.
5. A cycle exceeding budget, expiry, provider contract, evidence freshness or error thresholds auto-pauses and names the human repair action.
6. Notifications expose a safe summary and link/reference, not purchased contact data or credentials.

## Commercial wedge

Position the module as **Always-on buying-signal coverage**, not “scheduled search.” The buyer-facing proof should emphasize:

- net-new qualified opportunities this week;
- duplicates and stale rows avoided;
- evidence freshness and coverage;
- native units/currency consumed against the approved window;
- median signal-to-review time;
- promoted-to-qualified and promoted-to-positive-reply conversion;
- active/paused/expiring Watch state and the next human action.

Packaging should remain provider-neutral and BYO-first:

- Starter: one-time Runs and evidence ledger;
- Pro: bounded Signal Watches, Opportunity Inbox, reply monitoring and cost analytics;
- Team: shared policy approval, CRM suppression and ownership;
- Enterprise: data residency, retention controls, audit export and contracted managed credits.

Provider usage should pass through the customer's account until a written reseller/embedded agreement and real unit economics justify managed credits.

## Proof gate for implementation

The feature is not complete until a Fraimz journey proves:

1. a natural-language request becomes an exact, expiring Watch Policy without provisioning;
2. capability preflight shows current Schedule, Exa and Tables contracts plus budget/retention;
3. exact approval provisions only one persistent external flow and records stable external references;
4. a later cycle applies one new event exactly once and buys no contact;
5. Opportunity Inbox exposes why-now evidence, freshness, spend and next action;
6. promotion creates a normal Outreach Run that still stops at Contact Purchase Approval;
7. pause disables the external flow and preserves audit history.

This research selects the next module; it does not claim a real external account canary without customer credentials.
