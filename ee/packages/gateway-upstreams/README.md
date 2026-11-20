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

Test: `pnpm --filter @openwork-ee/gateway-upstreams test`.
