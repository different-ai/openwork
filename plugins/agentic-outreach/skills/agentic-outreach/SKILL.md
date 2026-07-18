---
name: agentic-outreach
description: Run evidence-first B2B prospecting and outreach through live MCP/API capabilities. Use when the user asks to find companies or buyers, research current buying signals, acquire verified contacts, draft or launch outbound sequences, monitor replies, or resume an outreach run. Qualifies before paid lookup and requires explicit approval before contact purchase and again before sending.
license: MIT
metadata:
  version: "0.2.0"
  domain: b2b-outreach
---
<!--
[INPUT]: 依赖 OpenWork search_capabilities/execute_capability、工作区文件能力、标准哈希能力与用户的两阶段明确审批
[OUTPUT]: 对外提供从 Outreach Brief 到证据、受预算约束的付费联系方式、完整性锁定 Campaign、Launch、Reply Handoff 与控制台的可恢复工作流
[POS]: agentic-outreach 的核心深 Module；供应商仅通过运行时 Adapter 进入，领域规则与外部执行严格分离
[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
-->

# Agentic Outreach

Convert a target market and current signal into a qualified, evidence-backed, approval-controlled outreach run. Orchestrate existing capabilities; do not become a data vendor, scraper, verifier, CRM, or sequencer.

## Non-negotiable invariants

1. Use an available MCP, API, imported Skill, or connected automation Adapter instead of implementing provider logic.
2. Fetch volatile facts live. Every qualifying fact needs a source URL and `observed_at` timestamp.
3. Label inference as inference. Never manufacture evidence, contact details, provider success, cost, or reply state.
4. Qualify before any paid or quota-consuming contact acquisition.
5. Obtain explicit Contact Purchase Approval before buying contacts.
6. Obtain separate explicit Launch Approval before calling any sender or campaign mutation.
7. Preserve suppression, dedupe, unsubscribe, and user exclusions across retries and sessions.
8. Use stable action keys and verify ambiguous provider outcomes before retrying. Never risk a duplicate charge or send.
9. Never expose credentials, hidden provider diagnostics, or unrelated personal data in artifacts.
10. Treat provider-native units and billing currency as separate ledgers. Never silently convert credits into money without a timestamped quote or account-price snapshot.
11. Bind each approval to canonical input hashes. A changed contact plan, audience, message, sender, or provider contract invalidates the relevant approval.

## Capability routing

Treat capability discovery as a two-stage Interface:

1. Call `search_capabilities` with `detail=summary` and 2–4 keyword variants for the needed business action. Search actions, not brand names: for example `current company funding hiring news`, `verified work email purchase`, `create campaign`, `list replies`, and `wait for approval`.
2. Prefer, in order:
   - a direct first-party MCP/API capability;
   - an already installed specialist Skill plus its required MCP;
   - Activepieces `ap_run_action` for a one-off provider action;
   - an Activepieces persistent flow for schedules, webhooks, retries, or reply monitoring.
3. Inspect provider-declared annotations. Absence of a destructive annotation is not proof that buying, CRM writes, campaign creation, or sends are safe.
4. Re-run `search_capabilities` with `detail=schema`, the exact selected `name`, and a narrow `type` when known. It must return at most one parameter contract.
5. Call `execute_capability` only with the exact returned name and schema. Never guess a field or reuse a stale contract from memory.
6. If a connection is unavailable, relay `connectionStatus.connectionName` and `connectionStatus.action` exactly. Wait for the requested human fix, then search live again.
7. If a suitable public GitHub plugin already exists, use OpenWork's marketplace preview/import capabilities. Preview first and report its cloud readiness; do not copy its logic into this Skill.
8. Browser automation is a last-resort Adapter for legitimately public evidence only. Do not build a scraper, evade access controls, solve CAPTCHAs, or access data the user/provider is not authorized to use.

Do not silently switch providers after the user approves spend or launch. Re-price and request approval again when provider, unit cost, eligible count, sender, audience, or Campaign revision changes materially.

## Stage 0 — Resume or create the Run

For a new run, create a filesystem-safe UTC `run_id`, for example `20260718T091500Z-series-b-security`. Create:

```text
.openwork/outreach/<run_id>/
  brief.md
  lead-ledger.csv
  campaign.md
  dashboard.md
  run.json
  events.ndjson
  handoff.md
```

For an existing run, read `run.json`, then `events.ndjson`, then the Lead Ledger before making any external call. If an external mutation has a `planned` event without a matching `completed` or `failed` event, query the provider by the recorded external reference or idempotency key before deciding whether to retry.

`run.json` is the current snapshot. `events.ndjson` is append-only history. Never rewrite history to hide a failure.

Minimum `run.json` shape:

```json
{
  "schema_version": 2,
  "run_id": "...",
  "state": "brief|researching|qualified|awaiting_contact_approval|acquiring_contacts|drafted|awaiting_launch_approval|launched|monitoring|handed_off|blocked|cancelled",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "brief_revision": 1,
  "campaign_revision": 0,
  "counts": { "candidates": 0, "qualified": 0, "review": 0, "rejected": 0, "contacts": 0 },
  "budget": {
    "currency": "USD",
    "cap": 0,
    "worst_case": 0,
    "reserved": 0,
    "actual": 0,
    "meter": { "unit": "credits", "cap": 0, "worst_case": 0, "reserved": 0, "actual": 0 },
    "conversion_snapshot": { "captured_at": "ISO-8601", "provider": "...", "native_unit": "credits", "units_per_currency": null, "source": "provider quote or account price" }
  },
  "contact_plan": {
    "revision": 0,
    "mode": "managed_waterfall|single_provider|composed_waterfall",
    "providers": [],
    "stop_condition": "first_provider_verified",
    "eligible_lead_ids_hash": null,
    "plan_hash": null
  },
  "integrity": {
    "brief_hash": "sha256:...",
    "campaign_content_hash": null,
    "audience_hash": null,
    "sender_hash": null,
    "provider_contract_hash": null
  },
  "approvals": { "contact_purchase": null, "launch": null },
  "external_refs": []
}
```

Each event is one JSON object containing `at`, `action_key`, `stage`, `status`, `capability`, `input_hash`, and, when available, `result_hash`, `provider_contract_version`, `external_ref`, `cost`, `meter_delta`, and a safe `message`.

Use SHA-256 over UTF-8 canonical JSON for integrity fields: recursively sort object keys, preserve array order unless the field explicitly represents a set, omit transient timestamps, and serialize without insignificant whitespace. Sort Lead-ID sets before hashing. Use an existing system or workspace hashing capability; do not add a custom cryptography dependency. Prefix stored values with `sha256:`. If the exact bytes cannot be reconstructed, invalidate approval instead of approximating a hash.

`dashboard.md` is a derived control surface, never a second source of truth. Refresh it after every state transition from `run.json`, the Lead Ledger, and append-only events. It must show state, next action, funnel, evidence freshness, currency and native-unit spend, contact-plan mode, approval scope, Campaign integrity, external references, outcomes, and blockers.

## Stage 1 — Freeze the Outreach Brief

Write `brief.md` with:

- target company profile and exclusions;
- geography and company stage/size;
- buyer persona, seniority, and acceptable adjacent titles;
- required signal, source types, and freshness window;
- target volume and stopping condition;
- contact verification requirement;
- currency, hard budget cap, and whether provider credits count as spend;
- native provider-unit cap when the selected provider meters credits, lookups, or results;
- sender identity and allowed channels;
- suppression sources and prior-outreach window;
- Contact Purchase Approval and Launch Approval policy.

Ask at most three questions, only when missing information changes spend, audience, compliance, or the ability to qualify. Otherwise state conservative assumptions and continue. Increment `brief_revision` if the user changes the brief.

## Stage 2 — Research current evidence

Discover and call live research capabilities. Reuse maintained lead-generation or lead-research Skills when available. Search company sources, job postings, funding/news, official pages, and other legitimate public evidence relevant to the brief.

Create `lead-ledger.csv` with this exact header:

```csv
lead_id,company,domain,company_url,person_name,title,person_url,signal_type,signal_value,signal_source_url,observed_at,evidence_provider,confidence,qualification,qualification_score,rejection_reason,contact_state,email,contact_provider,verification_status,contact_cost,currency,last_action_at
```

Rules:

- `lead_id` is stable across dedupe and resume.
- Normalize and dedupe by company domain, then by person profile URL or provider person ID.
- `signal_value` is a concise fact; do not paste large copyrighted text.
- `observed_at` is when the capability observed or returned the fact, in ISO-8601.
- `confidence` is `high`, `medium`, or `low` and reflects source quality, not model confidence theater.
- Preserve raw provider IDs in `run.json.external_refs`, not in user-facing copy.
- Until approved acquisition succeeds, `contact_state` is `not_requested` and `email` stays empty.

## Stage 3 — Qualify before purchase

Score each candidate out of 100:

- ICP fit: 0–30
- signal relevance, strength, and freshness: 0–30
- persona/seniority fit: 0–20
- evidence quality and corroboration: 0–20

Default decisions:

- `qualified`: 70–100 and all mandatory brief constraints pass;
- `review`: 50–69 or one material ambiguity;
- `rejected`: below 50, excluded, stale, duplicate, suppressed, or missing required evidence.

Record a concise rejection reason. Never acquire paid contacts for `review` or `rejected` rows unless the user explicitly changes their decision.

Report candidate, qualified, review, rejected, freshness, and evidence-coverage counts. If the result set is weak, improve the live search or ask to adjust the brief; do not spend money to make a weak list look complete.

## Stage 4 — Price and request Contact Purchase Approval

Discover the current contact-acquisition capability and read its exact schema. Choose the narrowest external execution path in this order:

1. a first-party managed waterfall that stops on a verified result and exposes result-based charging;
2. a single first-party provider selected by the user or already connected;
3. a customer-owned Activepieces flow composing providers, only when no aggregate capability fits and the user accepts its added cost and failure surface.

Do not compose a waterfall inside this Skill. Do not infer or claim the aggregate provider's hidden sub-provider when its result omits that attribution; record the aggregate provider plus its external result ID.

Build `contact_plan` from the live contracts. Each provider entry records `capability`, human label, contract or Skill version, maximum unit cost, native meter unit, and whether it charges on attempt, lookup, or verified result. Freeze the sorted eligible Lead IDs and hash them. Hash the entire canonical plan.

Obtain both provider-native pricing and a defensible billing-currency ceiling. Capture the quote or account-price conversion source and time. Compute:

```text
worst_case = eligible_qualified_leads × maximum_unit_cost
meter_worst_case = eligible_qualified_leads × maximum_native_units
approved_limit = min(user_budget_cap, explicitly_approved_amount)
```

If no defensible upper price bound is available, do not purchase. Report the missing pricing fact and ask the user to choose a provider or explicit maximum assumption.

Show:

- provider and verification semantics;
- eligible Lead count;
- maximum unit cost or credit assumption;
- worst-case total in billing currency and provider-native units;
- remaining run budget;
- what happens for not-found or unverifiable contacts;
- plan mode, charging event, and first-verified stop rule;
- the exact rows eligible for purchase.

Ask for a direct approval such as:

```text
Approve contact purchase for run <run_id>: plan <plan_hash>, <eligible_hash>, up to <count> qualified leads via <provider>, maximum <native_limit> <native_unit> and <currency> <amount> total.
```

Only a clear user response to this proposal is Contact Purchase Approval. Record the approval text, time, provider, count, billing-currency amount, native-unit limit, brief revision, eligible hash, and plan hash in `run.json` and `events.ndjson`. This is an atomic gate: before that record exists, no external call may reveal, request, enrich, or reserve a paid contact channel.

## Stage 5 — Acquire contacts safely

For each approved Lead:

1. Recompute the eligible hash and plan hash. Stop for re-approval if either differs.
2. Build `action_key = <run_id>:contact:<lead_id>:<plan_hash>:<capability_name>`.
3. Skip if that key already completed.
4. Reserve the maximum next-call currency and native units, then append a `planned` event with the canonical input hash before the external mutation.
5. Call the exact provider capability within both remaining approved ledgers.
6. Append `completed` or `failed` with provider reference, result hash, actual currency cost, and native-unit delta; release unused reservation.
7. Update the Lead Ledger:
   - `verified` only when the provider explicitly says verified;
   - `unverified`, `not_found`, `failed`, or `suppressed` otherwise;
   - never infer or pattern-generate an address.
8. With a composed external waterfall, stop after the first explicitly verified result. If any attempt times out or has an ambiguous result, query that provider by external reference or action key; do not advance to the next provider until the outcome is resolved.
9. Stop before the next call if either actual ledger plus the maximum next-call amount could exceed approval.

Report actual spend, contacts returned, verified rate, failures, and cost per verified qualified contact.

## Stage 6 — Draft the Campaign

Write `campaign.md`. Bind every personalized claim to an Evidence row. Do not claim familiarity, customer results, integrations, or business impact without a source supplied by the user or an approved knowledge source.

Default email sequence:

1. **Touch 1 — relevance:** 2–5 word subject; one observed signal; one relevance hypothesis clearly framed as a hypothesis; one concrete value idea; one low-friction question. Aim for 60–90 words.
2. **Touch 2 — useful proof:** introduce a different approved proof point, benchmark, or practical idea; do not repeat Touch 1. Aim for 35–60 words.
3. **Touch 3 — close the loop:** short permission-based close with a clear opt-out. Aim for 20–40 words.

The Campaign must include:

- audience query and included Lead IDs;
- sender and reply destination;
- subject/body templates and evidence bindings;
- schedule and timezone policy;
- dedupe and prior-outreach window;
- suppression sources;
- unsubscribe text and stop conditions;
- bounce, reply, and out-of-office behavior;
- Campaign revision and projected send count.

Canonicalize and hash the exact provider-ready message payload, sorted audience Lead IDs, sender identity, and selected live provider contract. Write them to `run.json.integrity`. Drafting never grants Launch Approval.

## Stage 7 — Request Launch Approval

Show the final Campaign revision, sender, qualified/verified audience count, schedule, suppression count, sequencer capability, content hash, audience hash, sender hash, and provider-contract hash. Ask:

```text
Approve launch for run <run_id>, campaign revision <revision>, content <content_hash>, audience <audience_hash>, sender <sender_hash>, contract <contract_hash>: send <count> contacts from <sender> on <schedule> via <provider>.
```

Only an explicit user response to that exact launch proposal is Launch Approval. Persist all four hashes in the approval record. If the audience, sender, provider, schedule, content, or live contract changes afterward, increment `campaign_revision` when applicable, invalidate the approval, and request it again.

## Stage 8 — Launch idempotently

Immediately before launch, re-read the exact capability schema and any provider-side draft/campaign object. Rebuild the provider-ready payload and recompute content, audience, sender, and contract hashes. All four must equal Launch Approval; otherwise stop with `approval_invalidated` and show the changed fields.

Create one launch `action_key` containing the run ID, Campaign revision, sender hash, audience hash, content hash, contract hash, and capability name. Append `planned` with the input hash, call the exact sequencer capability, then append `completed` with the provider sequence/campaign ID, result hash, and accepted count.

If the call times out or returns an ambiguous result, search/query the provider for the action key or external reference before retrying. Never create a second campaign merely because the first response was lost.

Update `run.json.state` to `launched` only when a provider reference proves success. Otherwise mark `blocked` with the exact human or provider action.

## Stage 9 — Monitor replies and hand off

For scheduled checks or webhooks, prefer an Activepieces persistent flow or an existing reply-monitor capability. On each reply or delivery event:

- normalize to `positive`, `negative`, `unsubscribe`, `out_of_office`, `bounce`, or `unknown`;
- immediately suppress future touches for any real reply, unsubscribe, or hard bounce;
- never auto-send a substantive sales reply unless the user separately authorized that policy;
- record provider event ID and observed time;
- update `handoff.md` with Lead, evidence, reply summary, owner, urgency, and next action.

On a new session, restore state from the Run before polling. Report what changed since the last check, not the entire history.

## Completion report

Lead with commercial outcomes:

- qualified Leads / candidates;
- evidence freshness and coverage;
- verified contacts and verification rate;
- worst-case approved spend, actual spend, and cost per verified qualified contact;
- native units approved, reserved, consumed, and remaining;
- Campaign revision, provider reference, and sent/accepted count;
- Campaign integrity/preflight status;
- positive/negative/unsubscribe/bounce counts;
- blocked human action and next owner;
- paths to `dashboard.md`, `lead-ledger.csv`, `campaign.md`, and `handoff.md`.

Never describe a draft as launched, a guessed address as verified, a plugin binding as connected, or an attempted mutation as completed.
