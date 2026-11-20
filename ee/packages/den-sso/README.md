# @openwork-ee/den-sso

The rules for organization SSO in Den, shared by Den API (`ee/apps/den-api`), which enforces them,
and Den Web (`ee/apps/den-web`), which shows them:

- `policy.ts`: the organization's SSO policy from its metadata ("Require SSO", "Restrict this domain
  to our SSO"), login routing, which non-SSO sign-ins are refused, and verified-domain auto-join.
- `last-sign-in.ts`: the last sign-in cookie. Den API decides when to remember or forget a method;
  Den Web reads it before the email step.
- `domain-verification.ts`: the DNS name an organization publishes to verify an SSO domain.
- `entra-domain.ts`: whether a SAML issuer is a Microsoft Entra tenant.
- `readiness.ts`, `jit.ts`, `saml-policy.ts`, `state-identifier.ts`: when SSO is ready, the role
  just-in-time members get, the SAML settings every connection uses, and Better Auth's relay-state key.

It does no I/O and imports no database, server, Better Auth instance or environment code, so Den Web
can use it in the browser. The SSO connections, SCIM and the Better Auth plugins stay in Den API.

It ships TypeScript source, like `@openwork/features`: Node strips the types at runtime, so nothing has
to be built before Den API starts. Files import each other through the package name, and use only syntax
Node can strip (`scripts/check-node-source-imports.mjs`). `build` only emits type declarations.

Test: `pnpm --filter @openwork-ee/den-sso test`.
