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

The script lists Den member credential states, mints a LiteLLM virtual key for each `missing` member, and writes the key to Den with LiteLLM's `token_id` as `externalCredentialId`. Summaries never contain member keys.

Offboard a member by organization membership ID:

```bash
node provision.mjs offboard member_...
```

**Ordering rule:** block the upstream LiteLLM key first, then mark the Den binding blocked. LiteLLM v1.97 accepts its generated `token_id` in `POST /key/block`, so offboarding does not need the plaintext member key.

See [Per-member LLM credentials](../../packages/docs/cloud/share-with-your-team/per-member-llm-credentials.mdx) for the API contract. The executable proof is [`litellm-per-member-credentials.e2e.test.ts`](../../evals/specs/litellm-per-member-credentials.e2e.test.ts).
