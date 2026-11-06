# OpenWork Model Catalog

This directory holds the generated OpenWork model catalog. Cloudflare Pages builds it from `dev` through its Git integration and publishes the `models/` folder at `https://models.openworklabs.com`:

- Build command: `pnpm --dir ee/apps/gateway models:build`
- Build output directory: `ee/apps/gateway/models-site/models`
- Catalog URL: `https://models.openworklabs.com/api.json`

The generated `models/api.json` file is ignored by git. `scripts/build-models.mjs` rebuilds it, through `src/models/catalog.ts`, from three sources in this order:

1. `src/models/base.json`: the models.dev snapshot, refreshed by the Update Models workflow.
2. `src/models/providers/*.json`: custom providers that are not on models.dev, one validated file each. See `src/models/providers/README.md`. A file that fails validation fails the build.
3. `src/models/openwork-models.json`: OpenWork-specific models, turned into the `openwork` provider with an API URL that depends on `OPENWORK_DEV_MODE`.

The gateway reads sources 1 and 2 through the same module for pricing and provider routing, so a custom provider works through the AI Gateway as soon as it is in the catalog.

Local development still serves the generated catalog from the gateway Hono app at `/models/api.json` so one local service can provide both the proxy API and model catalog during dev.

## Caching

Clients get the Pages default `Cache-Control: public, max-age=0, must-revalidate` and always revalidate. Only Cloudflare's edge keeps a copy:

- `models/_headers` sets `Cloudflare-CDN-Cache-Control` on `/api.json`. The edge keeps the catalog for 5 minutes and serves the old copy while it refreshes or if Pages errors. Cloudflare does not forward this header to clients.
- A Cache Rule on the zone, set in the Cloudflare dashboard, makes the catalog cacheable: hostname `models.openworklabs.com`, path `/api.json` or `/models/api.json`, empty query string; Eligible for cache; Edge TTL "Use cache-control header if present, bypass cache if not"; Browser TTL "Respect origin".
- `.github/workflows/purge-model-catalog.yml` runs when the catalog sources change on `dev`. It rebuilds the catalog, waits until Pages serves those exact bytes, then purges both URLs. It needs the `MODELS_CLOUDFLARE_PURGE_TOKEN` secret (Cache Purge on this zone only) and the `MODELS_CLOUDFLARE_ZONE_ID` variable. Without them, or if the purge fails, it warns and the 5-minute TTL bounds staleness.
