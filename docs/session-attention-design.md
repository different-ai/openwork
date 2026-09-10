# Cross-session attention: RCA and design decision

## Problem and root cause

The sidebar's orange indicator represents pending questions or permissions from live session activity. Agent-facing `session.list_sessions` and retained-tab context did not project that state. Backend `session.read` deliberately returns readable text rather than pending tool requests. Consequently an agent could read a transcript while remaining unaware of the actual input holding up the session. No semantic question reply action existed.

This is an observability bug plus a missing delegation workflow, not evidence that every orange indicator is stale. A screenshot alone cannot prove a request is still pending. Existing cross-chat documentation also incorrectly required navigation despite backend search/read support.

## Product and design evaluation

Public references checked September 10, 2026:

| Product | Documented pattern | Implication |
| --- | --- | --- |
| [Slack Activity](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack) and [Threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions) | Reading, marking unread, clearing notifications, and replying are distinct actions. | Do not confuse read state with an unresolved request. Inspecting must not settle. |
| [Codex automation triage](https://developers.openai.com/codex/app/automations) and [subagent approvals](https://developers.openai.com/codex/subagents) | Automation findings have an inbox; CLI inactive-thread approval overlays identify their source. These are different surfaces. | Surface attention centrally while preserving the owning conversation; do not imply a universal approval inbox. |
| [Claude Code Desktop](https://code.claude.com/docs/en/desktop) and [agent teams](https://code.claude.com/docs/en/agent-teams) | Cross-session messages retain attribution; teammate permission prompts are routed for human approval. | Coordination is not delegated security consent. |
| [Cursor questions](https://cursor.com/docs/agent/overview) and [run modes](https://cursor.com/docs/agent/security/run-modes) | Questions and tool approval policies are separate; an agent can continue work while a question is open. | Pending input and execution status should be separate fields. |

These are documented patterns, not independently exercised competitor tests. Bounded internal product/design searches found adjacent indicator-visibility and explicit-state discussions, but no direct agreed policy for cross-session question delegation. This proposal is an engineering/product recommendation, not a claim of team consensus.

### Options

1. **Read and hand off:** smallest observability-only fix; still cannot relay an answer.
2. **Read and propose one reviewed answer (selected):** addresses both needs with explicit source/target identity, current request validation, human confirmation, and an inspectable receipt.
3. **Unified attention inbox:** useful later for questions, permissions, errors, and unread results, but unnecessarily broad for this bug.

## Boundaries

- Cached activity is conservative: nonempty request IDs establish observed pending input; empty arrays created by generic run activity do not establish zero requests.
- Fresh reads use the target workspace's existing authenticated engine client, not whichever conversation happens to be selected. Permission payload bodies and metadata are not returned.
- The proposal only handles supported question requests, never generic forms or permission replies. Question wording cannot manufacture permission authority.
- The person sees the exact question and answer before sending. Answering can resume consequential work under existing permissions; the review says so.
- Re-read and fingerprint checks reject changed questions, native field mappings, or target ownership before dispatch. The native engine owns final request settlement and concurrent answer rejection.
- A native successful response establishes acceptance. A timeout does not establish failure. Attempt guards and redacted receipts prevent automatic resubmission within the same window session, including reloads.
- Receipts are bounded and fail closed when safe persistence is unavailable. They are not durable audit history or independent-window idempotency. Question/answer text is not persisted by the receipt store.
- No automatic answering, permission-mode change, batch approval, browser workaround, or mutation of the original reported session.

## Proof contract

`evals/specs/session-attention.test.ts` exercises production request validation, ownership, conservative cached state, receipt lifetimes, storage failures, stale answers, and uncertain writes. `session-attention-review.e2e.test.ts` drives isolated questions and permissions through the app: another conversation stays selected, proposal alone does not resume work, human review resumes only the question owner, permissions remain pending, and receipt outcomes remain inspectable. Testkit receipts on the PR head determine the verdict; this document does not.
