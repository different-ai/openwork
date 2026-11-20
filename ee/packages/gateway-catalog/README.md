# @openwork-ee/gateway-catalog

What AI Gateway knows about providers, shared by the Gateway (`ee/apps/gateway`),
Den API (`ee/apps/den-api`) and Den Web (`ee/apps/den-web`), so each rule is written once:

- `sdk.ts`: the provider SDK packages the Gateway can proxy, the protocol family each speaks,
  and the fixed default upstream per family.
- `bedrock-mantle.ts`, `microsoft-foundry.ts`, `litellm.ts`, `truefoundry.ts`: catalog
  providers derived from, or added beside, the models.dev catalog.
- `model-alias.ts`: the `gwm_` model ids the Gateway hands out.
- `credentials.ts`: which credential kinds and key names a provider can use.
- `provider-catalog.ts`: a models.dev-shaped catalog as npm/api/env per provider id, with the
  derived and synthetic providers. The Gateway reads the catalog file itself.

It does no I/O and imports no database, server or environment code, so Den Web can use
it in the browser. Code that reaches a provider or reads storage stays in the apps.

It ships TypeScript source (like `@openwork/features`): Node strips the types at runtime, so
nothing has to be built before the Gateway or Den starts. Files import each other through the
package name (`@openwork-ee/gateway-catalog/litellm`), because a relative import without a real
file name fails under plain Node (`scripts/check-node-source-imports.mjs`). `build` only emits
the type declarations other packages typecheck against.

The model catalog data (`ee/apps/gateway/src/models`) and its publish scripts still live
in the Gateway.

Test: `pnpm --filter @openwork-ee/gateway-catalog test`.
