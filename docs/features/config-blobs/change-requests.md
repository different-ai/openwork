# Change requests: queue, API, config token, UI

Every upload, from the UI or the API, becomes a **change request** (prefix `ccr`). Nothing is written to org config except by applying one.

## Lifecycle

```
uploaded ─► analyzing ─► needs_review ─► approved ─► queued ─► applying ─► applied
                │              │   ▲          │          │          │
                │              │   └── edits ─┘ (approval dropped)  └─► failed (nothing committed, or partial: see Apply)
                ▼              ▼                         │
             invalid       cancelled                  stale ─► (auto re-analyze) ─► needs_review
                                                                                     applied ─► reverted (via a new ccr)
```

| Status | Meaning |
|---|---|
| `uploaded` | stored; analysis queued. **The API returns here with the id** (`202`) |
| `analyzing` | the worker is building the plan |
| `invalid` | schema, version or permission failure. Errors are attached. Terminal |
| `needs_review` | plan ready. Shows counts and blocking flags (`needs_mapping`, `needs_input`, `ref_unresolved`, `drift`, `collision.unique`) |
| `approved` | no blocking flags; an admin approved this `planHash` |
| `queued` | waiting in the org's apply queue |
| `applying` | holding the org's apply lock |
| `applied` | done. Keeps the before-snapshot id and the apply report |
| `failed` | apply error. Report per item |
| `stale` | the target changed after planning. Re-analyzed automatically and needs approval again |
| `superseded` | a newer request from the same API token and same scope replaced it (D5) |
| `cancelled` | withdrawn by its creator or an admin |

**Concurrency:**

- Any number of requests can be in `needs_review` at once.
- Only **one apply at a time per org**, using the existing table-as-queue pattern (`SELECT … FOR UPDATE SKIP LOCKED` + lease, as in `slack-assistant/repository.ts`).
- When one request is applied, every other open request whose plan touches the same items goes to `stale` and is re-analyzed. This is PlanetScale's "validated against queued changes".
- Optional org setting **require a second approver** (D5, off by default): the approver must differ from the creator and from the first approver.
- Optional **auto-apply** per request (default off): apply as soon as it's approved, otherwise wait for "Apply". This is PlanetScale's gated deploy, inverted.

## Apply

1. Take the org lock, then check the target hashes again (→ `stale` if they changed).
2. **Write the before-snapshot**: export the plan's scope as a blob and store it with the request.
3. Run the operations in dependency order, through each area adapter's `apply`. Adapters call the **existing domain services** (the same code the routes use), so validation, permission checks, audit change capture and side effects are not duplicated.
4. **Transactions:** everything that's a database write runs in **one transaction per request**. Operations with external effects (MCP probe, OAuth discovery) run before the transaction as a check, or after commit as follow-up. Their failures become *warnings* on the report, not rollbacks (a probe failure shouldn't block saving config).
5. Write alias rows for creates that couldn't reuse their source ID, and for confirmed tier-6 matches.
6. Write secret inputs through the adapters' normal secret write path, then **delete them from the request** (Terraform's mistake: secrets left in state).
7. Audit: one `tenant_job` operation for the request, with per-item changes captured by the existing domain emitters, linked to the request id.

**Revert:** "Revert" on an applied request creates a new change request from its before-snapshot, with base = the after-state. It goes through the normal flow, so drift since apply shows up as conflicts. The UI offers it with no time limit, and notes when later requests touched the same items.

## Config token

The user calls it a "config-token": a dedicated machine credential for config blobs. Today's org API keys (`apikey`, Better Auth) have **no per-key scopes**. They act as the issuing member, and the `permissions` column is unused.

**Proposal:**

- A **new key type on the existing API key system**, using the `apikey.permissions` column for scopes, rather than a parallel token table. It's listed in Settings › API Keys with a "Config" type.
- Scopes:
  - `config:export`: download blobs
  - `config:submit`: upload, read status and plan, set mappings and inputs
  - `config:apply`: approve and apply (D3: available to any config token that's given it; no extra org switch). If the org requires a second approver, an API approval counts as one approver and a second one is still needed
- Scopes can also be limited to area keys, e.g. `config:submit[ai-gateway.*]`.
- The key still acts with the issuing member's permissions: a token can never do more than its member could in the UI. Each adapter checks the same permission as the matching UI route (e.g. `gateway_providers.manage`).
- Secret inputs from machines: `refuseMachineSecrets` blocks API keys from sending secrets by default. The inputs endpoint opts in **only for config tokens** (`allowApiKeys`) and is listed in the audit declarations. Self-hosted operators can prefer `env` references instead.

## API (draft)

All routes are under the `configBlobs` flag (`requireFeature`). Each is declared in `audit/routes/*.ts` (otherwise the coverage check fails).

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/config-blobs/areas` | the area registry: keys, labels, specVersion, supported on this deployment, required permission | member |
| `GET /v1/config-blobs/schema/:formatVersion` | JSON Schema for editors and CI | public |
| `GET /v1/config-blobs/export?areas=ai-gateway.providers,members.teams` | download a blob (whole org when `areas` is left out). Areas the caller can't view are left out and listed in `omitted` | UI session or `config:export` |
| `POST /v1/config-blobs/change-requests` | body `{ blob, mode: "merge" \| "mirror", title?, autoApply? }` → `202 { id, status: "uploaded" }` | UI or `config:submit` |
| `GET /v1/config-blobs/change-requests?status=` | the queue | UI or `config:submit` |
| `GET /v1/config-blobs/change-requests/:id` | status, summary, timings, report | same |
| `GET /v1/config-blobs/change-requests/:id/plan` | the full plan (see [mapping.md](./mapping.md#example-plan-api-shape)) | same |
| `PUT /v1/config-blobs/change-requests/:id/decisions` | `{ matches: [{ area, blobId, targetId \| "create" }], refs: [...], deletes: [...], overrides: [...] }` → new `planHash` | same |
| `PUT /v1/config-blobs/change-requests/:id/inputs` | secret decisions and values (write-only; never returned) | UI, or a config token with machine secrets allowed |
| `POST /v1/config-blobs/change-requests/:id/approve` | body `{ planHash }`; refused if blocking flags remain or the hash is old | UI or `config:apply` |
| `POST /v1/config-blobs/change-requests/:id/apply` | enqueue (or approve and apply in one call) | UI or `config:apply` |
| `POST /v1/config-blobs/change-requests/:id/cancel` | cancel | creator or admin |
| `POST /v1/config-blobs/change-requests/:id/revert` | → new change request from the before-snapshot | UI or `config:apply` |

**CI example:** export → commit to git → edit → `POST change-requests` → wait for `needs_review` → read the plan in the PR → an admin approves in the UI. `?dryRun=true` on submit analyzes without queueing, then discards the request after 24h, for a PR check (like safe-settings "nop").

## Secret inputs

- Stored encrypted on the request (`encryptedMediumTextColumn`), visible only as `set` or `not set`.
- Deleted after apply, cancel or expiry (e.g. 7 days).
- Never part of `planHash` as values, only as decisions (`keep` / `env:NAME` / `value` / `unset`). That way, entering a secret doesn't silently change what was approved. Proposal: entering a value counts as a decision change and drops approval. Simpler, and safe.

## UI (Den › Settings › Config, proposed)

Under **Team › Settings › Config** (key `settings.config`, not exported), behind `configBlobs`. Uses the existing Den shell and components (see `DESIGN.md`).

1. **Overview tab**
   - **Export**: a tree of area keys with checkboxes taken from `/areas` (the whole org, or e.g. `AI Gateway › AI Providers`), then Download. A note lists what's never exported (secrets, billing, runtime data) and warns when the selection contains confidential content (skills, prompts).
   - **Import**: drop a `.json`, choose Merge or Mirror, add a title (optional), Upload.
2. **Changes tab**: the queue. One row per request: title, source (UI / API token name / revert), source org and deployment, areas, counts (`+3 ~5 −0`), status chip, blocking flag count, author, age.
3. **Change request page**, in steps:
   - **Match**: only the items that need a decision. Drizzle-style choices, with candidates and scores.
   - **References**: unresolved teams and people, and so on. Map, drop, create from the blob, or invite (people).
   - **People**: invites to create, with the choice to send emails now or create them silently.
   - **Secrets**: a list of placeholders with *Keep current / Enter value / Environment variable (self-hosted) / Leave unset*.
   - **Review**: per area, items grouped by `create` / `update` / `rename` / `delete` / `untouched`. Field diffs; three-way view for conflicts; destructive items highlighted with confirmation boxes.
   - **Approve & apply** (or **Approve** only, when gated). Live status while applying. Then the report, a **Revert** button, and a link to the audit log operation.
4. **History**: applied, failed, cancelled and reverted requests, each with its before-snapshot downloadable.

**In other screens:** a pending change request touching an item could show a small "pending config change" note on that item's page (later).

## Data model (draft)

| Table | Key columns |
|---|---|
| `config_change_request` (`ccr`) | `organization_id`, `status`, `title`, `mode`, `source_kind` (ui / api / revert), `created_by_member_id`, `api_key_id`, `blob` (encrypted mediumtext), `source_instance_id`, `source_org_id`, `base_hash`, `plan` (encrypted json), `plan_hash`, `decisions` (json), `secret_inputs` (encrypted json, cleared after use), `approved_by`, `approved_plan_hash`, `approved_at`, `auto_apply`, `before_snapshot` (encrypted), `report` (json), `lease_owner`, `lease_until`, `available_at`, `attempts`, `reverts_change_request_id`, timestamps |
| `config_blob_alias` (`cba`) | `organization_id`, `area`, `source_instance_id`, `source_id`, `local_id`, `created_by_change_request_id`. Unique on (org, area, source_instance, source_id) |
| `config_blob_export` (`cbe`, optional) | the last N exports per org, keyed by `base_hash`, so the three-way diff has field-level base values |

Delete purge: these tables are added to `delete-organization.ts`.
