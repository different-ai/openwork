# OpenWork Model Catalog

This directory holds the generated OpenWork model catalog. Cloudflare Pages builds it from `dev` through its Git integration and publishes the `models/` folder at `https://models.openworklabs.com`:

- Build command: `pnpm --dir ee/apps/gateway models:build`
- Build output directory: `ee/apps/gateway/models-site/models`
- Catalog URLs, in the same shapes as models.dev:
  - `https://models.openworklabs.com/api.json`: the v1 shape. Den, the gateway and the v1 engine read it.
  - `https://models.openworklabs.com/experimental/v2.0/api.json`: models.dev's experimental v2 shape. OpenCode v2 engines read this path first and only fall back to `/api.json` after a 404, converting it with less detail.

The generated files under `models/` are ignored by git. `scripts/build-models.mjs` rebuilds both from three sources in this order:

1. The models.dev snapshots, refreshed together by the Update Models workflow: `src/models/base.json` (v1) and `src/models/base-v2.json` (v2, every model type). The v2 snapshot is published unchanged.
2. `src/models/providers/*.json`: custom providers that are not on models.dev, one validated file each. See `src/models/providers/README.md`. A file that fails validation fails the build.
3. `src/models/openwork-models.json`: OpenWork-specific models, turned into the `openwork` provider with an API URL that depends on `OPENWORK_DEV_MODE`.

Sources 2 and 3 are written once, in the v1 shape. `src/models/catalog.ts` publishes them as they are; `src/models/catalog-v2.ts` converts them to v2 (the conversion OpenCode applies to a v1 catalog, plus the fields v2 requires) and checks the result, so an engine sees the same OpenWork models through either URL.

The gateway reads sources 1 (v1) and 2 through the same module for pricing and provider routing, so a custom provider works through the AI Gateway as soon as it is in the catalog.

The static files ignore `?type=`: the v2 file has every model type, as models.dev serves by default, and OpenCode keeps the types it uses.

Local development still serves the generated catalogs from the gateway Hono app at `/models/api.json` and `/models/experimental/v2.0/api.json` so one local service can provide both the proxy API and model catalog during dev.

## Caching

Clients get the Pages default `Cache-Control: public, max-age=0, must-revalidate` and always revalidate. Only Cloudflare's edge keeps a copy:

- `models/_headers` sets `Cloudflare-CDN-Cache-Control` on `/api.json` and `/experimental/v2.0/api.json`. The edge keeps the catalog for 5 minutes and serves the old copy while it refreshes or if Pages errors. Cloudflare does not forward this header to clients.
- A Cache Rule on the zone, set in the Cloudflare dashboard, makes the catalog cacheable: hostname `models.openworklabs.com`, path `/api.json` or `/models/api.json` with an empty query string, or path `/experimental/v2.0/api.json` with any query string (OpenCode always asks for `?type=chat,decision,image`; the cache key keeps the query, so the purge workflow's `?deployment=` checks still reach Pages); Eligible for cache; Edge TTL "Use cache-control header if present, bypass cache if not"; Browser TTL "Respect origin".
- `.github/workflows/purge-model-catalog.yml` runs when the catalog sources change on `dev`. It rebuilds both catalogs, waits until Pages serves those exact bytes, then purges the v1 URLs and the v2 URL with and without OpenCode's `?type=` query. It needs the `MODELS_CLOUDFLARE_PURGE_TOKEN` secret (Cache Purge on this zone only) and the `MODELS_CLOUDFLARE_ZONE_ID` variable. Without them, or if the purge fails, it warns and the 5-minute TTL bounds staleness.
