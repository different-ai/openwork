# Headless runner

Cheap headless agent sessions for OpenWork. There is no UI and no VM. Each session has:

- a model reached through the **OpenWork AI Gateway**
- tools from **OpenWork MCP** (`/mcp/agent`)
- a small **scratch filesystem**

It is built as the backend for work that doesn't need a cloud computer: Slack replies, scheduled MCP-only automations, and a single-chat assistant.

```
caller (Den / Slack worker / scheduler)
   │  POST /v1/sessions/:id/turns  { messageId, prompt, credentials }
   ▼
headless-runner (one Node process, SQLite file)
   ├── model  → AI Gateway  (Anthropic Messages or OpenAI Chat Completions)
   ├── tools  → OpenWork MCP (bearer = caller's per-turn token)
   └── files  → per-session rows in SQLite (no host FS, no shell)
```

## Goals and how they're met

| Goal | How |
|---|---|
| **Works with the AI Gateway** | It speaks Anthropic Messages (`{base}/messages`, `x-api-key`) or OpenAI Chat Completions (`{base}/chat/completions`, `Authorization: Bearer`). Point it at a Gateway provider route (`/api/v1/providers/<ipr>`, `ow_gw_` key) or OpenWork Models (`/api/v1`, `ow_inf_` key). Model ids are Gateway aliases (`gwm_…`), and the Gateway still enforces access, limits and usage. |
| **Cheap** | One process serves many sessions, and an idle session is just rows. Anthropic prompt caching sits on the system prompt, the ends of the two newest earlier turns and the newest message, so each agent step, and each new turn, reuses the previous prefix. In the smoke test, 123k of 167k input tokens were cache reads. Tool output, file sizes and context are capped. A long turn drops its oldest large tool outputs in blocks, so the cached prefix survives most steps. |
| **Reliable** | Every step is written to SQLite (WAL) before the next one starts. Sends are idempotent on `messageId`. Follow-ups sent while a turn runs are queued per conversation and answered in order, each seeing the earlier answers; the caller never has to retry "busy". After a crash or restart, turns are marked `interrupted`; sending the same `messageId` again resumes them. A tool call whose result was never recorded is **not re-run**: it is recorded as an error so the model can check its effect instead of repeating a possible write. Model calls retry on 408/409/425/429/5xx with backoff. Turns have no time or step limit by default (both are optional settings); every model and tool call has its own timeout, and a step that repeats the previous one (same calls, same results) is treated as waiting: each repeat first waits longer (5, 10, 20, then 30 seconds), so checking back on a desktop, CI, or a job is cheap. When the same failure has come back `maxIdenticalFailures` times, or the same answer has kept coming back for `maxWaitingMs`, the model is told (in the system prompt, not the transcript) to stop and report what it was waiting for; a model that still repeats the step ends as `stuck_repeating`. Each caller sets both limits per session in `repeats` (defaults: 10 minutes, 3 failures). A turn using a caller's MCP token pauses itself between steps every 50 minutes (`interrupted`, `credentials_refresh`) so the caller can resume it with a fresh token; no tool call is cut off. There is a global concurrency limit. Each turn logs one line when it starts and one when it ends (status, error code, steps, tool calls, elapsed time, tokens), never content or credentials. |
| **Safe** | No shell, no host filesystem, no child processes. Network access goes only to the operator-configured URLs: the model and MCP (https, or http on loopback), and Den for [self-resume](#self-resume). Callers can't redirect it. Model keys and MCP tokens are supplied per turn, held in memory only, and never written to disk or logs (a test checks this); a turn's resume grant is kept only encrypted. File paths are normalized so they can't escape the session. A service bearer token (≥32 chars) guards every `/v1` route. `HEADLESS_MCP_TOOL_ALLOWLIST` can narrow the MCP tools. The default system prompt asks the model to read and draft, and to change data only when explicitly asked. |
| **Simple** | About 4,600 lines of source and five third-party runtime deps: `hono`, `@hono/node-server`, `@modelcontextprotocol/client` and `zod`, plus `aws4fetch` for S3 files. From the workspace: `@openwork/workbook` for Office files and `@openwork-ee/headless-computer` (loaded only when a computer is configured). SQLite is `node:sqlite`. No agent framework, no model provider SDKs. The build bundles `@openwork/workbook` and `aws4fetch` into `dist/server.js` with esbuild, so it runs on plain Node. |

## API

All `/v1` routes require `Authorization: Bearer $HEADLESS_API_TOKEN`.

`GET /v1/health` is a versioned, authenticated deployment check on both Node and
cells. It reports only whether model and resume settings are present, and can
compare an `X-OpenWork-Den-Origin` header with the configured callback origin.
It does not run inference, exchange grants, allocate a conversation cell, or
return credentials or URLs. Public `/health` remains a liveness check. See
[diagnostics](../../../docs/diagnostics.md).

| Method | Path | Body / query | Result |
|---|---|---|---|
| `GET` | `/health` | | `{ ok: true }` |
| `GET` | `/v1/models` | | `{ defaultModel, models: [{ id, name }] }`: the models the Gateway route serves with the runner's key (cached 5 min), for pickers. Pass one as a turn's `model` |
| `POST` | `/v1/sessions` | `{ title?, instructions?, repeats?: { maxWaitingMs?, maxIdenticalFailures? }, files?, computer?, reactions?, tasks?, owner?, ref?, timeZone?, autoTitle?, memoryOf?, memoryScope?: "owner" }` | session (`hs_…`). `files`, `computer`, `reactions` and `tasks` are off unless set to `true` (see [Isolation](#isolation)). See [Several conversations per person](#several-conversations-per-person) for the rest |
| `PUT` | `/v1/sessions/:id` | same body as `POST` | `201` session when created, `200` when updated; settings left out keep their value. The caller picks the id (`hs_` + 8–96 of `A-Za-z0-9_-`), so it can keep one durable conversation per person without storing the runner's id. Workbot derives one per member, and one per side chat |
| `GET` | `/v1/sessions` | `?owner=&limit=` | `{ sessions: [{ id, ref, title, createdAt, updatedAt }] }`: one owner's conversations that have a message, most recently used first (on celld, chats in their own session cells included: [Session cells](./OWNER-CELLS.md#session-cells-each-workbot-chat-in-its-own-cell)) |
| `POST` | `/v1/owner/split` | owner header (celld) | `{ split: "started" \| "running" \| "done" \| "not_needed" }`: moves the owner's chats into their own cells in the background (celld only; the Node host answers `not_needed`). Idempotent |
| `POST` | `/v1/sessions/:id/turns` | `{ messageId, prompt, model?, attachments?, interrupt?, execution?: "steps", credentials: { modelApiKey?, mcpToken?, readOnly?, resumeGrant?, indexCapability? } }` | `202 { state: accepted \| resumed \| already_present, turn }`. `execution: "steps"` runs the turn one step at a time ([Step mode](#step-mode)); the turn shows `execution: "steps"`. A message sent while another turn runs is accepted and answered next (`turn.status: queued`); only a runaway queue of 20+ returns `429 too_many_queued`. `attachments` are saved-file ids (`fl_…`); `prompt` may be empty when there are attachments, and an unknown id returns `400 unknown_file`. `interrupt: true` makes the answer in progress wrap up at its next safe point, keeping what it wrote (it ends `aborted` with error `superseded`), and answers this message next. `credentials.readOnly: true` leaves out the tools that change anything (writing, editing or deleting files, `save_file`, the computer, reactions, tasks) and runs the turn's tool calls at the same time. `credentials.resumeGrant` (`hrg_…`) lets the runner keep the turn going on its own (see [Self-resume](#self-resume)); ignored without it. `credentials.indexCapability` is kept with the session for [Den's session index](#dens-session-index). `404 unknown_session` |
| `DELETE` | `/v1/sessions/:id/turns/:messageId` | `?after=1` | `{ removed: [messageId] }`: removes the message and what it led to (its answer, tasks and reports); `after=1` also removes every later message, for editing a message. `409 turn_busy` while any of them is queued or running |
| `GET` | `/v1/sessions/:id` | `?messageId=&limit=&outputs=&turns=&before=` | `{ session, status: idle \| busy, turns, messages, finalAssistantText }`. `outputs=none` returns each tool result's `outputLength` instead of its output, for callers that poll a long turn. Every read is bounded: without `messageId` it returns the newest `turns` turns (default 30, at most 200) before `before` (a turn's messageId, or a message `seq`, which never changes: the turns before the one holding it), their messages and `hasEarlier`, so a long conversation reads as cheaply as a short one, sealed history included ([Sealed history](#sealed-history-and-large-outputs)); `503 history_unavailable` when sealed history or a large output can't be read right now (nothing partial is returned); with `messageId`, that turn's transcript and, in `turns`, the turn with the tasks it started and their reports. `limit` (default 100) caps the messages. `busy` means the conversation is answering; background tasks don't count. A task's turn has `kind: task`, `parent` (the turn that started it) and `title`; its report has `kind: report` and `parent` (the task) |
| `GET` | `/v1/sessions/:id/events` | | Server-sent events: `ready` first, then messages whose JSON `type` is `changed { messageId, status? }` (re-read the session), `text { messageId, step, delta, reset? }` (model text as it is written) or `tool { messageId, step, tool }` (a tool call started). Nothing is stored or replayed; a reader that misses one re-reads the session. A comment every 15 s keeps proxies from closing it. With `Upgrade: websocket`, celld answers with a hibernatable WebSocket instead (same checks): `{"type":"ready"}`, then each event as one JSON message, exactly the SSE `data:` JSON; it survives a deploy switch and doesn't hold one up, and it answers a `ping` text message with `pong`. The Node host answers without upgrading, so clients fall back to SSE (headless-protocol's `openEventsSocket` returns null) |
| `POST` | `/v1/sessions/:id/abort` | `{ messageId? }` | `{ accepted }`. With a `messageId`, stops only that turn (running or queued); without one, stops the running turn and every follow-up queued behind it (background tasks keep going) |
| `GET` | `/v1/sessions/:id/files` | | `{ files: [{ path, size, updatedAt }] }` |
| `GET` | `/v1/sessions/:id/files/content` | `?path=` | file text |
| `DELETE` | `/v1/sessions/:id` | | `204`: its rows go (scrubbed first), then its sealed segments, large bodies and saved files' bytes, and its computer (see [Deleting a conversation](#deleting-a-conversation)). `409 session_busy` while a turn is queued or running |
| `GET` | `/v1/sessions/:id/export` | | Every row of the conversation, sealed turns and large outputs inline (lossless; never segment files or step checkpoints), to [move it to Node](#move-conversations-to-node). A conversation on its owner's memory (`memoryScope: "owner"`) also carries that memory (`owner_memory`). `409 session_busy` while a turn is queued or running |
| `POST` | `/v1/sessions/:id/import` | an export | Node only (celld answers `405`). `201 { id, rows }`, or `409 session_exists`. `owner_memory` is merged into the owner's memory (a file is written unless the owner already has a version at least as new; nothing is deleted); `400` (nothing written) for another conversation's, a cut-off or a newer runner's export |
| `GET` | `/v1/files/status` | | `{ enabled, kind, maxFileBytes, maxSessionBytes }` |
| `POST` | `/v1/sessions/:id/saved-files` | `?name=`, raw body typed by `Content-Type` | `201` saved file (`fl_…`). Send its id in a turn's `attachments`. `403 files_not_enabled` for a session without `files: true`; `413 file_too_large` or `413 files_full` past the limits |
| `GET` | `/v1/sessions/:id/saved-files` | | `{ files }`, newest first, `source: user \| agent` |
| `GET` | `/v1/sessions/:id/saved-files/:fileId` | | the bytes, with `x-file-name` |
| `GET` | `/v1/sessions/:id/saved-files/:fileId/preview` | | the page-image manifest, or `404 no_preview`. Without one, a session with a computer renders it first (see [Computer](#computer-optional)) |
| `GET` | `/v1/sessions/:id/saved-files/:fileId/preview/:page` | | one page as PNG |
| `DELETE` | `/v1/sessions/:id/saved-files/:fileId` | | `204` |

Turn status is one of `queued`, `running`, `completed`, `failed`, `interrupted` or `aborted`. `failed` and `interrupted` can be resumed by re-sending the same `messageId` with fresh credentials; `aborted` cannot. Resuming continues the same turn (Workbot's "Try again" does this), so the conversation never gets a second copy of the message. A failed turn's `errorDetail` says what the model provider answered, with its request id, and the turn's `turn ended` log line carries it too; it is for support, never for the person. The `error` field holds a stable code:

- `model_credentials_missing`
- `mcp_unavailable`
- `model_http_<status>`
- `turn_timeout`
- `max_steps_exceeded` (only with `HEADLESS_MAX_STEPS` set)
- `stuck_repeating`
- `output_limit` (the model's replies stopped at `HEADLESS_MAX_OUTPUT_TOKENS` three times in a row)
- `runner_restarted`
- `credentials_refresh` (an `interrupted` turn waiting to be resumed with a fresh MCP token)
- `step_crash_loop` (step mode: one step kept dying, see [Step mode](#step-mode))
- `step_state_invalid` (step mode: the turn's stored next step couldn't be read)
- `memory_unavailable` (a chat in its own cell couldn't reach its owner's memory; resend it)

`runner_restarted`, `runner_shutdown` and `credentials_refresh` turns that have a resume grant are resumed by the runner itself ([Self-resume](#self-resume)); re-sending still works and is harmless.

Files that a tool returns (MCP `image` or `audio` content, or `resource` blobs), for example a file read from Slack, reach the model in the best form it can read:

| File | The model gets |
|---|---|
| PNG, JPEG, GIF, WebP | The image: at most 4 per result, about 3.7 MB each |
| PDF | The document itself (text and page images): at most 2 per result, 10 MB each |
| Word, PowerPoint, Excel (`.docx`, `.pptx`, `.xlsx`) | Extracted text, from the same `@openwork/workbook` extractor the desktop app uses |
| Text (`text/*`, JSON, YAML, CSV, code, SVG, …) | The decoded text |
| Anything else (audio, video, archives, `.doc`/`.xls`, Keynote, HEIC, …) | A note with the name, type, size, and what to ask for instead |

Images and PDFs go to Anthropic as image and document blocks in the tool result, and to OpenAI as image and file parts in a following user message. Only the turn that fetched them sees them: when a turn completes, fails, or is stopped, their bytes are dropped from the database and later turns see a note. An interrupted turn keeps them, since it resumes. The session API reports `imageCount` and `documentCount` instead of the data.

The model sees these tools:

- OpenWork MCP tools as the server names them, e.g. `search_capabilities` and `execute_capability`
- `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file` (`read_file` takes `start`/`lines` or `find` to read part of a long file, numbered by line)
- In a session with `files: true` (and files configured): `list_saved_files`, `open_file` (brings a kept file back into view), `save_file` (hands a scratch file to the person)
- In a session with `computer: true` (and a computer configured): `bash` and `look` (see below)
- In a session with `reactions: true`: `react { emoji, final? }`, one emoji on the person's latest message, the way a colleague reacts in chat. The runner checks it is exactly one emoji and keeps the call in the transcript; the caller shows it (Workbot puts it on the person's message). A step that only reacts with `final: true` ends the turn: the reaction is the whole reply
- In a session with `tasks: true`, for a person's message: `start_task { title, brief, files? }` and `stop_task { task }` (see below)

### Background tasks

A session with `tasks: true` can hand longer work to a background task and keep talking. `start_task` admits a task turn (`<messageId>.t1`, `.t2`, …) that runs in its own lane, alongside the conversation: up to 3 per session at once and 5 unfinished, within the global limit. The task inherits the starting turn's credentials and model; it sees the session's instructions, memory and tools, plus its brief, but not the conversation, whose context in turn leaves tasks' work out. Tasks share the conversation's scratch workspace: `files` hands a task scratch files by path instead of copying them into the brief. When a task completes or fails, the runner queues its report (`<taskId>.r`, `kind: report`) in the conversation, listing the scratch files the task wrote; the report turn may read them (`list_files`, `read_file` only) to pass on just the part the person needs, and the model tells the person the result. A person's queued message goes before a report. The end of each request lists the conversation's recent tasks with their ids and states (at the end, so the cached part of the request stays the same while they change), so it can answer "how's it going?" or call `stop_task`. Abort a task by its `messageId`; a stopped task doesn't report. Like any turn, a task or report pauses for fresh credentials (`interrupted`, `credentials_refresh`), counted from when its starting turn's credentials were issued, and resumes when the caller re-sends its `messageId`.

### Long conversations

The model sees a conversation in whole turns (a message and everything that answered it), within `HEADLESS_CONTEXT_CHAR_BUDGET`. A turn is never split: a tool result never reaches the model without the call it answers, which Anthropic and OpenAI both refuse. Earlier turns are compacted (long tool outputs cut to their start, files replaced by a note). When the conversation outgrows the budget, its oldest turns are left out in one deep cut, down to 60% of the budget, and the session remembers where its context starts; it then grows again from there for many turns. Each request so starts the same way until the next cut, and is cached at the ends of the two newest earlier turns and of the newest message, so the provider's prompt cache keeps hitting from one turn to the next. Nothing that changes every turn is in the system prompt: each message from the person starts with when they sent it (in the session's `timeZone`), and background task state comes last. Before every request the transcript is checked once more (it starts with the person, every tool result follows its call, every call has its result, no message is empty); a repair is logged as `context repaired`. Files under `memory/` carry what matters past the cut.

### Sealed history and large outputs

`src/storage/` keeps a conversation's hot SQLite small however long it gets (the plan: overview §9.3). With
`HEADLESS_SEGMENTS=on` (and a files store, `HEADLESS_FILES=s3` or `disk`):

- **Sealing** (background job `seal`, after turns end): when the hot database passes `HEADLESS_HOT_LIMIT_BYTES`, or a
  session has more than `HEADLESS_SEGMENT_TARGET_BYTES` it could seal, the session's oldest whole turns move into an
  immutable **segment**, `sessions/<id>/segments/<6-digit n>.jsonl.gz` in the files bucket: gzip'd JSONL, a versioned
  header (`openwork-headless-segment`, version 1) then the turn and transcript rows as stored (large outputs inline),
  checked by SHA-256. Never sealed: a running, queued, interrupted or step-scheduled turn, a turn whose task (or its
  report) is still open, anything the model's context still reaches (`context_from`, or where a budget-bounded read
  stops), and the newest 30 turns. The segment is uploaded and read back first; then one transaction re-checks that
  the rows are unchanged, adds the manifest row (hot table `segments`), deletes the rows and queues the index update.
  A crash before that leaves an orphan object at most. Failures back off (at once ×3, 30 s, 2 min, then hourly,
  counted in `seal_state`) and are reported as `seal_failed` from the fifth in a row; `hot_db_near_limit` past 90 %.
- **Large bodies**: a tool output over `HEADLESS_LARGE_BODY_BYTES` is uploaded to `sessions/<id>/bodies/<sha256>`
  before its row commits; the row keeps its first 2,000 characters and a marker line (`large_bodies` maps it). Every
  read and every model context gets the whole output back (fetched in parallel, cached briefly); one that can't be read
  fails the read (`503`) or the step, retryably (a step-mode step runs again, counted toward `step_crash_loop`; a turn
  run in one go fails `large_body_unavailable`, and re-sending resumes it). An upload that fails keeps the output whole
  in the row. A runner from before this (a rollback) sees the start and the marker: a valid message.
- **Reads** page into segments past the hot part (fetched, decompressed, cached briefly, bounded by bytes); the model's
  context never reads them. Removing a message that reaches a sealed turn rewrites that segment (a new object under a
  new name, the manifest swapped in one transaction, the old object deleted after).
- **Orphan cleanup** (background job `segment-orphans`): retries object deletions queued in `storage_deletions`, and
  once a day deletes this cell's segment and body objects that nothing references and that are over 24 hours old.

`HEADLESS_SEGMENTS=off` (the default) is the kill switch: nothing new is sealed or moved; reading existing segments
and large bodies keeps working. The schema is versioned by numbered migrations in a `meta` table (`schema_version`;
Durable Object SQL refuses `PRAGMA user_version`); each is additive, so the previous runner opens a migrated database.

`pnpm session <list|inspect|verify|seal|reseal|export|delete> [sessionId] --db <path> [--files-dir <dir>]` inspects a
Node runner's sessions (hot part, manifest, large bodies, seal failures), verifies segment checksums, forces a seal,
rewrites segments, exports or deletes; it reads `HEADLESS_FILES`/`HEADLESS_S3_*` like the runner. Stop the runner
first.

### Deleting a conversation

`DELETE /v1/sessions/:id` overwrites the conversation's content in place with zero bytes (same length, so SQLite
rewrites the same cells) and deletes its rows in one transaction with the Den index's `deleted` update; then it
deletes its segments, large bodies and saved files (anything that fails stays queued for `segment-orphans`). On Node
the connection runs with `secure_delete = FAST` (space freed inside a page is zeroed) and the WAL is checkpointed
(`TRUNCATE`), so the bytes leave the database file; `pnpm session delete --vacuum` also rewrites the file. On celld
(and Cloudflare) the authorizer denies `VACUUM`, `secure_delete` and every pragma but a short list, and a cell can't
force a fresh snapshot epoch; see [OWNER-CELLS.md](./OWNER-CELLS.md#deleting-a-conversation-on-celld) for what
remains in the celld bucket and for how long.

### Several conversations per person

A caller with more than one conversation per person (Workbot's side chats) sets `owner` (its key for the person) and `ref` (its id for the conversation) on each, and lists them with `GET /v1/sessions?owner=`. `autoTitle: true` names a conversation after its first answer, in a few words from the model (or the person's first words when the model can't), while its title is empty; such a session starts with an empty title. `memoryOf` points at another of the person's conversations: this one reads and writes that one's `memory/`, so they remember together; its other files stay its own. `memoryScope: "owner"` (which needs `owner`, and replaces `memoryOf` for new conversations) shares one `memory/` among all of the owner's conversations instead; on celld it lives in the owner's cell ([Session cells](./OWNER-CELLS.md#session-cells-each-workbot-chat-in-its-own-cell)). The first time an owner's memory is used, the memory their conversations already share with `memoryOf` becomes it.

## Self-resume

Without it, a turn cut off by a restart, a deploy or a failover, or paused every 50 minutes for a fresh MCP token
(`credentials_refresh`), waits `interrupted` until its caller re-sends it. With `HEADLESS_DEN_API_URL`,
`HEADLESS_DEN_CALLBACK_TOKEN` and `HEADLESS_GRANT_KEY` set (all three, or the runner refuses to start), turns that
Den sends with a **resume grant** (`credentials.resumeGrant`, minted for every named turn) keep going on their own:

- **The grant is kept encrypted** on the turn (AES-256-GCM, keyed by `HEADLESS_GRANT_KEY`). It is never returned by
  the API, logged, reported, or included in an [export](#move-conversations-to-node). A value that doesn't decrypt
  (another key) counts as no grant. A turn's background tasks and their reports use the grant of the message that
  started them.
- **In-place refresh.** Where the turn would pause for `credentials_refresh`, it exchanges the grant with Den
  (`POST $HEADLESS_DEN_API_URL/v1/headless/resume-token`, `Authorization: Bearer $HEADLESS_DEN_CALLBACK_TOKEN`) for a
  fresh MCP token, reconnects, and goes on without ever being `interrupted`. If Den gives no token, it pauses as before.
- **Resume after a restart.** Turns `interrupted` with `runner_restarted`, `runner_shutdown` or `credentials_refresh`
  that have a grant are resumed the way a caller would: the same `messageId` with a fresh token. A tool call whose
  result was never recorded is still not re-run. On Node this runs right after startup and then every minute; on
  celld each cell sets a durable alarm whenever a turn is admitted or resumed, so after a crash the cell wakes on
  another node, recovers its turns and resumes them with no request.
- **Failures.** A busy or unreachable Den (429, 5xx, timeout) is retried per turn after 30 s, doubling up to 15
  minutes, with jitter (and never before Den's `retryAfterMs`). A grant Den refuses for good (403: expired, revoked,
  member left, or not this turn's) is forgotten, so the turn stays `interrupted` for its caller. A 401 or
  404 means the runner's settings are wrong: self-resume stops until a restart and `resume_config_invalid` is
  reported once. Reports carry codes and ids only (`resume_exchange_failed`, `resume_config_invalid`,
  `resume_sweep_failed`, `resume_grant_unreadable`, `resume_grant_store_failed`).
- A resumed turn uses the runner's `HEADLESS_MODEL_API_KEY`: a caller's own per-turn model key is never stored.

Callers keep their re-send logic as a fallback; sends are idempotent. Deploy a runner that accepts `resumeGrant` and
`execution` before deploying a GA Den: older runners refuse the unknown fields.

## Den's session index

With `HEADLESS_DEN_API_URL` and `HEADLESS_DEN_CALLBACK_TOKEN` set, the background job `den-index` (`src/den-index.ts`)
reports each session's content-free totals and state (title, dates, hot and total bytes, segment count, when its
running turn started, deleted) from the index outbox to Den (`POST $HEADLESS_DEN_API_URL/v1/internal/headless/index`,
`Authorization: Bearer $HEADLESS_DEN_CALLBACK_TOKEN`), at most 50 per request. Each update carries the session's
**index capability**: Den sends one with every turn whose caller names the session (`credentials.indexCapability`);
the runner keeps the latest with the session, never with the turn, in logs or in exports. Den answers per update:
`ok`/`stale` are acknowledged; `rate_limited` is kept and retried (so is `index_disabled`, which only Dens from before
the index was always on send); other rejections are dropped.
Failures back off (immediately, 30 s, 2 min, 10 min, then hourly); rows older than 7 days, or that never got a
capability, are dropped. Once a day the cell queues a fresh snapshot of every session. A Den outage delays the
index, never a turn.

## Step mode

A turn sent with `execution: "steps"` runs one step at a time from what is stored, instead of in one go. Callers send
it for all new turns (Den's Slack runner and Automations, and Workbot). [Resume grants](#self-resume)
are minted for all named turns. Older Dens may send turns without it, which run as before; a resent turn keeps
the mode it was admitted with. Its background tasks
and their reports run in step mode too. Lanes, the queue, `HEADLESS_MAX_CONCURRENT_TURNS`, Stop, follow-ups that
interrupt, the repeat check and `credentials_refresh` work the same way.

- **A step** is: build the context, one streaming model call, that call's tool calls, then one SQLite transaction
  that writes the step's messages and tool results, the turn's next step (`step_schedule`) and the attempt reset. A
  crash leaves the whole step or none of it.
- **Between steps nothing runs.** On celld, steps run from the cell's durable alarm (the same alarm as self-resume,
  set for whichever is due first), each to completion, lanes in parallel. Between two alarms the cell is idle, so a
  runner deploy switches it to the new code there instead of cancelling a step after `CELLD_DEPLOY_MAX_AGE_S`. On
  Node, each step runs as soon as it is due, in the process; a restart or `SIGTERM` leaves step-mode turns as they
  are stored, and the next process continues them.
- **No repeated writes.** Once the model has answered with tool calls, the answer is kept before any call runs, and
  each result as it returns. A step that dies there finishes from them: a call without a recorded result is never run
  again, it gets an error result so the model can check its effect.
- **Stream checkpoints.** A streaming model call keeps its text so far (at most every 2 s; never a tool call). A step
  cut off mid-call (a forced switch, a crash) continues that text as a partial assistant message where the provider
  accepts one (`anthropic`; the runner never turns on extended thinking), and otherwise (`openai`,
  `openai-responses`) makes the call again. Live `text` events then reset and replay the text so far. Checkpoints are
  deleted when the step commits and never exported.
- **Crash loops.** A step's starts are counted before its model call. A step that keeps dying runs again at once
  twice, then after 30 s and 2 minutes; after 5 starts the turn fails with `step_crash_loop` (reported by code).
- **Contained failures.** An error in one step fails that turn only; other lanes, the alarm and the cell go on. A
  turn whose stored next step can't be read fails with `step_state_invalid`; startup never throws on it.
- **Credentials** are held in memory only, including a member's scoped model access (`credentials.modelAccess`): never
  in `step_schedule`, checkpoints or the transcript. Every step of a turn sent with scoped access uses it, with the
  turn's stored model. A turn that lost its credentials (its cell restarted or switched) gets a fresh MCP token from
  its resume grant, as [self-resume](#self-resume) does, and, when it requires scoped access, fresh access for its
  stored model; other turns use `HEADLESS_MODEL_API_KEY`. Without them (no grant, Den gives no access, or no runner
  model key) it becomes `interrupted` (`runner_restarted`), as every turn did on a restart, and never falls back to the
  deployment key.
- **Moving conversations.** Exports carry each turn's `execution`. A session with a running turn can't be exported,
  so the next-step schedule and checkpoints are never needed after an import, and never included.

Saved steps are generally available; there is no organization rollout switch. Deploy a runner that accepts
`execution` and resume grants before GA Den. Existing turns keep their stored execution mode.

## Isolation

The runner is a private service with one caller (Den), which authorizes each person before it reaches a session. Within the runner:

- **Opt-in per session.** Configuring files or a computer makes them *available*; a session only gets them when it is created (or updated) with `files: true` / `computer: true`. Slack replies and Automations don't ask, so they keep their exact behavior: no file tools, no computer, no uploads, and the preview route never starts a computer for them.
- **Files belong to one session.** Every read, download, preview and delete looks a file up by session id *and* file id, and bytes are stored under `sessions/<sessionId>/<fileId>`. Deleting a session deletes its bytes and its computer.
- **Limits.** `HEADLESS_FILES_MAX_BYTES` (100 MB) per file, enforced while the upload streams in (with or without `Content-Length`), and on `save_file` and computer outputs. `HEADLESS_FILES_MAX_SESSION_BYTES` (5 GB) per session in total. Past either, the upload gets `413`, and the model is told why so it can say so.
- **Storage credentials.** Use a store or bucket for this runner alone, with credentials scoped to it. Neither the storage credentials nor the Freestyle key ever enter a computer.
- **Computers.** One VM per session, created only when that session first runs a command; it holds no credentials and has outbound internet only.

## Computer (optional)

`HEADLESS_COMPUTER=freestyle` (plus `FREESTYLE_API_KEY`) gives each conversation its own Linux VM, from [`@openwork-ee/headless-computer`](../../packages/headless-computer). The runner imports that package only when the computer is on, so a runner without one never loads the provider SDK. There is no agent or server inside the VM; the model calls two tools:

| Tool | What it does |
|---|---|
| `bash { description, command, timeout_seconds? }` | `bash -c` in `/workspace`, up to 300 s; returns the exit code and the tail of stdout/stderr. `description` is a plain-language progress line for the person. Longer work: `background <name> '<command>'` |
| `look { paths }` | Shows up to 4 files from the VM like any tool file: images and PDFs as model input, Office files and text as text |

- **Files:** uploads are copied into `/workspace/files`; files written to `/workspace/out` become saved files after each command. A new version of an out file updates the same saved file (same id, newer `updatedAt`).
- **Previews:** slide decks, documents and PDFs get page images (LibreOffice, then `pdftoppm`), served at `GET /v1/sessions/:id/saved-files/:fileId/preview` and `/preview/:page`.
- **Only for sessions with `computer: true`.** Others never see the tools, and nothing starts a VM for them.
- **Lifecycle:** one VM per session, found by a slug derived from the session id. Paused `HEADLESS_COMPUTER_PAUSE_SECONDS` (300) after the last turn unless a `background` job runs; deleted after `HEADLESS_COMPUTER_KEEP_DAYS` (14) unused, or with the session.
- **Image:** the snapshot is built from the package's install script: `pnpm --filter @openwork-ee/headless-computer snapshot:build`.
- Every file under `memory/` in the scratch workspace is shown to the model at the start of each turn, so long-term memory survives older turns dropping out of context

## Run on celld (no disk)

The same runner also runs on celld, one SQLite cell per Workbot person or per Slack/Automation conversation, kept
in an S3 bucket instead of a disk: [OWNER-CELLS.md](./OWNER-CELLS.md).

## Move conversations to Node

Every conversation can leave celld for a Node runner with nothing lost: export it, import it with the same id, and point
Den and Workbot at the new URL. Every celld deploy proves this with its smoke conversation before it goes out.

- **Same token, model and MCP settings** on the Node runner.
- **Same bucket** (`HEADLESS_FILES=s3`): kept files' bytes stay there; the export carries only their keys.
- **Same computer settings** (`HEADLESS_COMPUTER`, its key, snapshot, `HEADLESS_COMPUTER_SCOPE`, and any `SANDBOX_GATEWAY_*`): a conversation's computer
  is found by a hash of its id, so it keeps its `/workspace`.

Pause Slack, Automations and Workbot first (export refuses a conversation while a turn runs). Den knows every
conversation (Slack threads, Automation runs' receipts, Workbot members); for each:

```sh
curl -sf -H "authorization: Bearer $FROM" ${OWNER:+-H "x-openwork-headless-owner: $OWNER"} "$FROM_URL/v1/sessions/$ID/export" |
  curl -sf -X POST -H "authorization: Bearer $TO" --data-binary @- "$TO_URL/v1/sessions/$ID/import"
```

Nothing on celld changes, so pointing the URLs back is the rollback.

## Configuration

| Variable | Default | |
|---|---|---|
| `HEADLESS_API_TOKEN` | required | Service token for callers, ≥32 chars |
| `HEADLESS_MODEL_PROTOCOL` | required | `anthropic`, `openai` (Chat Completions) or `openai-responses` (Responses API; for OpenAI models that only take tools there) |
| `HEADLESS_MODEL_BASE_URL` | required | e.g. `https://gateway.openworklabs.com/api/v1/providers/ipr_…` |
| `HEADLESS_MODEL` | required | Default model alias (`gwm_…`) |
| `HEADLESS_MODEL_API_KEY` | unset | Fallback key for single-tenant use; callers normally send their own |
| `HEADLESS_MCP_URL` | unset | e.g. `https://api.openworklabs.com/mcp/agent`; never used as a telemetry destination |
| `HEADLESS_WORKBOT_DEN_API_URL` | unset | Explicit trusted Den API origin for Workbot telemetry (both Node and cells). HTTPS; loopback HTTP for development only. No credentials/path/query/fragment; redirects refused. Unset disables runner admission/outcome telemetry. See [adoption deployment checks](../../../docs/workbot-adoption.md#deploy-before-the-rollout) |
| `HEADLESS_MCP_TOOL_ALLOWLIST` | all | Comma-separated MCP tool names |
| `HEADLESS_DB_PATH` | `./data/headless.sqlite` | Put it on a persistent volume |
| `HEADLESS_PORT` | `8795` | |
| `HEADLESS_MAX_CONCURRENT_TURNS` | `32` | Process-wide. Turns mostly wait on the network, so this is bounded by memory and Gateway rate limits, not CPU |
| `HEADLESS_MAX_STEPS` | `0` | Model calls per turn. `0` means no limit: a long task ends with its answer, Stop, or the stuck check |
| `HEADLESS_TURN_TIMEOUT_MS` | `0` | `0` means no limit. Otherwise at least `10000`, applied to each stretch between credential refreshes |
| `HEADLESS_CREDENTIAL_REFRESH_MS` | `3000000` | A turn with an MCP token pauses between steps after this long so the caller resumes it with a fresh one. Keep it under the token lifetime (60 minutes for Den) |
| `HEADLESS_MAX_OUTPUT_TOKENS` | `16384` | Output cap per model call: Anthropic `max_tokens`, OpenAI `max_completion_tokens`. A streamed call has no total time limit, only 180 s without any data; a non-streamed call must finish in 180 s. A reply cut off there never ends a turn: a call it was writing gets an error, a reply with no complete call is dropped, and the next step asks for less |
| `HEADLESS_CONTEXT_CHAR_BUDGET` | `400000` | Past this, the oldest whole turns are left out, down to 60% of it (see [Long conversations](#long-conversations)). A turn that outgrows it alone replaces its oldest large tool outputs with a short note, in blocks of eight |
| `HEADLESS_SYSTEM_PROMPT` | built-in | |
| `HEADLESS_FILES` | `off` | Saved files: `off`, `disk`, or `s3`. Only sessions created with `files: true` use them. Off means the file routes answer `files_not_configured` |
| `HEADLESS_FILES_MAX_BYTES` | `104857600` (100 MB) | Largest single kept file |
| `HEADLESS_FILES_MAX_SESSION_BYTES` | `5368709120` (5 GB) | Most one session may keep in total |
| `HEADLESS_FILES_DIR` | `files` next to `HEADLESS_DB_PATH` | For `disk`. Defaults to the database's volume so files survive deploys; disk is for development, use a store in production |
| `HEADLESS_SEGMENTS` | `off` | `on` seals old turns and moves large tool outputs to the files store (needs `HEADLESS_FILES`; see [Sealed history](#sealed-history-and-large-outputs)). `off` is the kill switch; reading what exists always works |
| `HEADLESS_HOT_LIMIT_BYTES` | `33554432` (32 MiB) | The hot database is kept under this (transcripts and prompts, summed per session) |
| `HEADLESS_SEGMENT_TARGET_BYTES` | `8388608` (8 MiB) | About this much per segment; a session with this much it could seal is sealed even under the limit |
| `HEADLESS_LARGE_BODY_BYTES` | `8192` | Tool outputs over this go to the files store |
| `HEADLESS_S3_ENDPOINT` | | For `s3`: any S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-east-1.amazonaws.com`, or a self-hosted MinIO/RustFS |
| `HEADLESS_S3_REGION` | `auto` | `auto` for R2; the bucket's region for AWS |
| `HEADLESS_S3_BUCKET`, `HEADLESS_S3_ACCESS_KEY_ID`, `HEADLESS_S3_SECRET_ACCESS_KEY` | | For `s3` |
| `HEADLESS_S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and most self-hosted stores |
| `HEADLESS_COMPUTER` | `off` | `freestyle` or `daytona` makes a computer available to sessions created with `computer: true` |
| `FREESTYLE_API_KEY` | | For `freestyle`. Use a Freestyle account for this runner alone; the key never enters a VM |
| `HEADLESS_COMPUTER_SNAPSHOT` | built from the package | Snapshot id or slug new computers boot from |
| `SANDBOX_GATEWAY` | `off` | `differently` adds a [sandbox gateway](#sandbox-gateway) for sessions created with `sandboxGateway: true`; every other session keeps `HEADLESS_COMPUTER` |
| `SANDBOX_GATEWAY_URL`, `SANDBOX_GATEWAY_API_KEY` | | For the gateway: its HTTPS API and a project-scoped key. The gateway holds the provider credentials |
| `SANDBOX_GATEWAY_TEMPLATE` | | For the gateway: its template for the computer image, which it maps to each provider's own image |
| `HEADLESS_COMPUTER_PAUSE_SECONDS` | `300` | Pause a computer this long after its last turn, unless a `background` job runs |
| `HEADLESS_COMPUTER_KEEP_DAYS` | `14` | Freestyle deletes a computer unused this long |
| `HEADLESS_SENTRY_DSN` | unset | Optional Sentry error reports (both hosts, posted over `fetch`): failed turns by error code, startup recovery errors and 500s. Codes, ids and counts only, never content or credentials. Unset sends nothing |
| `HEADLESS_SENTRY_ENVIRONMENT`, `HEADLESS_SENTRY_RELEASE` | unset, `headless-runner@<HEADLESS_RUNNER_VERSION>` | Tags on those reports |
| `HEADLESS_RUNNER_VERSION` | set by the image | Tagged `runnerVersion` on reports |
| `HEADLESS_DEN_API_URL` | unset | Den's API for [self-resume](#self-resume), e.g. `https://api.openworklabs.com`. https (plain http only on loopback, since the runner sends its callback token and grants there and gets MCP tokens back). Set all three self-resume settings or none |
| `HEADLESS_DEN_CALLBACK_TOKEN` | unset | ≥32 chars, the same value as den-api's `DEN_HEADLESS_RUNNER_CALLBACK_TOKEN` (not `HEADLESS_API_TOKEN`) |
| `HEADLESS_GRANT_KEY` | unset | ≥32 chars, encrypts resume grants at rest. Changing it makes kept grants unreadable: those turns wait for their callers |

## Run

```sh
pnpm --filter @openwork-ee/headless-runner typecheck
pnpm --filter @openwork-ee/headless-runner run "/^test:/"   # test:conversation, test:sql-store, test:self-resume, …
pnpm --filter @openwork-ee/headless-runner build
HEADLESS_API_TOKEN=… HEADLESS_MODEL_PROTOCOL=anthropic HEADLESS_MODEL_BASE_URL=… HEADLESS_MODEL=gwm_… \
  HEADLESS_MCP_URL=https://api.openworklabs.com/mcp/agent node ee/apps/headless-runner/dist/server.js
```

`pnpm --filter @openwork-ee/headless-runner smoke "<prompt>"` runs one real turn through the HTTP API with a throwaway database. Pass credentials as `SMOKE_MODEL_API_KEY` and `SMOKE_MCP_TOKEN`. It prints the status, token usage (including cached tokens), tools used, files written, elapsed time and RSS. It never prints credentials.

## Deploy as a single Node process (Render or any Node host)

This is the single-node deployment: one `node dist/server.js` process with its SQLite file on a persistent disk. It
is what Docker (`packaging/docker/Dockerfile.headless-runner`) and the AWS Terraform module run. OpenWork's own
production runner runs on celld instead (see [Run on celld](#run-on-celld-no-disk)). **A celld deployment must set
`HEADLESS_FILES=s3` or `off`**: it refuses `disk` (`cells_require_s3_files`); see
[OWNER-CELLS.md](./OWNER-CELLS.md).

On Render, create a **private service** so it has no public URL; only den-api and Workbot reach it. Use stable Node.js 24.x, version 24.22.1 or newer within that major.

| Setting | Value |
|---|---|
| Build command | `corepack enable && pnpm install --frozen-lockfile --filter @openwork-ee/headless-runner... && pnpm --filter @openwork-ee/headless-runner build` |
| Start command | `node ee/apps/headless-runner/dist/server.js` |
| Disk | Mount at `/var/data`, then set `HEADLESS_DB_PATH=/var/data/headless.sqlite` |
| Instances | 1. A service with a disk runs as a single instance, and a deploy restarts in-flight turns, which Den resumes |
| Env | `HEADLESS_API_TOKEN`, `HEADLESS_MODEL_PROTOCOL`, `HEADLESS_MODEL_BASE_URL`, `HEADLESS_MODEL`, `HEADLESS_MODEL_API_KEY`, `HEADLESS_MCP_URL` |
| Files (optional) | `HEADLESS_FILES=s3` with celld's bucket settings, so conversations moved from celld keep their files. Keep the disk for SQLite only |

On den-api, set `DEN_HEADLESS_RUNNER_URL` to the private service address (for example `http://headless-runner:8795`) and `DEN_HEADLESS_RUNNER_TOKEN` to the same value as `HEADLESS_API_TOKEN`. With the runner set, scheduled cloud agent Automations run on it for organizations whose plan includes it (every organization when plan gating is off); there is no flag for it. For Slack, turn on **Slack Assistant** per organization in `/admin` and set up the Slack connector.

## Limits and next steps

- **Single instance.** State is one SQLite file. Scale by sharding sessions across instances, each with its own volume.
- **Credentials come from the caller.** For Slack, Den mints a short-lived, run-scoped MCP token (client `openwork-headless-run`, at most 60 minutes) for the linked member on every admitted run, and a fresh one each time it resumes a turn that paused for `credentials_refresh`. A run can last hours while no token outlives an hour, and a run nobody supervises loses its tools within the hour, unless it was sent with a resume grant ([Self-resume](#self-resume)).
- **Callers.** Slack replies and cloud agent Automations (`den-api/src/automations/headless-agent-executor.ts`) both use Den's one client, `den-api/src/headless-runner/client.ts`. Each Automation run is one turn in its own session; its session and message id are saved before the turn is sent, so a Den restart resumes the same turn.

## Computer providers

`HEADLESS_COMPUTER=off` remains the default. `freestyle` keeps the existing
snapshot default and `hc-<session hash>` names, so existing conversations adopt
their current computers. The runtime now uses `@openwork/sandbox` run/files
blocks rather than embedding a provider SDK client.

For Daytona, build a **computer** snapshot in your own Daytona organization:

```sh
DAYTONA_API_KEY=… pnpm --filter @openwork-ee/headless-computer snapshot:build:daytona
```

The script prints the `HEADLESS_COMPUTER_SNAPSHOT` to set. It installs the same
Python, Office and media tools as the Freestyle computer; an OpenWork Web
snapshot is not interchangeable with it. The build uses the Daytona CLI and
needs it installed; runtime operations use the shared SDK adapter.

Set `HEADLESS_COMPUTER=daytona`, `DAYTONA_API_KEY`, and that
`HEADLESS_COMPUTER_SNAPSHOT`. Optional: `DAYTONA_API_URL`, `DAYTONA_TARGET`,
`HEADLESS_COMPUTER_SCOPE`. Neither your model key nor Den token enters the
computer image or sandbox. Daytona uses stop/start when memory-preserving pause
is unavailable. Disk survives; do not depend on in-memory background processes
surviving a stop. The job checks for background work before stopping an idle
computer. An unknown command timeout is reported honestly and never retried.

For the visible Workbot desktop, use `HEADLESS_COMPUTER_CLASS=linux-vm` and
`HEADLESS_COMPUTER_DESKTOP=true` with a prepared desktop snapshot. That class
preserves memory, receives provider auto-pause, and renews a retention deadline
from `HEADLESS_COMPUTER_KEEP_DAYS` so paused disks can expire too. Desktop mode
rejects container snapshots. See [Workbot's Computer tab](../../../docs/computer-use/workbot.md)
for image preparation, shared applications and the live microVM lifecycle check.

### Sandbox gateway

A sandbox gateway sits in front of several providers and is configured apart
from `HEADLESS_COMPUTER`. Today that is
[Differently](https://github.com/different-ai/differently), a self-hostable
control plane in front of OpenSandbox, Daytona and Freestyle. Set
`SANDBOX_GATEWAY=differently`, `SANDBOX_GATEWAY_URL`, `SANDBOX_GATEWAY_API_KEY`
(a project-scoped key) and `SANDBOX_GATEWAY_TEMPLATE`. The gateway holds the
provider keys and decides by its own policies which provider runs each computer.

Only sessions created or updated with `sandboxGateway: true` use it. Workbot
sends that for organizations with the `sandboxGateway` feature flag on, so one
organization can try the gateway while the rest stay on the runner's own
provider. Sessions without the setting never touch the gateway, even when the
runner's own provider is down.

A session's computer is placed when one is first needed, and the runner records
which side made it (the `computer_sides` table):

- **Gateway healthy:** the computer is started through the gateway and stays
  there. Health is infrastructure only: Differently answers
  `GET /v1/capabilities` and an enabled pool is healthy. The answer is kept for
  30 seconds, and each change is logged once.
- **Gateway unhealthy, or it can't start the computer** (unreachable, a timeout,
  a 5xx, or a sandbox that failed to start): the computer is made on
  `HEADLESS_COMPUTER` instead. A failed start marks the gateway unhealthy, so
  later sessions skip it until the next check.
- **The gateway refuses** (a quota, no eligible pool, a permission or an
  unsupported request): the call fails. That is the gateway's policy, and the
  runner never routes around it.
- **A computer stays where it was made.** One on the gateway errors while the
  gateway is down. One made on the runner's own provider is kept until it is
  gone; the session's next computer goes through the gateway again.
- **The flag is on but the runner has no gateway:** the session keeps
  `HEADLESS_COMPUTER`, and the runner logs it once per session.
- **The flag is switched:** the session's next computer comes from the other
  side. The one it had pauses and expires where it was, and deleting the session
  removes both.

Gateway computers share the runner's scope, pause, keep-days, persistence and
desktop settings, and ask for Daytona's size (2 CPUs, 4 GiB, 8 GiB disk). They
are paused when idle only where every pool the gateway lets the runner's key
use can pause or stop (pools that can only stop are stopped, keeping the disk),
which the adapter reads from Differently as it creates them. Elsewhere (for
example OpenSandbox on Kubernetes without a snapshot registry) an idle computer
runs until Differently's TTL removes it. With only a gateway configured,
sessions without the setting get no computer. The desktop viewer needs a gateway pool that publishes port
URLs: Freestyle, Daytona, or OpenSandbox behind its ingress gateway, Fast
Sandbox microVMs included. Differently's
[OpenWork guide](https://github.com/different-ai/differently/blob/pre-release/docs/guides/openwork.md)
covers the server side.

#### Fast Sandbox microVMs

OpenSandbox's Fast Sandbox runs each computer as a Firecracker microVM restored
from a template's memory snapshot. The template is built from
`Dockerfile.desktop-fast-sandbox`, a layer on the desktop image:

```sh
docker build -f ee/packages/headless-computer/Dockerfile.desktop -t <registry>/workbot-desktop:<tag> .
docker build -f ee/packages/headless-computer/Dockerfile.desktop-fast-sandbox \
  --build-arg DESKTOP_IMAGE=<registry>/workbot-desktop:<tag> -t <registry>/workbot-desktop-fast-sandbox:<tag> ee/packages/headless-computer
```

Create the template (OpenSandbox `POST /v1/templates`) with 2 CPUs, `4Gi` memory
and `8Gi` disk, `entrypoint: ["/usr/local/sbin/fast-sandbox-guest-init", "tail",
"-f", "/dev/null"]`, and a readiness probe that waits for the desktop:
`cmd://printf '{}' | /usr/local/sbin/openwork-desktop-bridge call /health`. The
entrypoint starts the desktop as the runner does, so the snapshot captures it
running, as the Freestyle snapshot does; it also fixes `/run`'s mode and keeps
the clock with chrony. Point the Differently template's image for that pool at the
template's id.

The guest kernel must have nftables' `inet` family, `reject` and the owner match
built in, or the desktop's egress guard cannot load and the desktop refuses to
start; OpenSandbox 1.2.0's stock kernel has none of them (Differently's
OpenSandbox pools guide lists the options). Measured on Azure
(`Standard_D16s_v6`, nested KVM): a computer is running in about 2 s once the
template is on the node; pause, which writes a full checkpoint of disk and
memory, takes about three minutes and resume about a second, with processes and
open windows kept.

Opt-in verification, creating and cleaning one real computer:

```sh
HEADLESS_COMPUTER=daytona DAYTONA_API_KEY=… HEADLESS_COMPUTER_SNAPSHOT=… pnpm --filter @openwork-ee/headless-computer proof:live
HEADLESS_COMPUTER=freestyle FREESTYLE_API_KEY=… pnpm --filter @openwork-ee/headless-computer proof:live
SANDBOX_GATEWAY=differently SANDBOX_GATEWAY_URL=… SANDBOX_GATEWAY_API_KEY=… SANDBOX_GATEWAY_TEMPLATE=… pnpm --filter @openwork-ee/headless-computer proof:live
```
