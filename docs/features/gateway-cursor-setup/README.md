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

- **Cursor:** the key, the base URL, and every model's Cursor name to copy,
  with a thinking level for models that have levels.
- **OpenAI Codex:** the key line for the shell, and a `~/.codex/config.toml`
  provider (`wire_api = "responses"`) for the model chosen. Only OpenAI and
  Azure models are offered: Codex calls the provider-less Responses endpoint.
- **Claude Code:** `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and the model
  variables for the model chosen. Only Anthropic, Vertex Claude and Foundry
  models are offered.
- **Another tool:** the key, both base URLs and every model id.

![Cursor's steps](./cursor-steps.png)

The Codex and Claude Code steps use today's provider-less endpoints; dedicated
endpoints for them, like Cursor's, come later.

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

## Turning it off

Turning off `gatewayMemberApiKeys` (or the organization setting) stops member
keys at the Gateway, and `/api/v1/cursor/*` answers `404 not_found` within 15
seconds. The setup screens go with the API keys section. Nothing else is stored
for Cursor, so the model names people added to Cursor work again when it is
turned back on.

## What to watch

- Gateway: 4xx on `/api/v1/cursor/chat/completions` or
  `/api/v1/cursor/responses` with `invalid_cursor_model`
  (Cursor sent a name that isn't ours, for example one of its own model ids),
  `model_not_found` or `unsupported_thinking_level`.
- `gateway_request_logs` rows with `gateway_api_key_id` set carry Cursor's
  traffic like any other 3rd party tool; the requested model is the `gwm_` alias.

## Not checked yet

Not yet called by a real Cursor. Tried on 2026-11-10 with Cursor 3.29.15
pointed at a Gateway on `127.0.0.1`: Cursor answered "The AI model you
selected isn't available" and no request reached the Gateway, which confirms
Cursor calls the base URL from its own servers. A test needs a Gateway on a
public HTTPS URL. Check there: which API Cursor uses for which model (Chat
Completions or Responses), the body it sends (this assumes Chat Completions with flat
tools), what its key verification calls, and that it accepts `/` and `:` in a
model name.

## Proof

`ee/apps/gateway/test/cursor.test.ts` covers names, resolution, the model list,
Chat Completions and Responses (JSON and streamed) translated to Anthropic and
back, refusals, keys, and the feature being off.
`evals/proofs/gateway-cursor-setup.proof.test.ts` drives the page and both APIs
on a real Den and AI Gateway.
