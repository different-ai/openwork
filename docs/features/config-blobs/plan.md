# Build plan

Every user-visible piece went behind `configBlobs` (cloud + self-hosted, off by default; `.opencode/skills/add-a-feature`). Each phase could ship alone. The flag is now retired: config import and export is generally available.

## Status (2026-11-09)

| Phase | State |
|---|---|
| 0 · groundwork | **Done.** `configBlobs` flag, docs, shared types (`packages/types/src/den/config-blobs.ts`), area contract (`area.ts`) and registry, coverage check (`pnpm --filter @openwork-ee/den-api config-blobs:coverage`: 146 org-scoped tables, 58 owned, 95 excluded with a reason). |
| 1 · export | **Done.** `GET /areas`, `GET /export` (`$schema` → this server's public schema URL); Settings › Config export tree. |
| 2 · change requests + plan | **Done.** `config_change_request` table and worker; matching tiers, references, three-way diff, plan hash; decisions and inputs endpoints; Changes tab and change request page; **plan-time preflight** (area `preflight`, verdicts fed into `buildPlan`; change-requests.md › Preflight). |
| 3 · apply | **Done.** Approvals (optional second approver, fresh sign-in, 24 h expiry), per-org apply queue, stale detection on the written items only, before-snapshot of the written items, minimal per-item writes, per-attempt run reports (`config_apply_run`), aliases, secret write-through and purge, `tenant_job` audit, "Restore previous config", `mirror` deletes. Not one database transaction (change-requests.md › Apply). |
| 4 · config token + API docs | **Done.** `config` API keys with `config:export` / `config:submit` / `config:apply` and area limits; `env` secrets on self-hosted; `?dryRun=true`; public JSON Schema; secret inputs expire after 7 days; `packages/docs/self-host/export-import-configuration.mdx`. |
| 5 · coverage | **Done: all 26 areas** (inventory.md › Areas). Whole-organization round trip: `test/api/config-blobs-whole-org.api.test.ts`. |
| 6 · cross-deployment polish | **Partly.** Done: `unsupportedReason` per area (cloud-only areas skip on self-hosted), `specVersion` check and upgrader hook, D4 id reuse across instances, comparing instance-specific child ids by name (`comparableSpec`). |

**Remaining:**

- The cloud → self-hosted journey spec in `evals/` (two instances; the whole-org test covers two organizations on one instance, where ids are never reused).
- A UI affordance to re-run preflight after fixing the target (today any decision or input change re-plans).
- "Pending config change" hints on resource pages; `external_key` on more root tables for hand-written blobs.
- Per-area upgraders once a `specVersion` moves past 1.
- Blob size: brand images can approach the 5 MB limit (exported without data past a budget); a zip format would lift it.

Bugs the whole-organization round trip found and fixed: re-importing a file into an organization cloned from it showed every AI provider as changed and needing secrets (model groups, credential sets and grants were compared by instance-specific child ids: now by name, `comparableSpec`); a new value for a nested credential (a credential set's key, an MCP header) was planned but never written, because updates named secrets by their `$secret` handle instead of their spec path (`secretPaths`); the Workbot "Your agent" template, once shared, was exported by both `plugins.skills` and `workbot.proactive`.

## Architecture: area adapters

One registry in den-api: `ee/apps/den-api/src/config-blobs/registry.ts`, adapters in `areas/*.ts`, the contract in `area.ts` (the sketch below is the original proposal; `area.ts` is authoritative). Each area implements:

```ts
type ConfigArea<Spec> = {
  key: "ai-gateway.providers";
  label: string;                       // matches the sidebar / tab label
  specVersion: number;
  specSchema: ZodType<Spec>;           // strict
  dependsOn: AreaKey[];                // for ordering and $ref resolution
  deployments: ("cloud" | "self_hosted")[];
  feature?: FeatureKey;                // e.g. workbotProactive
  viewPermission: PermissionKey;       // export
  managePermission: PermissionKey;     // apply
  naturalKeys: NaturalKey<Spec>[];     // tier 5, uniqueness checked on both sides
  similarity?: (a: Spec, b: Spec) => Score; // tier 6
  secrets: SecretField[];              // placeholder paths
  children?: ChildCollection[];        // nested rows matched inside a parent (models, entries…)
  exportItems(ctx): Promise<Item<Spec>[]>;           // allowlist serializer
  readItems?(ctx, ids): Promise<Item<Spec>[]>;       // apply reads only the items it writes
  preflight?(ctx, op, { secrets, refs }): Promise<{ skip?; block?; warnings? } | null>; // plan time, reads only
  derivedFields?: string[];                          // never planned as a change, still hashed
  requiredRefs?: string[];                           // a dropped one takes its array entry along; outside an array it can't be dropped
  irreversible?(op): string[];                       // what a restore can't undo, shown before approval
  comparableSpec?(spec): Spec;                       // compare instance-specific child ids by name
  apply(ctx, op: Create | Update | Delete): Promise<ApplyResult>; // calls existing domain services; writes only the plan's changes
  upgrade?: Record<number, (old: unknown) => unknown>;
};
```

**Shared engine:**

- canonical JSON and hashing
- validation
- matching tiers
- reference resolution
- three-way diff
- plan and plan hash
- queue worker
- before-snapshot
- alias writes

The engine is generic. Adapters contain no matching or diff logic.

**Guard rail (CI):** `scripts/check-config-blob-coverage.ts`, the same idea as `check-audit-route-coverage.ts`. Every org-scoped table in `den-db` must be either owned by an area or listed in `config-blobs/excluded.ts` with a reason (`runtime`, `secret`, `personal`, `billing`, `platform`). `delete-organization.ts` is the source list of org-scoped tables. When a new table appears, the author has to decide.

**Round-trip property test:** for each adapter, `export → import into an empty org → export` gives identical specs (and IDs across instances). `export → import into the same org` gives an all-`unchanged` plan. As built: per-area tests in `test/api/config-blobs-areas-*.api.test.ts`, and the whole organization in `test/api/config-blobs-whole-org.api.test.ts`.

## Phase 0: groundwork (small)

- Declare the `configBlobs` flag and add `docs/features/config-blobs/README.md` in the repo (from these docs).
- Envelope + canonical hash library + JSON Schema generation (`packages/types/src/den/config-blobs.ts`, Zod).
- Area registry with the coverage check (every table listed; most marked "not yet").
- Decisions are recorded at the end of this file.

## Phase 1: export (read-only, low risk)

- Adapters: `members.teams`, `members.roles`, `members.people`, `desktop-policies`, `connectors.mcp`, `connectors.oauth-clients`, `ai-gateway.providers`, `ai-gateway.byok`, `settings.general`, `settings.web-origins`, `settings.advanced.collections` (metadata).
- Secret placeholders; references (teams, people by email).
- `GET /v1/config-blobs/areas`, `GET /v1/config-blobs/export`.
- UI: Settings › Config › Export tree + download.
- **Exit:** a whole-org export of a seeded demo org (`worlds/lib/demo-workspace.ts`) is readable. It contains no secret (checked with the same patterns as `audit/domain/snapshot.ts`, `enc:v1:`, `sk-…`, `ghp_…`), and its hash stays the same across exports.

## Phase 2: change requests + plan (no writes yet)

- `config_change_request` table, upload endpoint returning `{ id }`, analysis worker.
- Matching tiers 1, 4, 5, 6; references; two-way diff; `merge` mode only.
- Decisions and inputs endpoints; plan hash.
- UI: Changes tab (queue) and the change request page: Match, References, Secrets, Review. Apply is disabled ("coming soon").
- **Exit:** uploading an edited export shows exactly the edits. Uploading into another org shows sensible proposals. Same-name plugins or providers are never auto-matched.

## Phase 3: apply

- Approve with plan hash, per-org lock and queue, stale detection, before-snapshot, transactional apply through adapters, alias rows, secret write-through and purge, `tenant_job` audit, revert.
- Three-way diff with `rev` (base from `config_blob_export` when the source is the same org).
- `mirror` mode with per-item delete confirmation.
- **Exit:** the cloud → self-hosted journey (spec in `evals/`) works. Export a cloud demo org, import it into a fresh self-hosted Den (`pnpm world up …`), supply secrets, apply, export again: same IDs, same specs. Then edit one field, re-import, and see a one-item plan.

## Phase 4: config token + API docs

- API key type with `config:*` scopes, area-limited scopes, `allowApiKeys` on inputs for config tokens, `env:` secrets on self-hosted with an operator allowlist (Helm value).
- `?dryRun=true`, public JSON Schema, docs page in `packages/docs/self-host/` (follows on from `declarative-configuration.mdx`; the `by-key` routes stay supported).
- **Exit:** a GitHub Actions example that exports on a schedule, checks PRs against the public schema (no token in any PR-triggered job) and submits on merge from a protected environment.

## Phase 5: coverage

In rough order of value:

1. `members.agent-permissions`
2. `members.default-models`
3. `ai-gateway.limits`
4. `ai-gateway.smart-routers`
5. `plugins.plugins` + `plugins.skills` (consider agent-plugin v1 as the inner spec; content included per D1)
6. `members.prompts` (content included per D1)
7. `workbot.*`
8. `settings.auth-security`
9. `settings.advanced.brand` (assets → zip)
10. `settings.audit`
11. `plugins.sources`

Each one is its own small PR: adapter + round-trip test + coverage list update.

## Phase 6: cross-deployment polish

- Cloud-only areas (`openwork-models`) show as `skip` with a reason on self-hosted.
- Version skew handling: per-area upgraders and "newer than this server" warnings.
- Optional `external_key` on more root tables, so hand-written blobs can use keys.
- "Pending config change" hints on resource pages.

## Risks

| Risk | Mitigation |
|---|---|
| An adapter bypasses domain rules by writing tables directly | adapters must call domain services; review checklist; round-trip tests |
| Secrets leak through JSON columns | allowlist serializers only; a secret-pattern scan in tests over every exported fixture |
| A big apply partially fails with external effects | preflight blocks known failures before approval; per-item writes through the services, stop at the first failure, a per-attempt report of what was written and not reached; before-snapshot for "Restore previous config" (configuration only) |
| Import sends surprise invite emails or locks people out | silent invitations by default for cross-instance imports; never remove or demote the last owner or the applier; mirror-mode removals confirmed one by one |
| Permission escalation through import (e.g. a role granting permissions the uploader doesn't have) | adapters check `managePermission` *and* the existing "can't grant more than you have" rules of the role and permission services |
| Reusing IDs collides across orgs on one instance | check that the ID is free on the whole instance before reusing it; otherwise create a new one + alias |
| The sidebar changes and keys go out of date | keys live in the registry, not in routes |
| Blob size (skills, brand assets) | 5 MB JSON limit at first; zip later |

## Decisions (2026-11-09)

| # | Decision |
|---|---|
| D1 | **Encrypted content is exported** (skills, plugin payloads, prompts, automation instructions), with a "confidential content" warning on export. Only credentials and tokens are never exported. |
| D2 | **Blobs carry people**: members, roles, team membership and pending invitations, matched by email. Missing people become invitations (send now, or create silently). See `inventory.md` › People. |
| D3 | **A config token can apply.** `config:apply` approves and applies with no extra org switch. The issuing member's permissions still limit what it can change. |
| D4 | **Imports reuse the source TypeID** when it's free on the whole instance; otherwise a new ID plus an alias row. |
| D5 | **The other proposals stand:** org name, slug and SSO domains are never applied (only exported as `source` info); optional org setting "require a second approver", off by default; many open requests allowed, others marked stale when one applies, superseded only for the same token + scope; the page is **Settings › Config**. |
