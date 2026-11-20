# @openwork-ee/gateway-catalog

What AI Gateway knows about providers, shared by the Gateway (`ee/apps/gateway`),
Den API (`ee/apps/den-api`) and Den Web (`ee/apps/den-web`), so each rule is written once:

- `sdk.ts`: the provider SDK packages the Gateway can proxy, the protocol family each speaks,
  and the fixed default upstream per family.
- `bedrock-mantle.ts`, `microsoft-foundry.ts`, `litellm.ts`, `truefoundry.ts`: catalog
  providers derived from, or added beside, the models.dev catalog.
- `model-alias.ts`: the `gwm_` model ids the Gateway hands out.
- `credentials.ts`: which credential kinds and key names a provider can use.

It does no I/O and imports no database, server or environment code, so Den Web can use
it in the browser. Code that reaches a provider or reads storage stays in the apps.

The model catalog data (`ee/apps/gateway/src/models`) and its publish scripts still live
in the Gateway.

Test: `pnpm --filter @openwork-ee/gateway-catalog test`.
