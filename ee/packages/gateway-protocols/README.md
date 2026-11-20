# @openwork-ee/gateway-protocols

How AI Gateway reads and writes each wire format. Every function here turns one request or
response shape into another; none of them reach a network, a database or the environment.

- `chat.ts`, `protocol.ts`: the Chat Completions shape Smart Model Router works in, and the
  `AutoTranslator` interface each provider implements.
- `providers/`: Chat Completions to and from Anthropic Messages, Bedrock Converse, Gemini and
  OpenAI Responses, including streams.
- `clients/`: the request and response shapes of Claude Code, Cursor and Codex.
- `reasoning.ts`: reasoning state carried between tool calls. It holds the payload shape, the
  `ReasoningStore` interface and an in-memory store. The Gateway adds the database-backed store.
- `tool-schema.ts`, `prompt-cache.ts`, `output-limit.ts`: request rewrites providers need.
- `usage/`: reading token usage from each provider's JSON and stream responses.

Used by `ee/apps/gateway`, which keeps routing, auth, upstream requests, stream relay and
metering. Provider facts shared with Den live in `@openwork-ee/gateway-catalog`.

It ships TypeScript source, like `@openwork/features` and `@openwork-ee/gateway-catalog`: Node
strips the types at runtime, so nothing has to be built before the Gateway starts. Files import each other
through the package name (`@openwork-ee/gateway-protocols/chat`), because a relative import without a
real file name fails under plain Node (`scripts/check-node-source-imports.mjs`). `build` only emits the
type declarations other packages typecheck against.

Test: `pnpm --filter @openwork-ee/gateway-protocols test`.
