# AI Gateway: OpenCode setup

- **Feature key:** `gatewayOpenCodeSetup`
- **Deployments:** cloud and self-hosted, off by default
- **Author:** benjaminshafii
- **Public docs:** `packages/docs/ai-gateway/opencode.mdx`
- **Needs:** the organization's **Allow 3rd party tools & harnesses** setting on
  (see `docs/features/gateway-member-api-keys/README.md`)

OpenCode joins Cursor, Codex, Claude Code and Claude Desktop in the tool choice
for AI Gateway API keys: **My Library › Models › Set up**, and **Start using
this key** after a key is created.

## What people see

Picking **OpenCode** shows three steps:

1. `export OPENWORK_API_KEY="<key>"` for their shell profile (the key just
   created is filled in).
2. A choice of default model, and an `opencode.json` to copy: an `openwork`
   provider on `@ai-sdk/openai-compatible`, pointed at the Gateway's OpenAI base
   URL, with every model and Smart Router the person can use listed by its
   Gateway id, and the chosen one as `model`.
3. `opencode`, with `/models` to switch.

No new Gateway endpoint: OpenCode calls the same `/api/v1/chat/completions`
every OpenAI compatible tool uses, so access rules and spend limits apply as
for any key.

## Turning it off

The OpenCode button and picker entry disappear. Keys and configs people already
copied keep working: they are ordinary AI Gateway API keys.

## Code

`ee/apps/den-web/app/(den)/dashboard/_components/gateway-tool-setup.tsx`
(`useGatewayTools`, `openCodeConfig`, `OpenCodeSteps`).
