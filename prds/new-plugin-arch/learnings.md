# Learnings

Read this file before starting any implementation step.

After completing a step, prepend any new learnings to the top of this file.

## What counts as a learning

- architecture constraints discovered in the current codebase
- route or schema patterns that should be reused
- persistence limitations or migration gotchas
- RBAC edge cases or clarified decisions
- webhook or raw-body handling pitfalls
- test harness quirks
- anything that would save the next agent time or prevent a bad implementation choice

## Prepend format

Use this shape for new entries:

```md
## YYYY-MM-DD Step N - Short title
- learning 1
- learning 2
- follow-up or caution
```

## Current entries

## 2026-04-17 Post-step cleanup - Type tightening and naming
- The route directory is now `ee/apps/den-api/src/routes/org/plugin-system/`; `plugin-arch` was only the planning nickname and was too confusing as a long-lived API module name.
- The plugin-system route wrapper can stay type-safe enough without `@ts-nocheck` by isolating Hono middleware registration behind a tiny `withPluginArchOrgContext()` helper and using explicit request-part adapters for `param`, `query`, and `json` reads.
- The Drizzle layer is happiest when plugin-system store/access helpers use concrete typed-id aliases (`ConfigObjectId`, `PluginId`, `ConnectorInstanceId`, etc.) plus discriminated resource-target unions; broad `string` or mixed-id unions quickly break `eq()` and `inArray()` inference.
- Connector GitHub App config should stay separate from normal GitHub OAuth login config, so den-api now reserves its own optional connector env namespace (`GITHUB_CONNECTOR_APP_*`) instead of reusing the existing auth credentials.

## 2026-04-17 Step 9 - Test harness and verification
- den-api package tests currently work best from `ee/apps/den-api/test/` rather than `ee/apps/den-api/src/`, because the package `tsconfig.json` compiles `src/**` during `pnpm --filter @openwork-ee/den-api build` and would otherwise drag Bun-only test imports into the production build.
- Bun is available in this workspace and is the easiest way to add focused TS tests for den-api without adding a new package runner; the current test slice uses `bun test ee/apps/den-api/test/...`.
- Webhook route tests can avoid database setup by targeting the early-exit paths: invalid signatures reject before JSON parsing/side effects, and valid signed payloads without an installation id return a clean ignored response before any connector lookup.
- Access-helper tests can import plugin-system modules safely if they seed the minimal env vars first, because `db.ts` pulls `env.ts` during module load even when the specific test only exercises pure helper functions.

## 2026-04-17 Step 5-8,10 - RBAC, routes, webhook ingress, and doc reconciliation
- The admin endpoint slice now lives in `ee/apps/den-api/src/routes/org/plugin-system/routes.ts`, with shared access checks in `ee/apps/den-api/src/routes/org/plugin-system/access.ts` and persistence/serialization helpers in `ee/apps/den-api/src/routes/org/plugin-system/store.ts`.
- `resolveOrganizationContextMiddleware` depends on validated `:orgId` params, so plugin-system routes must run `paramValidator(...)` before org-context resolution; the custom route helper was adjusted to inject auth/org middleware after per-route validators.
- The current endpoint layer has no separate org-capability table, so create/manage-account capabilities are implemented as org owner/admin checks only; resource-level edit/view behavior still uses direct, team, org-wide, and plugin-inherited access resolution.
- Config-object inherited access from plugins is view-only in the helper layer; edit/manage actions still require direct object grants or org-admin override, which keeps plugin delivery access from accidentally becoming object edit access.
- GitHub webhook ingress is registered at `ee/apps/den-api/src/routes/webhooks/github.ts`, verifies `X-Hub-Signature-256` against the raw body before JSON parsing, queues `push` sync events into `connector_sync_event`, and treats installation lifecycle updates as connector-account health changes rather than content sync jobs.
- Because dependencies are still missing in this worktree, verification remains limited to parse-oriented `tsc --noResolve` calls, `git diff --check`, and JSON validation; real den-api execution and automated route tests are still blocked until the workspace is installed.

## 2026-04-17 Step 4 - Den DB persistence backbone
- The persistence backbone now lives in `ee/packages/den-db/src/schema/sharables/plugin-arch.ts`; den-api can query these tables directly through the existing shared `@openwork-ee/den-db/schema` export instead of adding a new repository layer.
- Encrypted config-object payload storage is implemented as encrypted `text` columns, not native MySQL `json`, because the existing `encryptedColumn()` helper serializes ciphertext blobs; anything that needs indexed/searchable current metadata still has to stay projected onto plaintext columns on `config_object`.
- To keep MySQL uniqueness simple in v1, plugin memberships and access grants currently use one row per logical relationship plus `removed_at`, not append-only historical rows; re-activating a removed membership/grant should update the existing row instead of inserting a duplicate.
- The migration for this step was written manually as `ee/packages/den-db/drizzle/0010_plugin_arch.sql` and journaled in `drizzle/meta/_journal.json` because Drizzle generation is still blocked by missing local package dependencies in this worktree.
- `connector_source_binding` is unique on `config_object_id` only; deleted-path history is preserved in `connector_source_tombstone`, so recreated paths should mint a new object identity rather than trying to reactivate the old binding row.

## 2026-04-17 Step 1-3 - Placement, contracts, and shared schemas
- The org-scoped plugin-architecture admin APIs belong in `ee/apps/den-api/src/routes/org`, not `apps/server` or `apps/server-v2`: the existing authenticated `/v1/orgs/:orgId/...` surface, Better Auth session flow, org context middleware, and Hono OpenAPI route style already live there.
- The persistence home for plugin-architecture resources is `ee/packages/den-db/src/schema`; `apps/server-v2` is workspace-first SQLite state for local/runtime control and is the wrong place for durable org resources like config objects, plugins, connector accounts, and grants.
- den-api route validation is built around `hono-openapi` validators plus `requireUserMiddleware`, `resolveOrganizationContextMiddleware`, and `resolveMemberTeamsMiddleware`, so new route code should reuse those patterns instead of inventing a separate request parsing layer.
- den-api does not currently have a webhook helper or raw-body middleware; the GitHub ingress should read `c.req.raw` directly, verify `X-Hub-Signature-256` before JSON parsing, and only then normalize the payload.
- Adding the shared schemas early forced new TypeID families for config objects, versions, grants, plugins, and connector resources; later DB tables and route params should reuse those ids instead of falling back to plain strings.
- Local verification is currently dependency-blocked in this worktree: `pnpm --filter @openwork-ee/den-api build` and direct `tsc` both stop immediately because package-local dependencies like `tsup`, `zod`, and other workspace modules are not installed in this checkout.
