# AI Gateway: setting up Cursor and other tools

- **Feature key:** `gatewayMemberApiKeys` (part of AI Gateway API keys; see
  `docs/features/gateway-member-api-keys/README.md`)
- **Deployments:** cloud and self-hosted, off by default
- **Author:** OmarMcAdam
- **Public docs:** `packages/docs/ai-gateway/cursor.mdx`
- **Needs:** the organization's **Allow 3rd party tools & harnesses** setting on

Members use the models their organization gives them inside Cursor.

Cursor reaches another provider only through its **OpenAI API Key** and
**Override OpenAI Base URL** settings, and each model is added by typing one
string that is both its id and the name Cursor shows. So:

- the Gateway serves every model, whatever its provider speaks, through both
  OpenAI APIs Cursor may use (Chat Completions and Responses) under one base
  URL: `<gateway>/api/v1/cursor`;
- each model gets a short name a person can paste, instead of its 84-character
  `gwm_…` id.

## Model names

```
openwork/<model name as a slug>-<last 4 characters of the model's id>[:<thinking level>]
openwork/claude-opus-5.5-k3f9
openwork/claude-opus-5.5-k3f9:high
```

- The id is the model's `ipm_…` id (the last part of a `gwm_…` alias).
- The Gateway resolves a name against the models the key's member can use: by
  the id ending first, and by the slug only when two of their models share an
  ending. A renamed model keeps working. Two models with the same ending and the
  same name are refused with `ambiguous_cursor_model`.
- Case, surrounding spaces and a missing `openwork/` are forgiven.
- Cursor doesn't send a reasoning effort for models added this way, so the level
  is part of the name. Without one the provider's default applies. A level the
  model doesn't have is refused with `unsupported_thinking_level`.
- A name selects a model; it never grants one. The request then runs the normal
  Gateway pipeline under the member's own alias (grants, credentials, limits,
  usage, request log).
- The same model granted through several groups or credential sets is one name,
  served through the most specific grant (member, then team, then organization).

Shared code: `packages/types/src/den/gateway-cursor.ts`.

## What people see

**Right after creating a key** (while it can still be shown), the dialog moves
to **Start using this key**: the key once, then a large button per tool:
Cursor, OpenAI Codex, Claude Code and Another tool. Picking one shows that
tool's steps with the key, URLs and model ids already filled in, each with a
copy button; **Choose another tool** goes back.

![Start using this key](./start-using-key.png)

- **Cursor:** the key, the base URL, then a model (and thinking level, for
  models that have levels) to choose from a dropdown, with its Cursor name to
  copy. The last step says to run the agent in Local mode (This Mac), not Cloud.
- **OpenAI Codex:** the key line for the shell profile, and a
  `~/.codex/config.toml` provider on the Gateway's Codex endpoint (below) for a
  model (and thinking level, as `model_reasoning_effort`) chosen from dropdowns.
  Every model is offered.
- **Claude Code:** a project settings file (`.claude/settings.local.json`) for
  a main and a fast model chosen from dropdowns, pointing at the Gateway's
  Claude Code endpoint (below). Every model is offered.
- **Another tool:** the key, both base URLs, and a model to choose with its id
  to copy.

![Cursor's steps](./cursor-steps.png)

Cursor, Claude Code and Codex each have their own endpoint.

![Claude Code's steps](./claude-code-steps.png)

![Codex's steps](./codex-steps.png)

In **My Library › Models**, each key's menu has **Set up**: the same choice of
tools for a key that already exists. The key isn't shown again, so the steps
say which key to use (by its prefix) and leave a place for it. The section
doesn't list the base URLs: each tool's steps carry the ones it needs.

![Set up from a key's menu](./set-up-existing-key.png)

The section also links to **Set up Cursor** (`/dashboard/library/tools/cursor`): the same Cursor steps without a
key, with a link to create one.

![Set up Cursor](./cursor-setup.png)

## How it works

- `GET /api/v1/cursor/models`: the member's models in the OpenAI list shape,
  with the Cursor name as `id` and `openwork.thinking_levels`.
- `POST /api/v1/cursor/chat/completions`: resolves `model`, rewrites the
  request for the model's own protocol with the Smart Model Router's
  translators (`ee/apps/gateway/src/auto-router/`: Anthropic Messages, OpenAI
  Responses, Gemini, Bedrock Converse, OpenAI-compatible chat), forwards it
  through `handleGatewayRequest`, and translates the response back. Code:
  `ee/apps/gateway/src/cursor.ts`.
- `POST /api/v1/cursor/responses`: the same, for the Responses API. The request
  is read as a chat request (instructions, messages, function calls and their
  outputs, images, tools) and the answer is written back as a Responses object,
  or as Responses events when streamed (text, reasoning summaries, function
  calls, then `response.completed`). A `reasoning.effort` the model has is used
  when the name carries no level. Code: `ee/apps/gateway/src/cursor-responses.ts`.
  So a model works through either API, whichever its provider speaks.
- Cursor sends tools in the flat Responses shape (`{type, name, parameters}`) to
  `/chat/completions`; they are nested under `function` first.
- Only `ow_gw_` keys authenticate on `/api/v1/cursor/*`; OpenWork Models keys
  are never looked up. Any other path there is `404 not_found`.
- The page builds the same names in Den web from
  `GET /v1/inference-providers?scope=usable`; there is no new Den API route.

## Claude Code endpoint

`ANTHROPIC_BASE_URL` = `<gateway>/api/v1/claude-code`. Claude Code sends the key
as `Authorization: Bearer` (`ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY` stays
empty). Code: `ee/apps/gateway/src/claude-code.ts`,
`ee/apps/gateway/src/claude-code-messages.ts`. Public docs:
`packages/docs/ai-gateway/claude-code.mdx`.

- `GET /v1/models`: the member's models in Anthropic's list shape, for Claude
  Code's gateway model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`).
  Claude Code lists only Claude models from it.
- `POST /v1/messages` (Claude Code adds `?beta=true`): names are the Cursor names
  with no thinking level, plus `[1m]` on models with a 1M token window (stripped
  before matching). A raw catalog id (`claude-sonnet-4-5`) also resolves when one
  of the member's models has it. A model on a Messages provider (Anthropic,
  Vertex Claude, Foundry) gets the request as it is (thinking, cache control,
  `anthropic-beta`); any other is translated Messages → Chat Completions → the
  model's own protocol, and back as a Messages object or event stream.
  Translated requests ask for at least 16 output tokens: Claude Code checks a
  model it switches to with `max_tokens: 1`, which OpenAI refuses.
- `POST /v1/messages/count_tokens`: an estimate (about four characters a token);
  nothing goes upstream.
- Errors are Anthropic error bodies (`{type: "error", error: {type, message}}`).

The settings file pins Claude Code's Opus, Sonnet, Haiku and subagent slots,
maps Claude models to Claude Code's own ids with `modelOverrides` (so it knows
their limits and features), and sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when the
main model is another provider's.

Checked on 2026-11-10 with Claude Code 2.1.321-322 on a local Den and Gateway with
real Anthropic and OpenAI keys: `claude -p` and interactive sessions with tool
use on Claude Sonnet 4.5 (passed through) and GPT-5 mini (translated), `/model`
discovery and switching. Found there: Claude Code reads the project settings
file only after its first-run sign-in screen; a key in the shell or in
`~/.claude/settings.json` skips it, so the steps say to start it once with
`ANTHROPIC_AUTH_TOKEN="<key>" claude`. Not checked: an existing Claude account
login next to the settings file (the steps follow OpenRouter: `/status`, then
`/logout` if needed).

## Codex endpoint

A Codex provider's `base_url` = `<gateway>/api/v1/codex`. The setup follows
OpenRouter's Codex guide: `model_provider = "openwork"`, `wire_api =
"responses"`, and an `auth` block that runs `sh -c 'echo $OPENWORK_API_KEY'`.
Codex fetches a provider's model catalog only with command auth (`env_key`
works but gives "Model metadata … not found"). Code:
`ee/apps/gateway/src/codex.ts` (the translation is shared with Cursor in
`cursor-responses.ts`). Public docs: `packages/docs/ai-gateway/codex.mdx`.

What Codex 0.167 sends (codex-rs source at `rust-v0.167.1`, and captured):

- `GET {base_url}/models?client_version=0.167.1`, bearer key. It expects
  Codex's own catalog, `{models: [ModelInfo]}` (`codex-protocol`
  `openai_models.rs`), not the OpenAI list; an entry without
  `base_instructions` (or `model_messages.instructions_template`) fails the
  whole catalog. Each entry carries Codex's own base prompt
  (`codex-instructions.ts`, copied from `models-manager/prompt.md`,
  Apache-2.0), the model's context window, reasoning levels, and
  `apply_patch_tool_type: "freeform"` only for OpenAI GPT-5 and later (OpenAI
  refuses custom tools before; translated models edit through the shell tool).
  Codex merges the catalog with its bundled OpenAI models, so `/model` lists
  those too; ours get a negative priority to come first.
- `POST {base_url}/responses`, `stream: true`, `store: false`, `include:
  ["reasoning.encrypted_content"]`, `reasoning: {effort, summary}`,
  `prompt_cache_key`, `client_metadata` (session ids, local paths), the base
  prompt as a developer message (no `instructions`), item ids on every input
  item, and tools: functions, a `namespace` (`multi_agent_v1`), `web_search`,
  and the custom `apply_patch` when the catalog asks for it. Remote compaction
  is off for a provider not named OpenAI, so `/compact` is a normal request.
- OpenAI and Azure models: the request passes through under the member's alias
  within the Gateway's resource policy: `client_metadata` and input item ids
  (except on reasoning items with encrypted content) are dropped, hosted tools
  (`web_search`) and hosted call items are dropped, and the policy now accepts a
  `namespace` of client tools. A model without reasoning loses `reasoning` and
  the encrypted-content include.
- Other models: Responses → Chat Completions → the model's protocol, and back
  as a Responses event stream. Namespaced functions become `<ns>__<name>`,
  custom tools a function taking `{input}`, and both come back as Codex's
  items. `previous_response_id` is refused (Codex never sends it with
  `store: false`); at least 16 output tokens.
- Names are the Cursor names; a level suffix wins over `reasoning.effort`; a
  raw catalog id resolves when the member has that model. Errors are OpenAI
  error bodies.

Checked on 2026-11-10 with Codex 0.167.1 on a local Den and Gateway with real
OpenAI and Anthropic keys, the config exactly as the page writes it:
`codex exec` and a tmux session on GPT-5 mini (passed through, encrypted
reasoning across turns, native `apply_patch`), GPT-4.1 mini (passed through, no
reasoning) and Claude Haiku 4.5 (translated: shell commands, file edits,
`/compact`), `/status`, `/model` with reasoning levels, and switching
GPT → Claude → GPT mid-conversation. Found and fixed there: the Gateway's
resource policy refused Codex's requests (item ids, `client_metadata`'s
`session_id`, `namespace` and `web_search` tools); GPT-4.1 refuses custom
tools; Claude Haiku wrote `apply_patch` text with lost indentation when given
it as a function, so translated models don't get it; Codex's picker listed its
own OpenAI models first. Codex 0.167 keeps the catalog in a background
app-server daemon: a model added later shows after `codex app-server daemon
restart`. The daemon also runs the `auth` command and keeps the environment and
config it started with, and it outlives the terminal: someone who put
`OPENWORK_API_KEY` in `~/.zshrc` after the daemon first started gets 401s in
every new terminal until they restart it. Checked 2026-11-10: a daemon started
without the variable kept sending an empty key from fresh shells that had it,
and from a key file the auth command read; `codex app-server daemon restart`
from a shell with the variable fixed it (`codex exec` is not affected: it reads
the shell's environment). The steps now have a restart step. Not checked: Azure OpenAI, Windows, images, and Codex's own OpenAI
models chosen in `/model` when the member has the same model.

## Turning it off

Turning off `gatewayMemberApiKeys` (or the organization setting) stops member
keys at the Gateway. Requests to `/api/v1/cursor/*`, `/api/v1/claude-code/*`
and `/api/v1/codex/*` using those keys receive `401 invalid_api_key` within
15 seconds. The setup screens go with the API keys section. Nothing else is stored
for Cursor, so the model names people added to Cursor work again when it is
turned back on.

## What to watch

- Gateway: 4xx on `/api/v1/cursor/chat/completions` or
  `/api/v1/cursor/responses` with `invalid_cursor_model`
  (Cursor sent a name that isn't ours, for example one of its own model ids),
  `model_not_found` or `unsupported_thinking_level`.
- `gateway_request_logs` rows with `gateway_api_key_id` set carry Cursor's
  traffic like any other 3rd party tool; the requested model is the `gwm_` alias.

## Checked with a real Cursor

On 2026-11-10 a real Cursor answered through `openwork/gpt-5.6-luna-zp1h` on
production in **Local** mode (This Mac). Cursor's **Cloud** agents still fail
with OpenWork models, so the steps and the public docs tell people to use
Local. Still to look into: why Cloud agents fail, and whether Cursor uses Chat
Completions or Responses for each model.

## Proof

`ee/apps/gateway/test/cursor.test.ts` covers names, resolution, the model list,
Chat Completions and Responses (JSON and streamed) translated to Anthropic and
back, refusals, keys, and the feature being off.
`evals/proofs/gateway-cursor-setup.proof.test.ts` drives the page and both APIs
on a real Den and AI Gateway. `ee/apps/gateway/test/claude-code.test.ts` and
`evals/proofs/gateway-claude-code.proof.test.ts` do the same for Claude Code
(a Claude model passed through, a DeepSeek model translated), and
`ee/apps/gateway/test/codex.test.ts` and `evals/proofs/gateway-codex.proof.test.ts`
for Codex (an OpenAI model passed through, a Claude model translated, with the
config read from the page).
