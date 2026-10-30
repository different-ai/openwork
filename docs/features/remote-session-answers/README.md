# Answer a sub-agent task's question here

> **GA:** Available without a feature flag. The former rollout key is retired.
> Off/on screenshots below are historical comparisons, not current deployment options.

Retired rollout key: `remoteSessionAnswers` · Deployments: Cloud and self-hosted · Status: generally available (no flag) · Author: [@benjaminshafii](https://github.com/benjaminshafii)

Task progress, conversation views and answers are generally available.

## What people get

A task the agent started on the cloud or another computer sometimes stops to ask a question or to ask for a permission. Older clients required the person to go to that computer.

By default:

- The row offers the options of a single-choice question as small buttons, plus `Other answer…`, which opens the task's conversation.
- The conversation beside the chat shows the question or permission as a text-only card above the follow-up box: number keys choose, Enter goes to the next question, ⌘Enter allows a permission once. A permission shows its command.
- After an answer the card goes away; the task runs on and the row follows it. A failure shows the reason inline with a retry.

Historical before GA:

![The row only says it waits on the other computer](row-off.png)

Now the row offers the task's options:

![The row offers dev, main and Other answer…](row-options.png)

The question card in the task's conversation:

![Question from Studio Mac with numbered options](question-card.png)

A permission card, with its command:

![Permission on Studio Mac: Run a command, Deny or Allow once](permission-card.png)

After allowing it once, the task finishes:

![The task completed after the answers](answered.png)

## How it works

- The runner on the other computer (desktop app or `opencode-openwork`) reports what the session waits on (`pending`) with its progress and in transcript reads, and takes an `answer` request. It replies through the same native paths a local chat uses: v1 question and permission replies, v2 form replies by field key and option value, v2 permission replies. Answers are checked against the live request; a request that is no longer pending is refused (`stale_request`). A remote surface never sends "always".
- The runner journals the answer like a follow-up, idempotent by the pending requestId: a lost reply is replayed safely, because a native request is answered at most once.
- Den routes `answer` requests only to runners that register `remote_session_answer_v1`. Older runners get `answer_unsupported` and keep "Answer it on that computer".
- `remote-session:status` carries a short `pending` summary (question and option labels, or the permission's title); a new request changes the status version.
- The app calls `POST /v1/remote-sessions/answer` (owner-only). Agents get `remote-session:answer`, only in the member's own chat (never Automations, Workflows or Apps), and its instructions require asking the person first, every time.
- The OpenCode plugin host (2.0.26) has no question reply, so `opencode-openwork` answers permissions only; its questions still say to answer them on that computer.

## Try it

1. Connect a computer with a runner that supports remote answers.
2. Ask the agent to run a task on another computer that asks a question (for example one that needs a branch) or runs a command that needs approval.
3. Answer from the row or the task's conversation.

The proof `evals/proofs/remote-session-answers.proof.test.ts` drives this end to end against a real Den with a runner that speaks Den's runner protocol.

## Availability

Generally available. The rollout flag is retired; organization/member overrides,
operator locks and old kill-switch rows no longer disable this behavior.
Authorization, provider setup, consent and runtime compatibility still apply.

## What to watch

- `remote_session_request` rows with `action = 'answer'` and their outcomes (`stale_request`, `invalid_answer`, `answer_unsupported`, `ambiguous_answer`).
- Audit events `remote_session.request.answer` (app route) and `remote_session.answer` (MCP).
