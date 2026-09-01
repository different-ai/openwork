# LiteLLM per-member keys

This dependency-free Node.js example owns the lifecycle of OpenWork Cloud per-member LLM credential bindings backed by LiteLLM virtual keys. It is an example provisioner, not a native LiteLLM integration in Den.

## Configure

| Environment variable | Required | Purpose |
| --- | --- | --- |
| `OPENWORK_DEN_API_URL` | Yes | Den API base URL |
| `OPENWORK_DEN_TOKEN` | Yes | Organization owner or admin bearer token |
| `OPENWORK_ORG_ID` | Yes | Organization ID sent as `x-openwork-org-id` |
| `OPENWORK_LLM_PROVIDER_ID` | Yes | Custom `per_member` provider record ID |
| `LITELLM_BASE_URL` | Yes | LiteLLM base URL, with or without `/v1` |
| `LITELLM_MASTER_KEY` | Yes | LiteLLM proxy admin key |
| `LITELLM_MODELS` | Yes | Comma-separated model groups assigned to each key |
| `OPENWORK_KEY_DURATION` | No | LiteLLM duration such as `30d` for newly minted keys |
| `OPENWORK_RENEW_BEFORE_SECONDS` | No | Renewal window; default `0` only renews expired keys |
| `OPENWORK_DRY_RUN` | No | Set to `1` or `true` to prohibit writes |
| `OPENWORK_WATCH_SECONDS` | No | Daemon interval used by bare `--watch`; default `300` |

## Run

One reconciliation adopts or provisions missing bindings, renews keys inside the expiry window, and offboards members whose provider grant disappeared:

```bash
node provision.mjs reconcile --key-duration 30d --renew-before 86400
```

Preview the complete computation without writing to Den or LiteLLM:

```bash
node provision.mjs reconcile --dry-run
```

Run continuously. Reconciliations are single-flight, intervals have jitter, and `SIGINT`/`SIGTERM` stop cleanly:

```bash
node provision.mjs reconcile --watch
node provision.mjs reconcile --watch 60
```

Explicitly offboard one membership when it is still in Den's granted-member list:

```bash
node provision.mjs offboard member_...
```

Every action is one JSON line with `ts`, `action`, `outcome`, and optional safe detail. Credential material is redacted and is never included in summaries.

## Reconciliation behavior

The provisioner first verifies the exact Den provider and synchronizes configured model limits and capability facts from LiteLLM `GET /model_group/info`. Missing metadata fails closed before any key lifecycle write.

For a missing binding it searches paginated LiteLLM `GET /key/list` results for the stable alias `openwork-<orgMembershipId>` or matching member email metadata. LiteLLM v1.97 Community returns only a key hash and gates `/key/regenerate` behind Enterprise, so plaintext material cannot be adopted directly. The honest Community variant is a mint-and-alias-swap: move the old alias aside, mint replacement material under the stable alias, PUT that material and its new `token_id` into Den, then delete the old key. The final upstream key count does not increase. A failed Den PUT compensates by deleting the replacement and restoring the old alias.

`--key-duration` is sent as LiteLLM's `duration`. Active binding expiry is read through `GET /key/info`; a key whose expiry is within `--renew-before` is replaced and written with Den's current `expectedVersion`.

Automatic offboarding discovers removed grants from the previous lifecycle pass and from provisioner-owned LiteLLM key metadata. It calls LiteLLM `POST /key/block` first and Den's block route second. If any upstream block fails, Den remains active and the reconciliation summary reports a failure.

Every non-missing, non-blocked binding is also checked through LiteLLM `GET /key/info`. If its external key identifier no longer resolves, the provisioner calls Den's stale route; dry-run reports the same action without writing. Stale bindings are deliberately **not** re-minted automatically. They stay stale until the member supplies replacement material through `PUT my-credential`, which keeps unexpected upstream deletion visible and leaves recovery under member control. Later passes verify them but do not increment the stale version again.

## Enterprise security data flow

```text
Member -> Den connect route -> member-specific provider configuration + write-only key
Admin/provisioner -> Den admin routes -> member IDs, state, version, external IDs (no key material)
Admin/provisioner -> LiteLLM admin routes -> key metadata, expiry, block/generate operations
LiteLLM -> provisioner -> Den PUT -> newly minted plaintext key (transient in process memory)
Den -> member -> LiteLLM gateway -> configured upstream model
```

The Den admin token and LiteLLM master key stay only in the provisioner. Den stores member key material write-only and returns only safe external identifiers to admin list calls. LiteLLM receives the membership ID and, when available, the member email as key metadata for deterministic reconciliation. Offboarding never reports a local block before the upstream key is blocked.

## Local proof world

From the repository root, launch the isolated Den and database-backed LiteLLM proof world:

```bash
pnpm world up ./worlds/litellm-per-member.ts
```

Docker, local MySQL, and local Redis are required. The gateway uses a deterministic local OpenAI-compatible witness and does not require a model-provider API key.

Build and run the minimal daemon image with the environment variables above:

```bash
docker build -t litellm-member-reconciler examples/litellm-per-member-keys
docker run --rm --env-file provisioner.env litellm-member-reconciler
```

See [Per-member LLM credentials](../../packages/docs/cloud/share-with-your-team/per-member-llm-credentials.mdx) for the API contract. The executable proof is [`litellm-per-member-credentials.e2e.test.ts`](../../evals/specs/litellm-per-member-credentials.e2e.test.ts).
