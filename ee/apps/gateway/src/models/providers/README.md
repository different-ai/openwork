# Custom model providers

Providers that are not on [models.dev](https://models.dev) but should appear in
the OpenWork model catalog (`https://models.openworklabs.com/api.json`) and be
usable through the AI Gateway.

Drop one JSON file per provider in this folder, named after the provider id
(`example.json`). `src/models/catalog.ts` validates every file and merges it
after `base.json`:

- `scripts/build-models.mjs` publishes it in the catalog Den reads, and
  converts it for the v2 catalog OpenCode v2 engines read
  (`src/models/catalog-v2.ts`). Its `npm` package picks the v2 API entry; write
  the file in the v1 shape below only.
- The gateway reads the same merged catalog for pricing and for the provider's
  SDK package and API URL.

A file that fails validation fails `pnpm --dir ee/apps/gateway models:build`
(and so the gateway build and the catalog publish) with a list of every
problem. `pnpm --dir ee/apps/gateway test` runs the same checks.

## Format

The models.dev shape, keyed by provider id:

```json
{
  "example": {
    "id": "example",
    "name": "Example AI",
    "env": ["EXAMPLE_API_KEY"],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.example.com/v1",
    "doc": "https://docs.example.com/pricing",
    "models": {
      "example-large": {
        "id": "example-large",
        "name": "Example Large",
        "family": "example",
        "attachment": false,
        "reasoning": true,
        "reasoning_options": [{ "type": "effort", "values": ["low", "high", "max"] }],
        "tool_call": true,
        "structured_output": true,
        "temperature": true,
        "open_weights": false,
        "release_date": "2026-08-29",
        "last_updated": "2026-10-29",
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 131072, "output": 32768 },
        "cost": { "input": 0.2, "output": 0.64, "cache_read": 0.018 }
      }
    }
  }
}
```

## Rules

Provider:

- The id is lowercase letters, digits and dashes, matches its key, and is not
  already used by `base.json`, another file here, or a reserved id
  (`openwork`, `amazon-bedrock-mantle`, `microsoft-foundry`, `litellm`, `truefoundry`).
- `name`, `env` (API key variable names), an `https://` `api` URL, and an `npm`
  package the gateway can proxy: `@ai-sdk/openai-compatible`, `@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/mistral`, `@ai-sdk/google` or
  `@openrouter/ai-sdk-provider`.

Each model:

- `id` matches its key, `name`, `release_date` and `last_updated`
  (`YYYY-MM-DD`), `modalities.input` and `modalities.output`.
- `attachment`, `reasoning`, `tool_call` and `temperature` are `true` or
  `false`.
- `limit.context` and `limit.output`: the limits the provider's API actually
  allows, in tokens.
- `cost.input` and `cost.output` in USD per 1M tokens (`cache_read`,
  `cache_write` optional). Only a model with `"status": "deprecated"` may omit
  `cost`; the gateway cannot price it.
- `reasoning_options` entries are `toggle`, `budget_tokens` or
  `effort`. Effort values are `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh` or `max`, and each one is sent to the provider unchanged as
  `reasoning_effort`, so list only values the provider accepts. OpenWork reads
  only `effort`; list `none` to let people turn reasoning off.
