# Full workshop narrative comparison

This is an explicit, paid, local-only internal proof. It is not a production rollout, an MCP App, or a claim of full Outlook/Office parity. All workplace data and identities are fictional Acme Robotics fixtures.

## Run

Prerequisites: this checkout's pnpm/evals dependencies, Bun, headless Chrome, local MySQL/Redis, authenticated Infisical CLI and `uvx` for the independent PPTX parser.

```sh
OPENWORK_EVAL_MYSQL_URL=<owned-local-MySQL-base> \
node evals/scripts/run-workshop-narrative.ts
```

The wrapper runs the native testkit command twice, sequentially:

```sh
pnpm evals:e2e workshop-narrative --local --surface web --engine v1
```

1. **GPT-6.1 Sol FAST:** exact `gpt-6.1-sol`, native variant `__openwork_fast_v1/default`, Responses API. The recording proxy rejects a missing `service_tier: priority`; it never inserts Fast or changes reasoning. Successful upstream responses must return `fast` or `priority`.
2. Cleanup of the first owned world, then **Qwen3.8 27B:** exact `qwen/qwen3.8-27b` through OpenRouter Chat Completions. A tiny real tool-call preflight must pass before narrative actions. There is no model fallback.

The scoped world consumer retrieves only `OPENAI_API_KEY` from Infisical dev `/`, or `OPENROUTER_API_KEY` from dev `/openwork-ops`. No paid key is written into provider configuration, child environments, screenshots, source, or VM snapshots. The runtime receives a synthetic loopback credential for a bounded in-memory proxy. Installed provider/model settings are never changed.

## Isolation and fairness

- Native `seed.den`, `seed.appWeb` and signed-in browser fixtures own the lifecycle. No desktop window takes focus.
- Canonical scratch paths live outside the checkout. App config/data/auth/cache and developer configuration are isolated.
- Alex and Nora have separate app runtimes, sessions and MCP tokens. Workflow recipient execution is corroborated against the actual caller in the owned database, never inferred from an owner answer.
- Only the world's Atlassian, Microsoft and news MCP origins are registered; checks fail closed before paid task turns. Paid inference is the permitted external route. No real business connector or external mail send is allowed.
- Both worlds reset to `2026-10-16T08:55 America/Los_Angeles`. Full initial service state is hashed, normalizing exact owned origins and narrowly documented auth/session fields only. A mismatch makes the comparison incomplete.
- Both subjects receive the same scene prompts, assertions and limits from `workshop-narrative-contract.ts`. The wrapper rejects relevant proof/fixture source changes between phases.
- Common per-scene limits: 180 seconds, 120 tool parts, 60 assistant turns, 2 million observed tokens and an $8 observed/estimated cost assertion. Aggregate limits and proxy byte/request/output/lifetime bounds are explicit in source and report JSON. Missing billing data is unavailable, not a zero-dollar claim. Estimates are not invoices.

An initial calibration used smaller token/turn/cost limits and exposed both real failures and harness defects. Those failed records are retained privately; they are not relabeled as passing. The matched comparison uses the frozen revision and revised common limits for **both** models.

## Coverage

| Scene | Required observable proof |
|---|---|
| T10 | Model registers the isolated 09:00 job; operator advances clock; dispatcher submits the model-authored job through the real paid app agent; actual digest folder/file and unsent draft exist. Titles, summaries, outlet, country and links trace to news fixtures. A due event alone cannot pass. |
| T01 | Both complete Confluence datasheets and latest complete mail read; a sourced OneDrive comparison and threaded unsent reply are written/read back. |
| T02 | Native Workflow, immutable version, retained successful test and different-input saved-version execution. No local script/skill substitute. |
| T03 | Real viewer grant and actual Nora execution receipt/caller, not an owner fallback. |
| T04 | Full account-plan reads; exact ARR versus order values, relationship, growth, churn and citations in the saved/read-back account report. |
| T05 | Model generates and uploads new PPTX bytes from that account report. Downloaded ZIP/OOXML is opened with python-pptx; slide count, text and citations are checked. This is parser openability, not Office application rendering. |
| T06 | New DOC task, actual Nora assignment, connected read-back and visible assignee field. |
| T07 | Real ITSD reset request, discovered required Application field and Windows option, connected read-back and visible Application field. |
| T09 | Full internal policy reads, honest absent-policy answer and People Ops handoff; no unapproved external search or fabricated permission. Quoted questions are not mistaken for policy declarations. |
| T08 | Real app feedback UI persistence. The current owned world lacks the landing/Plain persistence surface: this remains BLOCKED, not a model success. |
| T11 | One meeting created then actually updated in place, with exact attendees, Pacific timezone, location/body and browser/Graph final state. This does not claim full Outlook parity. |
| T12 | Actual Confluence body/version update and review comment, preserved source content, and an unsent threaded reply linking the updated page/version/comment. |

## Evidence and verdict

The proof acts through the real composer/product automation rail. Tests arrange identities and infrastructure and read backend state, but do not create the reports, tickets, meetings, drafts or Workflows for the models. The one operator clock advance and dispatch of a model-authored due job are scheduler infrastructure, not scripted assistant output. Protected schedule receipts are bookkeeping only; independent paid-request, service-call and backend witnesses remain mandatory.

Actual MCP audit entries bind opaque Code Mode service calls to a unique completed assistant tool time window. Literal-return scripts, discovery metadata, old messages and model claims cannot impersonate source reads or writes.

Native captions/screenshots live under `evals/results/test-runs/`. Matrices, timing, token/cost metadata and the comparison are under `evals/results/workshop-narrative/<run>/`. Raw receipts, auth state and transcripts remain private. Only reviewed, sanitized summaries/images should be published.

Every scene is PASS, FAIL or BLOCKED with a reason. The native test deliberately fails when any scene is incomplete. The overall comparison remains **INCOMPLETE** unless all twelve scenes pass for both models and initial-state hashes match. In particular, lack of real feedback persistence cannot disappear from the report.
