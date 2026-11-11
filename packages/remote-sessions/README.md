# @openwork/remote-sessions

Dependency-free OpenWork offload ownership, shared by desktop and bundled harness plugins. Source imports **only this package's own `.ts` files**, with no workspace dependencies, Node imports, SDK, Zod, Electron, scheduler, or native HTTP client. Build with `pnpm --filter @openwork/remote-sessions build` before desktop consumption: default package exports resolve standalone `dist/*.js` ESM, and TypeScript resolves `dist/*.d.ts`. Bun and `development` conditions select source for bundling; a plugin can also bundle `src/index.ts` directly. Normal Node imports never rely on TypeScript stripping inside `node_modules` (which Node refuses). Source tests use Node TypeScript stripping (22.18+).

Callers own admission, polling, account discovery, inventory collection, and lifecycle; this core does not decide whether offloading is allowed. Refusing admission must not erase journals or stop recovery of already delivered work. The one policy the core does enforce is the owner's [session access](#session-access-and-attach) choice, which the caller supplies.

## Ownership

- **OpenWork core:** durable command journal; deterministic creation intent; immutable command/request inputs and initial/followup stable IDs; acknowledgement and progress outboxes; monotonic observation clocks; replay, expiry, receipt authorization, the owner's session access choice, stop guards, answer replay, cancellation, and explicit bounded retention.
- **Harness adapter:** native session create/attach/send/read/stop/observe/answer, including native idempotency, atomic current-turn guards and checking an answer against the live request. No journal, Den acknowledgements, polling timer, Automations, or Electron concerns.
- **Caller store:** atomic durable load/save, private storage permissions and account partitioning. Use one runner/store writer per partition. Partition by service origin, signed organization/member/runner identity **and harness identity**, not by bearer token. An account switch selects another store; token rotation reuses the same one. Never reuse another account's journal.
- **Transport:** Den wire operations. Tokens are obtained on every attempt and never put in the journal.

Journals contain prompts/transcripts, receipts and progress, which are sensitive user content. The core stores no authentication fields and rejects unknown journal fields; callers/adapters must not embed credentials in error messages or identifiers. User-supplied prompt content is not secret-scanned.

## API

All domain types and factories are exported from `src/index.ts` (`@openwork/remote-sessions`). `Command`, `Request`, `Complete`, `RequestComplete`, `Progress`, `Inventory`, and transcript types structurally mirror the existing wire contract. Timestamps (`expiresAt`, `observedAt`, `createdAt`) are integer epoch milliseconds. Wire discriminants `kind: "remote_session_create"` and `kind: "remote_session_request"` are retained; `Command` is `CreateCommand | AttachCommand`, and an attach carries `kind: "remote_session_attach"`. `Progress.engine` is optional `"v1" | "v2"`; the core never selects or routes a native engine. `Request.engine` is a wire hint, not authority over a receipt's actual native owner.

```ts
import {
  createSessionRunner,
  createRemoteSessionTransport,
  emptyJournal,
  parseJournal,
} from "@openwork/remote-sessions"

const transport = createRemoteSessionTransport({
  baseUrl: "https://api.example.test",
  token: () => currentRunnerToken(), // dynamic, no token cache
})
const runner = createSessionRunner({
  adapter,
  store, // load missing storage as emptyJournal(); save with durable atomic replacement
  transport,
  now: Date.now, // optional
  operationTimeoutMs: 15_000, // optional; applies per native/transport operation
  sessionAccess: () => ownerChoice(), // optional; "created" (default) or "all", asked every time
})

await runner.accept(command, signal)  // Promise<Complete>
await runner.execute(request, signal) // Promise<RequestComplete>
await runner.reconcile(signal)        // Promise<void>; call every poll, no autonomous timer
const journal = await runner.inspect() // Promise<Journal>; detached inspectable snapshot
await runner.prune({ retainCommands: 128, retainRequests: 128 }) // Promise<Journal>
```

`accept`/`execute` return the persisted result after its HTTP acknowledgement succeeds. A lost acknowledgement throws, leaving the result queued. Repeating the same assignment or calling `reconcile` retries the outbox, not native work already represented by a result. Same IDs with changed inputs are rejected. Transport failures are never converted into native failure results. `reconcile` attempts independent entries, then throws its first error so the caller can report/retry it. Cancellation stops further operations immediately.

`inspect` loads/validates storage lazily and may save recovery of an interrupted creation before returning. Inspecting never performs native operations or HTTP. `emptyJournal()` creates version 1; `parseJournal(unknown)` strictly validates versions, bounds, discriminants, field names, receipt/result consistency, duplicate IDs and request ownership. Never replace invalid storage with an empty journal: this would erase deduplication evidence.

### Adapter

```ts
interface HarnessAdapter {
  readonly creation?: "idempotent" | "at_most_once" // defaults to at_most_once
  readonly sendReplay?: "idempotent" | "at_most_once" // defaults to idempotent
  create(command: CreateCommand, signal: AbortSignal): Promise<Receipt>
  attach?(command: AttachCommand, signal: AbortSignal): Promise<Receipt> // absent: attach_unsupported
  send(receipt: Receipt, input: SendInput & { messageId: string }, signal: AbortSignal): Promise<SendResult>
  read(receipt: Receipt, input: ReadInput, signal: AbortSignal): Promise<ReadResult>
  stop(receipt: Receipt, input: StopInput, signal: AbortSignal): Promise<StopResult>
  observe(receipt: Receipt, signal: AbortSignal): Promise<Progress>
  answer?(receipt: Receipt, input: AnswerInput, signal: AbortSignal): Promise<void> // absent: answer_unsupported
}
```

- `create` creates/reuses an empty session in the specified workspace and returns `{ sessionId, workspaceId }`. **Do not send the initial prompt here.** Default `creation: "at_most_once"` never replays an interrupted creation. Opt into `"idempotent"` only when native creation supports caller-selected IDs and safely returns the same session on repetition: use exported `sessionIdForCommand(command.commandId)`, exactly `ses_${commandId.replace(/[^a-zA-Z0-9]/g, "")}`. The core stores `intendedSessionId` and the adapter's creation mode before dispatch, and requires an idempotent receipt to match that ID. Both the persisted mode and current adapter must be idempotent to replay. This capability is a promise for every create path the adapter routes: mixed native engines must reject unsafe paths before effects or remain at-most-once. Native metadata validation is **the adapter's responsibility**: verify existing session provenance (service/account/runner/harness), command ID and immutable input fingerprint, and workspace before returning an existing receipt; native ID idempotency alone is insufficient. Never reuse a foreign/conflicting session. If no workspace was specified, recover the original existing session/workspace rather than moving creation to today's active workspace. Deterministic-ID collisions fail closed.
- `send` accepts a caller-provided stable message ID and returns `{ messageId, alreadyPresent }`. Default `sendReplay: "idempotent"` requires native ID deduplication across restart and uncertain responses. Ports without that guarantee (including native V1) **must** opt into `"at_most_once"`; mixed adapters use this conservative capability unless every routed send is replay-safe. Do not silently dispatch another message under another ID. Native deduplication can preserve IDs after compaction without checking content; the core therefore preserves immutable command/request input fingerprints and rejects changed input under a retained assignment/message ID (including a pending send). Never rewrite those journal inputs during recovery. Adapters must additionally scope native IDs to the correct session/account and reject known native content conflicts. The initial ID is exactly `msg_${commandId.replace(/[^a-zA-Z0-9]/g, "")}`. Followups use their wire `messageId`, or the same formula with `requestId`. Generated IDs with no alphanumerics or more than 160 total characters fail validation rather than being truncated/colliding.
- `read` is side-effect-free and safely replayable until its result is durably saved. Result structure/size is validated, including the wire's 256 KiB outcome bound. Optional `ReadResult.historyScope: "context" | "full"` describes whether the native transcript is current context or complete history. Compaction-limited history is metadata, not a session failure; do not synthesize `recent_context_only` in `lastError`.
- `stop` must **atomically compare** `input.messageId` to the native current user turn before stopping it, returning `{ stopped: false, reason: "different_turn" }` for a mismatch. Null wire stop IDs are pinned by the core to its latest known prompt before the first attempt, including across restart. Explicit IDs are respected, so a caller that read a native-local user turn can stop that turn through the adapter's guard. When there is no known turn, the core returns a no-op and never issues an unguarded native stop. Native-local turns still require the adapter guard; the journal cannot see every local action.
- `observe` must use the receipt's actual native owner, not current routing preferences. Report `running`/`waiting` while a turn is active, and terminal text/errors scoped to the latest turn. Include accurate `messageCount` when available. The core persists a pre-send count baseline and masks stale idle answers until it sees activity or at least two new transcript messages (new user + assistant). Running/waiting reports never expose prior final text/errors. When counts prove no new assistant message, returning to idle after a stop cannot resurrect the old answer either. Without counts, the adapter must expose an active observation before a terminal observation, including for an immediate terminal error; otherwise the core conservatively keeps reporting running rather than leaking a previous answer. While the session waits, report `waitingFor` and, when the native request can be read, `pending`. Observing never answers a native permission or question; only `answer` does, with the person's own choice.
- `attach` confirms that `command.sessionId` exists in `command.workspaceId` and returns exactly `{ sessionId, workspaceId }` for it. **It must not touch the session:** no prompt, no title change, nothing created. Throw `SessionRunnerError("session_unavailable", …)` when the session is not there. The core calls it only while the owner allows all sessions, and replays it after an interruption whatever `creation` says, because it has no native effect.
- `answer` replies to one open question or permission, named by `input.requestId`, through the native reply path: `{ kind: "question", answers }`, `{ kind: "permission", decision: "once" | "reject" }` (never "always"), or `{ kind: "dismiss" }`, which closes a question without answering it. Any open request can be answered, not only the first. Check the answer against the live request before replying: throw `stale_request` when that request is no longer open and `invalid_answer` when the answer does not fit it. Exported `answerRefusal(pending, answers)` and `dismissRefusal(pending)` return the refusal message or null; a permission cannot be dismissed.

Adapters can throw `new SessionRunnerError(code, safeUserMessage)` for a **definitive rejection with known outcome**, such as workspace resolution or explicit native rejection before a mutation, or explicit `ambiguous_send` when a native send cannot be safely replayed. The capability must still be declared: an abort race can replace the adapter exception with `AbortError`, so V1 safety must never rely only on throwing that classification. Unknown exceptions, disconnections, cancellation, timeouts and invalid native responses remain uncertain. Native replay requires the effect's pinned idempotent capability; at-most-once sends become durable ambiguity instead. Do not classify a native mutation's lost response as a definitive rejection.

### Session access and attach

A remote caller reaches a session only through a delivered command in this journal. `sessionAccess: () => "created" | "all"` is the owner's choice of which sessions a command may cover:

- `"created"` (the default): only sessions a `remote_session_create` command started. Nothing else on the computer can be reached.
- `"all"`: a `remote_session_attach` command may also record a receipt for a session that already exists on the computer. Once delivered, that session is read, sent to, stopped, answered and observed exactly like a created one.

The core asks `sessionAccess()` every time it matters and never remembers the answer, so a change applies at once:

- **Accepting an attach.** Unless the choice is `"all"`, the command fails with `session_access_denied` and the adapter is not called. It also fails with `attach_unsupported` (adapter without `attach`), `session_already_attached` (the `remote_session_create` command that started the session still holds it, so the caller keeps using that command; a failed creation holds nothing, even when it kept its receipt), `invalid_receipt` (the adapter answered for another session or workspace), `expired`, or the adapter's own definitive error such as `session_unavailable`. A failed attach stays failed for that command ID; attaching again takes a new command. No prompt is ever sent for an attach: its `prompt` and `model` must be null.
- **After the attach.** Every request (read, send, stop, answer) to an attached session fails with `session_access_denied` before any native call while the choice is not `"all"`, including a request that was journaled earlier and is being replayed. A reply that was already dispatched before the change reports `ambiguous_answer` instead. The session is not observed and nothing about it is reported, queued reports included. Returning to `"all"` restores the session without a new attach.
- **Created sessions** are never affected by the choice.

An attach is journaled before the native lookup and goes from prepared straight to delivered or failed, so only a delivered attach holds a receipt.

**One command per session, the newest attach wins.** A session is held by one live command: its non-failed creation, or its latest delivered attach. Attaching again to a session takes a new command, and when that one is delivered it supersedes every earlier attach to the same `(workspaceId, sessionId)`, whatever state it was in (prepared, delivered or failed). The save that records the new receipt also:

- removes the earlier attach entries, with their queued reports and unsent acknowledgements; an interrupted earlier lookup is never replayed;
- fails each request the earlier command had not finished, so the session is never touched again for it: `ambiguous_send` or `ambiguous_answer` when a send or reply had already been dispatched, `unknown_receipt` otherwise. These failures stay in the outbox and are acknowledged;
- drops the earlier command's finished results, acknowledged or not. Refusals it had already given stay in the outbox.

From then on the earlier command is like any command the journal never held: its requests fail with `unknown_receipt` and nothing is reported for it. A new attach that does not deliver (refused by the owner's choice, expired, session gone, wrong receipt) supersedes nothing and leaves the earlier entry exactly as it was. Supersession follows the order commands were accepted, so of two interrupted attaches the later one ends up holding the session.

A core that predates attach does not know the command kind: it rejects a journal that holds an attach entry as invalid and fails closed, like any other unreadable journal, until a core that knows it loads the journal again.

### Questions and permissions

`ReadResult.pending` (and `Progress.pending`) is the request a session waits on. `ReadResult.pendingItems` lists every open question and permission, `pending` first, at most `PENDING_ITEMS_MAX` (5); the rest follow as these are answered. Both are optional, so older adapters and readers keep working.

An `answer` request names one of them by `requestId`. The core saves a marker before the native reply and treats a native request as answered at most once: a replay that finds it gone (`stale_request`) completes with `alreadyAnswered: true` instead of replying again, a second request for an already answered `requestId` completes the same way without a native call, and an expired request whose reply was dispatched fails with `ambiguous_answer`, never `expired`. A dismissal follows the same path.

### Store and recovery

```ts
interface JournalStore {
  load(): Promise<Journal>
  save(journal: Journal): Promise<void>
}
interface Transport {
  complete(commandId: string, body: Complete, signal: AbortSignal): Promise<void>
  report(commandId: string, progress: Progress, signal: AbortSignal): Promise<void>
  completeRequest(requestId: string, body: RequestComplete, signal: AbortSignal): Promise<void>
}
```

All state operations are serialized. A save must atomically replace durable data before resolving. A save failure poisons that runner: recreate it only after the store is healthy and validate the actual durable data again. The core awaits durable storage rather than abandoning a save in flight; the store must bound its own I/O and prevent competing writers.

Recovery windows:

1. **Prepared, no receipt:** an attach is always replayed (after asking the owner's choice, expiry and the session's holder again), since it has no native effect. Default at-most-once creation becomes inspectable `ambiguous_creation`; **never automatically create again** in that mode. Pinned idempotent intents can replay before expiry using their stored deterministic session ID, but only through a currently idempotent adapter with metadata checks. Legacy version-1 entries without creation capability fields migrate to at-most-once, never to today's capability. Capability upgrades/downgrades cannot reinterpret an older uncertain effect. Expired intents never call create; inspect their intended native identity manually if a receipt may have been lost.
2. **Receipt saved, prompt incomplete:** before a durable send intent exists, the first send can still be dispatched. Once its pre-send turn intent is saved, replay needs both the pinned `sendReplay` mode and current adapter to be idempotent. An at-most-once uncertain send becomes `ambiguous_send`, retaining the local receipt and naming session/workspace in the error for inspection; it never sends again. Caller abort, timeout, network loss, or a crash before result persistence cannot erase this boundary. Ambiguity is durably saved even while cancelled, but no HTTP acknowledgement is sent while cancelled. Cancellation before intent persistence is not a send attempt; cancellation immediately after it may conservatively report ambiguity without native dispatch. Missing `sendReplay` in an old dev journal defaults conservatively to at-most-once, independent of today's adapter.
3. **Completion saved:** retry only HTTP completion. An accepted HTTP response lost before the acknowledgement-save is also replayed; the server must make acknowledgements idempotent.
4. **Delivered:** keep observing its stored receipt across reconnect, restart and token rotation. Progress is saved before reporting and unchanged reports are not reposted. Terminal entries are still observed, so later local/followup activity is discoverable.
5. **Requests:** persist intent, pinned send/stop identity, and then the result before HTTP acknowledgement. Pending reads replay safely, idempotent sends keep their stable ID, and stops retain their original guard. At-most-once followup intents recover as inspectable `ambiguous_send` without native replay. Their new-turn evidence is applied atomically with the failure so an old answer cannot become the new result; explicit reads and guarded stops of the delivered receipt remain available. Pending mutating requests for a session are ordered. Unknown send outcomes suppress stale-turn observations; once a send result is durably saved, progress can be reported even if its request acknowledgement is offline. Request acknowledgements do not reset progress or participate in observation ordering.

Native effects check expiry again immediately before dispatch. Expiry never discards an already queued acknowledgement or stops monitoring delivered receipts. Only exact local delivered `(commandId, workspaceId, sessionId)` receipts can be read/sent/stopped/answered; foreign sessions fail with `unknown_receipt` without invoking the adapter, and an attached session additionally needs the owner's choice to be `"all"` at that moment. Proven duplicate send IDs still retained in this journal return `alreadyPresent` without resetting a newer turn.

Progress is a **latest-state** outbox: accepting a new turn supersedes old queued/reported progress. A followup's pre-send baseline is saved in its request intent, then applied to the command atomically with its successful result; a proven native rejection leaves the last accepted turn/watch intact. An expired uncertain send conservatively retains its prepared turn evidence. Command/request acknowledgement bodies are never coalesced or overwritten.

Each command keeps a durable `lastObservedAt` logical clock: changed reports use `max(nativeObservedAt, lastObservedAt + 1)`, including after reload, same-clock observations, or clock rollback. Report HTTP 404/409 drops **only** that stale progress outbox and clears its acknowledged comparison snapshot; the next poll observes fresh native state with a newer clock. The counter, receipts, watches, and command/request acknowledgements survive. Other report failures retain the outbox. Custom transports must expose HTTP errors with numeric `status` (the provided transport uses `RemoteSessionHttpError`). No Den reset timestamp participates in this clock.

### Bounds and pruning

A journal retains at most **256 commands and 256 requests**. Admission at capacity returns `journal_full`, with no native effect; callers must prune or wait. Pruning defaults to targeting 128 of each, removes oldest eligible entries, and may retain more than requested:

- only fully acknowledged **expired** requests can be removed (preserves replayable stop guards);
- only fully acknowledged **expired terminal** commands with no queued progress or retained request references can be removed;
- an expired, acknowledged attach whose session the owner no longer allows counts as terminal whatever its last report: it has no watch to keep;
- active/waiting watches, unexpired deduplication evidence, uncertain/pending effects, and all queued acknowledgements are kept.

A pruned command no longer has a progress watch or authorized receipt. Expired replay after pruning cannot create/send/stop another session. Do not delete storage as a substitute for pruning. Absolute bounds make observation affordable without a timer or unbounded watcher registry.

### Optional HTTP client

`createRemoteSessionTransport({ baseUrl, token, fetch?, timeoutMs? })` implements `Transport`, plus small typed protocol helpers:

- `claimCommand(commandId, signal): Promise<Command>`
- `claimRequest(requestId, signal): Promise<Request>`
- `pendingRequests(signal): Promise<{ kind: "remote_session_request"; requestId: string }[]>`
- `publishInventory(inventory, signal): Promise<void>`

Only HTTPS or HTTP loopback is allowed. Embedded URL credentials, query/fragment, dot-segment route IDs, and redirects are rejected. Request deadlines cover fetch **and response reading**, even when an injected fetch ignores cancellation; responses are limited to 512 KiB and typed claims/acknowledgements are validated. `RemoteSessionHttpError` exposes only `status`, not provider response content or credentials. There is no retry timer; the runner/caller owns retry. `baseUrl` may contain a path prefix. No automatic sign-in or token persistence is performed.

## Verification

No package dependencies or devDependencies are required; the repository provides TypeScript and Node types. From the repository root:

```sh
node --test packages/remote-sessions/test/*.test.ts
./node_modules/.bin/tsc -p packages/remote-sessions/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/remote-sessions/tsconfig.build.json
node --test packages/remote-sessions/test/built.test.mjs
```

Package scripts expose `build`, `test`, `test:built`, and `typecheck` using the repository's existing TypeScript compiler; no compiler dependency is added to this package. The built smoke test installs the package into an isolated `node_modules`, verifies Node's default JavaScript exports, then checks standalone declaration consumption with source removed. The suite exercises crash windows, disconnected acknowledgements, replay after expiry/reload, token rotation, cancellation/timeouts, stable IDs, foreign receipt rejection, stale-turn suppression, progress ordering/outboxes, journal validation, stop guards, retention safety, answers and dismissals, and session access (attach, its refusals and replay, and withdrawal of access).
