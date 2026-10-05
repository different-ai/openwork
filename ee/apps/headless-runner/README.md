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
| **Cheap** | One process serves many sessions, and an idle session is just rows. Anthropic prompt caching sits on the system prompt and the newest message, so each agent step reuses the previous prefix. In the smoke test, 123k of 167k input tokens were cache reads. Tool output, file sizes and context are capped. A long turn drops its oldest large tool outputs in blocks, so the cached prefix survives most steps. |
| **Reliable** | Every step is written to SQLite (WAL) before the next one starts. Sends are idempotent on `messageId`. Follow-ups sent while a turn runs are queued per conversation and answered in order, each seeing the earlier answers; the caller never has to retry "busy". After a crash or restart, turns are marked `interrupted`; sending the same `messageId` again resumes them. A tool call whose result was never recorded is **not re-run**: it is recorded as an error so the model can check its effect instead of repeating a possible write. Model calls retry on 408/409/425/429/5xx with backoff. Turns have no time or step limit by default (both are optional settings); every model and tool call has its own timeout, and a step that repeats the previous one (same calls, same results) is treated as waiting: each repeat first waits longer (5, 10, 20, then 30 seconds), so checking back on a desktop, CI, or a job is cheap. When the same failure has come back `maxIdenticalFailures` times, or the same answer has kept coming back for `maxWaitingMs`, the model is told (in the system prompt, not the transcript) to stop and report what it was waiting for; a model that still repeats the step ends as `stuck_repeating`. Each caller sets both limits per session in `repeats` (defaults: 10 minutes, 3 failures). A turn using a caller's MCP token pauses itself between steps every 50 minutes (`interrupted`, `credentials_refresh`) so the caller can resume it with a fresh token; no tool call is cut off. There is a global concurrency limit. Each turn logs one line when it starts and one when it ends (status, error code, steps, tool calls, elapsed time, tokens), never content or credentials. |
| **Safe** | No shell, no host filesystem, no child processes. Network access goes only to the two operator-configured URLs (https, or http on loopback). Callers can't redirect it. Model keys and MCP tokens are supplied per turn, held in memory only, and never written to disk or logs (a test checks this). File paths are normalized so they can't escape the session. A service bearer token (≥32 chars) guards every `/v1` route. `HEADLESS_MCP_TOOL_ALLOWLIST` can narrow the MCP tools. The default system prompt asks the model to read and draft, and to change data only when explicitly asked. |
| **Simple** | About 1,900 lines of source, four runtime deps (`hono`, `@hono/node-server`, `@modelcontextprotocol/client`, `zod`), the workspace's `@openwork/workbook` for Office files, and `node:sqlite`. No agent framework, no provider SDKs. The build bundles the workspace package into `dist/server.js` with esbuild, so it runs on plain Node. |

## API

All `/v1` routes require `Authorization: Bearer $HEADLESS_API_TOKEN`.

| Method | Path | Body / query | Result |
|---|---|---|---|
| `GET` | `/health` | | `{ ok: true }` |
| `GET` | `/v1/models` | | `{ defaultModel, models: [{ id, name }] }`: the models the Gateway route serves with the runner's key (cached 5 min), for pickers. Pass one as a turn's `model` |
| `POST` | `/v1/sessions` | `{ title?, instructions?, repeats?: { maxWaitingMs?, maxIdenticalFailures? }, files?, computer?, reactions? }` | session (`hs_…`). `files`, `computer` and `reactions` are off unless set to `true` (see [Isolation](#isolation)) |
| `PUT` | `/v1/sessions/:id` | same body as `POST` | `201` session when created, `200` when updated; settings left out keep their value. The caller picks the id (`hs_` + 8–96 of `A-Za-z0-9_-`), so it can keep one durable conversation per person without storing the runner's id. Den's Workbot derives one per member |
| `POST` | `/v1/sessions/:id/turns` | `{ messageId, prompt, model?, credentials: { modelApiKey?, mcpToken? } }` | `202 { state: accepted \| resumed \| already_present, turn }`. A message sent while another turn runs is accepted and answered next (`turn.status: queued`); only a runaway queue of 20+ returns `429 too_many_queued` |
| `GET` | `/v1/sessions/:id` | `?messageId=&limit=&outputs=` | `{ session, status: idle \| busy, turns, messages, finalAssistantText }`. `outputs=none` returns each tool result's `outputLength` instead of its output, for callers that poll a long turn |
| `POST` | `/v1/sessions/:id/abort` | `{ messageId? }` | `{ accepted }`. With a `messageId`, stops only that turn (running or queued); without one, stops the running turn and every follow-up queued behind it |
| `GET` | `/v1/sessions/:id/files` | | `{ files: [{ path, size, updatedAt }] }` |
| `GET` | `/v1/sessions/:id/files/content` | `?path=` | file text |
| `DELETE` | `/v1/sessions/:id` | | `204` (also deletes its saved files' bytes) |
| `GET` | `/v1/files/status` | | `{ enabled, kind, maxFileBytes, maxSessionBytes }` |
| `POST` | `/v1/sessions/:id/saved-files` | `?name=`, raw body typed by `Content-Type` | `201` saved file (`fl_…`). Send its id in a turn's `attachments`. `403 files_not_enabled` for a session without `files: true`; `413 file_too_large` or `413 files_full` past the limits |
| `GET` | `/v1/sessions/:id/saved-files` | | `{ files }`, newest first, `source: user \| agent` |
| `GET` | `/v1/sessions/:id/saved-files/:fileId` | | the bytes, with `x-file-name` |
| `DELETE` | `/v1/sessions/:id/saved-files/:fileId` | | `204` |

Turn status is one of `queued`, `running`, `completed`, `failed`, `interrupted` or `aborted`. `failed` and `interrupted` can be resumed by re-sending the same `messageId` with fresh credentials; `aborted` cannot. The `error` field holds a stable code:

- `model_credentials_missing`
- `mcp_unavailable`
- `model_http_<status>`
- `turn_timeout`
- `max_steps_exceeded` (only with `HEADLESS_MAX_STEPS` set)
- `stuck_repeating`
- `runner_restarted`
- `credentials_refresh` (an `interrupted` turn waiting to be resumed with a fresh MCP token)

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
- `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`
- In a session with `files: true` (and files configured): `list_saved_files`, `open_file` (brings a kept file back into view), `save_file` (hands a scratch file to the person)
- In a session with `computer: true` (and a computer configured): `bash` and `look` (see below)
- In a session with `reactions: true`: `react { emoji, final? }`, one emoji on the person's latest message, the way a colleague reacts in chat. The runner checks it is exactly one emoji and keeps the call in the transcript; the caller shows it (Workbot puts it on the person's message). A step that only reacts with `final: true` ends the turn: the reaction is the whole reply

## Isolation

The runner is a private service with one caller (Den), which authorizes each person before it reaches a session. Within the runner:

- **Opt-in per session.** Configuring files or a computer makes them *available*; a session only gets them when it is created (or updated) with `files: true` / `computer: true`. Slack replies and Automations don't ask, so they keep their exact behavior: no file tools, no computer, no uploads, and the preview route never starts a computer for them.
- **Files belong to one session.** Every read, download, preview and delete looks a file up by session id *and* file id, and bytes are stored under `sessions/<sessionId>/<fileId>`. Deleting a session deletes its bytes and its computer.
- **Limits.** `HEADLESS_FILES_MAX_BYTES` (100 MB) per file, enforced while the upload streams in (with or without `Content-Length`), and on `save_file` and computer outputs. `HEADLESS_FILES_MAX_SESSION_BYTES` (5 GB) per session in total. Past either, the upload gets `413`, and the model is told why so it can say so.
- **Storage credentials.** Use a store or bucket for this runner alone, with credentials scoped to it. For Vercel Blob, the store's own read-write token is passed explicitly, so the SDK never uses other `BLOB_READ_WRITE_TOKEN` or OIDC credentials in the environment. Neither the storage credentials nor the Freestyle key ever enter a computer.
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

## Configuration

| Variable | Default | |
|---|---|---|
| `HEADLESS_API_TOKEN` | required | Service token for callers, ≥32 chars |
| `HEADLESS_MODEL_PROTOCOL` | required | `anthropic` or `openai` |
| `HEADLESS_MODEL_BASE_URL` | required | e.g. `https://gateway.openworklabs.com/api/v1/providers/ipr_…` |
| `HEADLESS_MODEL` | required | Default model alias (`gwm_…`) |
| `HEADLESS_MODEL_API_KEY` | unset | Fallback key for single-tenant use; callers normally send their own |
| `HEADLESS_MCP_URL` | unset | e.g. `https://api.openworklabs.com/mcp/agent` |
| `HEADLESS_MCP_TOOL_ALLOWLIST` | all | Comma-separated MCP tool names |
| `HEADLESS_DB_PATH` | `./data/headless.sqlite` | Put it on a persistent volume |
| `HEADLESS_PORT` | `8795` | |
| `HEADLESS_MAX_CONCURRENT_TURNS` | `32` | Process-wide. Turns mostly wait on the network, so this is bounded by memory and Gateway rate limits, not CPU |
| `HEADLESS_MAX_STEPS` | `0` | Model calls per turn. `0` means no limit: a long task ends with its answer, Stop, or the stuck check |
| `HEADLESS_TURN_TIMEOUT_MS` | `0` | `0` means no limit. Otherwise at least `10000`, applied to each stretch between credential refreshes |
| `HEADLESS_CREDENTIAL_REFRESH_MS` | `3000000` | A turn with an MCP token pauses between steps after this long so the caller resumes it with a fresh one. Keep it under the token lifetime (60 minutes for Den) |
| `HEADLESS_MAX_OUTPUT_TOKENS` | `8192` | Output cap per model call: Anthropic `max_tokens`, OpenAI `max_completion_tokens` |
| `HEADLESS_CONTEXT_CHAR_BUDGET` | `400000` | Older whole turns are dropped past this. A turn that outgrows it alone replaces its oldest large tool outputs with a short note, in blocks of eight |
| `HEADLESS_SYSTEM_PROMPT` | built-in | |
| `HEADLESS_FILES` | `off` | Saved files: `off`, `disk`, `s3`, or `vercel`. Only sessions created with `files: true` use them. Off means the file routes answer `files_not_configured` |
| `HEADLESS_FILES_MAX_BYTES` | `104857600` (100 MB) | Largest single kept file |
| `HEADLESS_FILES_MAX_SESSION_BYTES` | `5368709120` (5 GB) | Most one session may keep in total |
| `HEADLESS_FILES_DIR` | `files` next to `HEADLESS_DB_PATH` | For `disk`. Defaults to the database's volume so files survive deploys; disk is for development, use a store in production |
| `HEADLESS_VERCEL_BLOB_TOKEN` | | For `vercel`: the read-write token of one **private** Vercel Blob store used only by this runner |
| `HEADLESS_S3_ENDPOINT` | | For `s3`: any S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-east-1.amazonaws.com`, or a self-hosted MinIO/RustFS |
| `HEADLESS_S3_REGION` | `auto` | `auto` for R2; the bucket's region for AWS |
| `HEADLESS_S3_BUCKET`, `HEADLESS_S3_ACCESS_KEY_ID`, `HEADLESS_S3_SECRET_ACCESS_KEY` | | For `s3` |
| `HEADLESS_S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and most self-hosted stores |
| `HEADLESS_COMPUTER` | `off` | `freestyle` makes a computer available to sessions created with `computer: true` |
| `FREESTYLE_API_KEY` | | For `freestyle`. Use a Freestyle account for this runner alone; the key never enters a VM |
| `HEADLESS_COMPUTER_SNAPSHOT` | built from the package | Snapshot id or slug new computers boot from |
| `HEADLESS_COMPUTER_PAUSE_SECONDS` | `300` | Pause a computer this long after its last turn, unless a `background` job runs |
| `HEADLESS_COMPUTER_KEEP_DAYS` | `14` | Freestyle deletes a computer unused this long |

## Run

```sh
pnpm --filter @openwork-ee/headless-runner test
pnpm --filter @openwork-ee/headless-runner build
HEADLESS_API_TOKEN=… HEADLESS_MODEL_PROTOCOL=anthropic HEADLESS_MODEL_BASE_URL=… HEADLESS_MODEL=gwm_… \
  HEADLESS_MCP_URL=https://api.openworklabs.com/mcp/agent node ee/apps/headless-runner/dist/server.js
```

`pnpm --filter @openwork-ee/headless-runner smoke "<prompt>"` runs one real turn through the HTTP API with a throwaway database. Pass credentials as `SMOKE_MODEL_API_KEY` and `SMOKE_MCP_TOKEN`. It prints the status, token usage (including cached tokens), tools used, files written, elapsed time and RSS. It never prints credentials.

## Deploy on Render

Create a **private service** so it has no public URL; only den-api reaches it. Use Node 22.13 or later.

| Setting | Value |
|---|---|
| Build command | `corepack enable && pnpm install --frozen-lockfile --filter @openwork-ee/headless-runner... && pnpm --filter @openwork-ee/headless-runner build` |
| Start command | `node ee/apps/headless-runner/dist/server.js` |
| Disk | Mount at `/var/data`, then set `HEADLESS_DB_PATH=/var/data/headless.sqlite` |
| Instances | 1. A service with a disk runs as a single instance, and a deploy restarts in-flight turns, which Den resumes |
| Env | `HEADLESS_API_TOKEN`, `HEADLESS_MODEL_PROTOCOL`, `HEADLESS_MODEL_BASE_URL`, `HEADLESS_MODEL`, `HEADLESS_MODEL_API_KEY`, `HEADLESS_MCP_URL` |
| Files (optional) | `HEADLESS_FILES=vercel` and `HEADLESS_VERCEL_BLOB_TOKEN`. Keep the 1 GB disk for SQLite only |

**Kept files in production** use a private Vercel Blob store in the `prologe` team, region `iad1` (next to the service's Virginia region):

| Store | For | Token |
|---|---|---|
| `openwork-headless-files` | the Render runner | Infisical `prod`, `/headless-runner/HEADLESS_VERCEL_BLOB_TOKEN` |
| `openwork-headless-files-dev` | local runs and tests | Infisical `dev`, `/headless-runner/HEADLESS_VERCEL_BLOB_TOKEN` |

Both are connected only to the empty Vercel project `openwork-headless-runner` (no code, no deployments), which exists to hold their tokens: production to the production environment, dev to development. Each token reaches only its own store.

On den-api, set `DEN_HEADLESS_RUNNER_URL` to the private service address (for example `http://headless-runner:8795`) and `DEN_HEADLESS_RUNNER_TOKEN` to the same value as `HEADLESS_API_TOKEN`. Then, per organization in `/admin`, turn on **Slack Assistant** and **Slack Assistant: headless runtime** for Slack, and **Cloud Automations: headless runtime** for scheduled cloud Automations.

## Limits and next steps

- **Single instance.** State is one SQLite file. Scale by sharding sessions across instances, each with its own volume.
- **Credentials come from the caller.** For Slack, Den mints a short-lived, run-scoped MCP token (client `openwork-headless-run`, at most 60 minutes) for the linked member on every admitted run, and a fresh one each time it resumes a turn that paused for `credentials_refresh`. A run can last hours while no token outlives an hour, and a run nobody supervises loses its tools within the hour.
- **Callers.** Slack replies and cloud agent Automations (`den-api/src/automations/headless-agent-executor.ts`) both use Den's one client, `den-api/src/headless-runner/client.ts`. Each Automation run is one turn in its own session; its session and message id are saved before the turn is sent, so a Den restart resumes the same turn.
