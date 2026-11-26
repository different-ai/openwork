# @openwork-ee/gateway-upstreams

How AI Gateway reaches a provider, shared by the Gateway (`ee/apps/gateway`) and Den API
(`ee/apps/den-api`):

- `upstream.ts`: the upstream URL for a provider (catalog default, saved override, Vertex,
  Bedrock and Foundry hosts) and the auth header or SigV4 signer for a resolved credential.
- `protocols.ts`: protocol family per provider, per-request protocol per path, auth headers,
  forwarded headers and query filtering, default upstreams.
- `egress.ts`: which hosts the Gateway and Den may call (public HTTPS or operator-allowed origins).
- `aws-sigv4.ts`, `aws-identity-center.ts`, `aws-sso-role-credentials.ts`: AWS signing and
  IAM Identity Center sign-in.
- `gcp-service-account.ts`: Google service-account tokens for Vertex.
- `microsoft-entra.ts`: Microsoft Entra ID token handling.
- `provider-test-signature.ts`: the signature on Den's request for a Gateway provider test.

Node only. It imports no database, server or environment code. The Gateway loads providers and
credentials, refreshes OAuth tokens and runs the provider-test route; Den stores and checks
provider settings. Provider facts shared with Den Web live in `@openwork-ee/gateway-catalog`.

It ships TypeScript source, like `@openwork/features`: Node strips the types at runtime, so
nothing has to be built before the Gateway or Den starts. Files import each other through the
package name (`@openwork-ee/gateway-upstreams/egress`), and use only syntax Node can strip
(no enums, namespaces or constructor parameter properties; `scripts/check-node-source-imports.mjs`).
`build` only emits the type declarations other packages typecheck against.

## Bedrock guardrails (Preview)

`bedrock-guardrail.ts` supplies shared, pure request attachment (`applyBedrockGuardrail`)
and original-client override detection, used by Gateway runtime forwarding and provider
tests for the off-by-default `bedrockGuardrails` rollout. Gateway/Den resolve the
organization-owned feature; this package does not read the database or independently
resolve a member's rollout. The non-secret settings are `guardrailIdentifier` and
`guardrailVersion`, supplied together.

Attach to the final request before auth: `guardrailConfig` in Converse/ConverseStream
JSON, and `X-Amzn-Bedrock-GuardrailIdentifier` / `X-Amzn-Bedrock-GuardrailVersion` headers
for InvokeModel/InvokeModelWithResponseStream. Preserve the model-native Invoke body.
Do not infer coverage from `bedrock_converse` alone (Invoke is passthrough). Ensure
runtime retries that recreate headers retain the same settings and sign the final bytes.
With the feature on, a configured guardrail on Mantle must be refused. With the flag
off or no guardrail configured, leave the pre-feature bytes unchanged; an AWS IAM deny,
not an ignored saved setting, must enforce omission failures.

See [internal rollout and manual AWS validation](../../../docs/features/bedrock-guardrails/README.md).
This off-by-default Preview still requires real-product evidence and AWS validation;
source coverage is not a live AWS validation claim.

Test: `pnpm --filter @openwork-ee/gateway-upstreams test`.
