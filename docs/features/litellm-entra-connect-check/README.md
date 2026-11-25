# LiteLLM: verify Microsoft sign-in against the proxy

- **Key:** `litellmEntraConnectCheck`
- **Deployments:** `cloud`, `self_hosted`
- **Default:** `false`
- **Author:** `benjaminshafii`

## What changes

When a member finishes **Connect** on a LiteLLM provider that uses Microsoft sign-in (`keySource: "entra"`), OpenWork currently saves the Entra token without checking whether the LiteLLM proxy actually accepts it. Misconfigured JWT issuers, audiences, missing LiteLLM users (`user_id_upsert: false`), or model allowlists only surface later as a `401` or `403` on the member's first chat request.

With `litellmEntraConnectCheck` enabled, the OAuth callback performs a short, read-only `GET /v1/models` check against the configured LiteLLM proxy using the member's newly acquired Entra access token right after storing their credential:

- **Token accepted and configured models listed:** confirms `"Connection verified with LiteLLM."` on the callback page.
- **Token accepted, but configured models are missing from `/v1/models`:** keeps the sign-in saved and shows an amber notice naming the missing models so the admin can check model names or user/team permissions in LiteLLM.
- **LiteLLM returns `401` or `403`:** keeps the sign-in saved and shows an amber notice classifying the failure (JWT issuer/audience mismatch, unrecognized LiteLLM user, or access denied) without echoing raw upstream text or tokens.
- **Proxy unreachable or non-JSON/unexpected status:** fails open silently and shows the standard `"is connected to OpenWork"` confirmation so sign-in is never blocked by transient network issues or locked-down `/v1/models` endpoints.

Nothing changes for Microsoft Foundry, Google Vertex, AWS Bedrock, or key-based LiteLLM modes.

## How to try it

1. Enable `litellmEntraConnectCheck` for your organization in `/admin` › Features (or via `den_set_org_capability`).
2. Add a LiteLLM provider with **Microsoft sign-in** and click **Connect** in OpenWork.
3. Observe the callback confirmation page:
   - Against a matching LiteLLM proxy, the status line reads `Connection verified with LiteLLM.`
   - When the LiteLLM proxy rejects the JWT (`401`/`403`) or omits a listed model from `/v1/models`, the callback page shows the warning notice immediately.

## Turning it off

Turning `litellmEntraConnectCheck` off (or hitting the kill switch) immediately skips the outbound `GET /v1/models` check on `/v1/inference-providers/oauth/callback`. Stored credentials, refresh behavior, and gateway inference routing are unaffected.

## What to watch

- Den API log event `litellm_entra_connect_check` (sanitized: `providerId`, `outcome` enum, `httpStatus`, `missingCount`, never tokens or raw upstream bodies).
- Latency of `GET /v1/inference-providers/oauth/callback` for LiteLLM Entra providers (the probe is bounded by a 4-second timeout and never follows redirects).
