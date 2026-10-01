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
| **Cheap** | One process serves many sessions, and an idle session is just rows. Anthropic prompt caching sits on the system prompt and the newest message, so each agent step reuses the previous prefix. In the smoke test, 123k of 167k input tokens were cache reads. Tool output, steps, file sizes and context are all capped. |
| **Reliable** | Every step is written to SQLite (WAL) before the next one starts. Sends are idempotent on `messageId`. Follow-ups sent while a turn runs are queued per conversation and answered in order, each seeing the earlier answers; the caller never has to retry "busy". After a crash or restart, turns are marked `interrupted`; sending the same `messageId` again resumes them. A tool call whose result was never recorded is **not re-run**: it is recorded as an error so the model can check its effect instead of repeating a possible write. Model calls retry on 408/409/425/429/5xx with backoff. There is a turn timeout, a step cap, and a global concurrency limit. |
| **Safe** | No shell, no host filesystem, no child processes. Network access goes only to the two operator-configured URLs (https, or http on loopback). Callers can't redirect it. Model keys and MCP tokens are supplied per turn, held in memory only, and never written to disk or logs (a test checks this). File paths are normalized so they can't escape the session. A service bearer token (≥32 chars) guards every `/v1` route. `HEADLESS_MCP_TOOL_ALLOWLIST` can narrow the MCP tools. The default system prompt asks the model to read and draft, and to change data only when explicitly asked. |
| **Simple** | About 1,400 lines of source, four runtime deps (`hono`, `@hono/node-server`, `@modelcontextprotocol/client`, `zod`), and `node:sqlite`. No agent framework, no provider SDKs. |

## API

All `/v1` routes require `Authorization: Bearer $HEADLESS_API_TOKEN`.

| Method | Path | Body / query | Result |
|---|---|---|---|
| `GET` | `/health` | | `{ ok: true }` |
| `GET` | `/v1/models` | | `{ defaultModel, models: [{ id, name }] }`: the models the Gateway route serves with the runner's key (cached 5 min), for pickers. Pass one as a turn's `model` |
| `POST` | `/v1/sessions` | `{ title?, instructions? }` | session (`hs_…`) |
| `PUT` | `/v1/sessions/:id` | `{ title?, instructions? }` | `201` session when created, `200` when updated. The caller picks the id (`hs_` + 8–96 of `A-Za-z0-9_-`), so it can keep one durable conversation per person without storing the runner's id. Den's Workbot derives one per member |
| `POST` | `/v1/sessions/:id/turns` | `{ messageId, prompt, model?, credentials: { modelApiKey?, mcpToken? } }` | `202 { state: accepted \| resumed \| already_present, turn }`. A message sent while another turn runs is accepted and answered next (`turn.status: queued`); only a runaway queue of 20+ returns `429 too_many_queued` |
| `GET` | `/v1/sessions/:id` | `?messageId=&limit=` | `{ session, status: idle \| busy, turns, messages, finalAssistantText }` |
| `POST` | `/v1/sessions/:id/abort` | `{ messageId? }` | `{ accepted }`. With a `messageId`, stops only that turn (running or queued); without one, stops the running turn and every follow-up queued behind it |
| `GET` | `/v1/sessions/:id/files` | | `{ files: [{ path, size, updatedAt }] }` |
| `GET` | `/v1/sessions/:id/files/content` | `?path=` | file text |
| `DELETE` | `/v1/sessions/:id` | | `204` |

Turn status is one of `queued`, `running`, `completed`, `failed`, `interrupted` or `aborted`. `failed` and `interrupted` can be resumed by re-sending the same `messageId` with fresh credentials; `aborted` cannot. The `error` field holds a stable code:

- `model_credentials_missing`
- `mcp_unavailable`
- `model_http_<status>`
- `turn_timeout`
- `max_steps_exceeded`
- `runner_restarted`

Images that a tool returns (MCP `image` content, or `resource` blobs with an image type), for example a file read from Slack, are passed to the model as image input: PNG, JPEG, GIF or WebP, at most 4 per result and about 3.7 MB each. They go to Anthropic as image blocks in the tool result, and to OpenAI as image parts in a following user message. Only the turn that fetched an image sees it; later turns keep the text. The session API reports `imageCount` instead of the image data.

The model sees these tools:

- OpenWork MCP tools as the server names them, e.g. `search_capabilities` and `execute_capability`
- `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`

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
| `HEADLESS_MAX_STEPS` | `30` | Model calls per turn |
| `HEADLESS_TURN_TIMEOUT_MS` | `3600000` | Matches the 60-minute bound Den puts on headless Slack runs and their MCP tokens |
| `HEADLESS_MAX_OUTPUT_TOKENS` | `8192` | Output cap per model call: Anthropic `max_tokens`, OpenAI `max_completion_tokens` |
| `HEADLESS_CONTEXT_CHAR_BUDGET` | `400000` | Older whole turns are dropped past this |
| `HEADLESS_SYSTEM_PROMPT` | built-in | |

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

On den-api, set `DEN_HEADLESS_RUNNER_URL` to the private service address (for example `http://headless-runner:8795`) and `DEN_HEADLESS_RUNNER_TOKEN` to the same value as `HEADLESS_API_TOKEN`. Then, per organization in `/admin`, turn on **Slack Assistant** and **Slack Assistant: headless runtime** for Slack, and **Cloud Automations: headless runtime** for scheduled cloud Automations.

## Limits and next steps

- **Single instance.** State is one SQLite file. Scale by sharding sessions across instances, each with its own volume.
- **Credentials come from the caller.** For Slack, Den mints a short-lived, run-scoped MCP token (client `openwork-headless-run`, at most 60 minutes) for the linked member on every admitted run.
- **Callers.** Slack replies and cloud agent Automations (`den-api/src/automations/headless-agent-executor.ts`) both use Den's one client, `den-api/src/headless-runner/client.ts`. Each Automation run is one turn in its own session; its session and message id are saved before the turn is sent, so a Den restart resumes the same turn.
