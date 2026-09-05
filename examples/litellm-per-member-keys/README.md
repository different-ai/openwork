# LiteLLM per-member keys

This zero-dependency Node.js example reconciles OpenWork Cloud per-member LLM credential bindings with LiteLLM virtual keys. It is an example provisioner, not a native LiteLLM integration in Den.

## Configure

Set these environment variables:

- `OPENWORK_DEN_API_URL`: Den API base URL
- `OPENWORK_DEN_TOKEN`: organization owner or admin bearer token
- `OPENWORK_ORG_ID`: organization ID sent as `x-openwork-org-id`
- `OPENWORK_LLM_PROVIDER_ID`: the per-member LLM provider ID
- `LITELLM_BASE_URL`: LiteLLM base URL, with or without `/v1`
- `LITELLM_MASTER_KEY`: LiteLLM master key
- `LITELLM_MODELS`: comma-separated model IDs assigned to each virtual key

Run reconciliation after granting provider access:

```bash
node provision.mjs reconcile
```

Before provisioning keys, the script reads the existing custom, `per_member` provider from Den and reconciles its configured model metadata from LiteLLM `GET /model_group/info` using master-key authentication. It preserves the provider config, model names and unknown model fields, and current member/team access while updating token limits. When LiteLLM supplies the corresponding facts, it also maps function calling, reasoning, vision, response schemas, and temperature support to Den's `tool_call`, `reasoning`, `attachment`, `structured_output`, and `temperature` model fields. It only PATCHes Den when those values changed.

Every model in `LITELLM_MODELS` must have an exact `model_group` match with finite, positive `max_input_tokens` and `max_output_tokens`. Reconciliation fails closed before creating member keys if LiteLLM omits a requested model or either limit. The example never guesses token limits or falls back to a generic value.

After metadata is synchronized, the script lists Den member credential states, mints a LiteLLM virtual key for each `missing` member, and writes the key to Den with LiteLLM's `token_id` as `externalCredentialId`. Summaries report the metadata action and safe model limits but never contain member keys.

## Run the complete local world

From the repository root, launch a signed-in Desktop, an isolated Den organization, and a database-backed LiteLLM gateway with the provider and member keys already reconciled:

```bash
pnpm world up ./worlds/litellm-per-member.ts
```

The command prints the Den URLs, LiteLLM URL, synchronized model limits, Den provider record ID, and Desktop CDP URL. Keep it running while testing and press Ctrl-C to tear down the world. Docker, local MySQL, and local Redis are required. The gateway uses a deterministic local OpenAI-compatible witness and does not read or require `OPENAI_API_KEY`.

Offboard a member by organization membership ID:

```bash
node provision.mjs offboard member_...
```

**Ordering rule:** block the upstream LiteLLM key first, then mark the Den binding blocked. LiteLLM v1.97 accepts its generated `token_id` in `POST /key/block`, so offboarding does not need the plaintext member key.

See [Per-member LLM credentials](../../packages/docs/cloud/share-with-your-team/per-member-llm-credentials.mdx) for the API contract. The executable proof is [`litellm-per-member-credentials.e2e.test.ts`](../../evals/specs/litellm-per-member-credentials.e2e.test.ts).
