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
| `applied` | done. Keeps the before-snapshot and one apply run (with its report) per attempt |
| `failed` | apply error. The run's report says which item failed, where, and what was already written |
| `stale` | the target changed after planning. Re-analyzed automatically and needs approval again |
| `superseded` | a newer request from the same API token and same scope replaced it (D5) |
| `cancelled` | withdrawn by its creator or an admin |

**Concurrency:**

- Any number of requests can be in `needs_review` at once.
- Only **one apply at a time per org**, using the existing table-as-queue pattern (`SELECT … FOR UPDATE SKIP LOCKED` + lease, as in `slack-assistant/repository.ts`).
- When one request is applied, every other open request whose plan touches the same items goes to `stale` and is re-analyzed. This is PlanetScale's "validated against queued changes".
- Optional org setting **require a second approver** (D5, off by default): the approver must differ from the creator and from the first approver.
- Optional **auto-apply** per request (default off): apply as soon as it's approved, otherwise wait for "Apply". This is PlanetScale's gated deploy, inverted.

## Preflight (plan time)

Some writes are known to fail, or to be pointless, before anything is applied. After building the plan, the service asks each area's optional `preflight(ctx, op, { secrets })` about every planned create, update and delete (reads only; the op is a preview with `$ref`s and `$secret`s unresolved, the secret *decisions* are passed alongside), then builds the plan again with the verdicts (`BuildPlanInput.preflight`, keyed `area + ref`; `buildPlan` stays pure):

- `skip`: the item is planned as `skip` with the area's reason and never executed. References to it resolve as for an admin's skip (unresolved: drop them or choose another item). An invite other items rely on is blocked instead.
- `block`: the item gets the `blocked` flag (blocking approval) and the reason. The admin fixes the target and re-plans (any decision or input change re-plans), or skips the item.
- `warnings`: added to the item's reasons as `warning: …`.

Verdicts change ops and flags, so they are part of the plan hash; a preflight that throws only adds a warning (the apply does the real check). The apply never re-runs preflight: it runs the stored execution plan, where skipped items are absent.

| Area | Skips | Blocks | Warns |
|---|---|---|---|
| `members.people` | a SCIM-provisioned person when the target has SCIM | an email outside the target's allowed domains | an owner is invited as an admin |
| `plugins.skills` | a source-managed object (its source's sync creates it); the Workbot "Your agent" template (owned by `workbot.proactive`) | a content or archive change to a source-managed object | |
| `plugins.sources` | | a new source without an active GitHub installation with the same id here (`needs_setup`) | |
| `settings.auth-security` | | turning on Require SSO / Restrict domain without an enabled, verified connection, or under `ssoPerOrganization` (only an SSO-signed-in admin may); an OIDC connection whose secret is left unset; a SAML connection without a certificate | Restrict domain where `ssoPerOrganization` is off |
| `ai-gateway.byok`, `ai-gateway.providers` | | a custom provider moving to another host while keeping its saved key ("enter the API key again") | |

## Apply

1. Take the org lock. Load the **stored execution plan** that goes with the approved plan (`config_change_request.execution`, written with every plan). No area is exported.
2. **Re-check drift on the written items only**: re-read each item an update or delete writes (`area.readItems(ids)`, else the area's export filtered: one helper, `readItemsFor`) and compare its `itemRev` with the plan's `targetRev`; check the targets of resolved references (other than people) still exist; for creates and renames on areas with unique fields, check nothing now holds the same value (the only check that reads a whole area). Any mismatch → `stale`, with the reasons in `errors`. A change elsewhere in the org is not drift.
3. **Write the before-snapshot**: the items about to be written, as just read (a blob whose scope is the areas written). Creates are not in it: they did not exist, and the restore deletes them using the run's report.
4. **Write the run** (`config_apply_run`, status `running`, every item `not_reached`).
5. Run the operations in dependency order, through each area adapter's `apply`. Adapters call the **existing domain services** (the same code the routes use), so validation, permission checks, audit change capture and side effects are not duplicated. An update carries the plan's field `changes` and the `secretPaths` (spec paths, as in `changes`: `credentialSets[id=Shared].credential`, never the `$secret` handle) whose decision writes a credential; adapters write only those. An update with neither is not sent (`noop`). The run's report is saved when each item starts and when it ends, so a crash leaves an accurate partial report.
6. **No transaction (decision).** Each item commits through its domain service (most open their own organization-locked transaction and some call out to the network), so a request-wide transaction would hold locks across network calls and rewrite rows that didn't change. Instead the database is only touched for what changes, and the safety net is the report (what was written, where it stopped, what was not reached) plus the before-snapshot (what to put back). The run stops at the first failing item; earlier items stay written.
7. Write alias rows for creates that couldn't reuse their source ID, and for confirmed tier-6 matches.
8. Secret inputs are written through the adapters' normal secret write path, then **deleted from the request** (Terraform's mistake: secrets left in state).
9. Finalize the run (`applied` / `failed`, `afterRevs` of the items written, re-read by id). Audit: one `tenant_job` operation per attempt, with per-item changes captured by the existing domain emitters, linked to the request id.

**Reads per apply:** before this design an apply exported every area of the scope (plus referenced and dependent areas) twice (the drift re-plan, the before-snapshot) and once more for `afterRevs`. Now: one id-limited read per written area, one per referenced area, one id-limited read of the written items for `afterRevs`, and a full read only of an area with unique fields that gets a create or a rename.

**Apply runs and the report:** one `config_apply_run` row per attempt. Its report (`ConfigApplyReport`) names who requested the apply and who it ran as, counts, the first failure, and per item: name, op, status (`applied` / `noop` / `failed` / `not_reached`), the writes done (`steps`, from the adapter), for a failed item its `failure` (code, message, field, the write that failed) and the steps it had already done, `irreversible` effects, start and duration. A run whose worker died is marked `interrupted` by the next claim; the item in flight becomes `failed` with code `interrupted`.

**The apply model in one paragraph:** no single transaction; each item is written through its domain service with the fewest writes the plan's changes need (untouched children, grants and settings are not rewritten; an update with nothing to write is `noop`); one run report per attempt (`config_apply_run`), saved as each item starts and ends; a before-snapshot of **only the items written** (as they were just before), never overwritten by later attempts.

**What "Restore previous config" can't undo**, because it only writes configuration back: emails sent (invitations); sign-ins revoked or ended (MCP, OAuth apps, AI providers, session limits, Require SSO); credentials replaced or deleted (snapshots never hold secrets: a replaced key keeps its new value, a deleted item's keys must be entered again); members removed (a restore can only invite them again); source syncs queued and what they imported; history (skill versions, archived roles, audit events); new ids (a re-created item gets a new id, and what pointed at the old one does not follow). The plan of the original lists these per item before approval (`irreversible`), and the restore's plan repeats them as warnings.

**Restore previous config** (API: `revert`): creates a new change request from the before-snapshot, with base = the after-state, and the deletes of the items the apply created already ticked. It goes through the normal flow, so drift since apply shows up as conflicts. It restores **configuration only**: side effects can't be undone. Its plan lists, as warnings, what the original runs recorded as irreversible ("These can't be undone by restoring: …"), credentials of deleted items that must be entered again, and that credentials replaced by the apply keep their new value (snapshots never hold secrets). The same `irreversible` effects (from `ConfigArea.irreversible(op)`) show on each plan item before approval.

## API (draft)

All routes are under the `configBlobs` flag (`requireFeature`). Each is declared in `audit/routes/*.ts` (otherwise the coverage check fails).

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /v1/config-blobs/areas` | the area registry: keys, labels, specVersion, supported on this deployment, required permission | member |
| `GET /v1/config-blobs/schema/:formatVersion` | JSON Schema for editors and CI | public |
| `GET /v1/config-blobs/export?areas=ai-gateway.providers,members.teams` | download a blob (whole org when `areas` is left out). Areas the caller can't view are left out and listed in `omitted` | UI session or `config:export` |
| `POST /v1/config-blobs/change-requests` | body `{ blob, mode: "merge" \| "mirror", title?, autoApply? }` → `202 { id, status: "uploaded" }` | UI or `config:submit` |
| `GET /v1/config-blobs/change-requests?status=` | the queue | UI or `config:submit` |
| `GET /v1/config-blobs/change-requests/:id` | status, summary, `report` (latest run) and `runs` (every attempt, newest first) | same |
| `GET /v1/config-blobs/change-requests/:id/runs/:runId` | one apply run: `{ run: ConfigApplyReport }` | same |
| `GET /v1/config-blobs/change-requests/:id/plan` | the full plan (see [mapping.md](./mapping.md#example-plan-api-shape)) | same |
| `PUT /v1/config-blobs/change-requests/:id/decisions` | `{ matches: [{ area, blobId, targetId \| "create" }], refs: [...], deletes: [...], overrides: [...] }` → new `planHash` | same |
| `PUT /v1/config-blobs/change-requests/:id/inputs` | secret decisions and values (write-only; never returned) | UI, or a config token with machine secrets allowed |
| `POST /v1/config-blobs/change-requests/:id/approve` | body `{ planHash }`; refused if blocking flags remain or the hash is old | UI or `config:apply` |
| `POST /v1/config-blobs/change-requests/:id/apply` | enqueue (or approve and apply in one call) | UI or `config:apply` |
| `POST /v1/config-blobs/change-requests/:id/cancel` | cancel | creator or admin |
| `POST /v1/config-blobs/change-requests/:id/revert` | "Restore previous config" → new change request from the before-snapshot | UI or `config:apply` |

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
   - **Review** also marks items whose write can't be undone by a restore ("Can't be undone", with the effects listed).
   - **Approve & apply** (or **Approve** only, when gated). Live status while applying. Then **Apply runs**: one row per attempt (status, counts, who requested it, who it ran as, when, how long), opening per item what was written; a failed item gets a box saying what failed, where (area › item › field), what was already written for it, what was not reached, and the next steps (fix and upload again, or **Restore previous config**).
4. **History**: applied, failed, cancelled and reverted requests, each with its before-snapshot downloadable.

**In other screens:** a pending change request touching an item could show a small "pending config change" note on that item's page (later).

## Data model (draft)

| Table | Key columns |
|---|---|
| `config_change_request` (`ccr`) | `organization_id`, `status`, `title`, `mode`, `source_kind` (ui / api / revert), `created_by_member_id`, `api_key_id`, `blob` (encrypted mediumtext), `source_instance_id`, `source_org_id`, `base_hash`, `plan` (encrypted json), `plan_hash`, `decisions` (json), `secret_inputs` (encrypted json, cleared after use), `approved_by`, `approved_plan_hash`, `approved_at`, `apply_requested_by`, `auto_apply`, `execution` (encrypted: the execution plan of `plan`), `before_snapshot` (encrypted: the items written, as before), `lease_owner`, `lease_until`, `available_at`, `attempts`, `reverts_change_request_id`, timestamps |
| `config_apply_run` (`car`) | `organization_id`, `change_request_id`, `attempt` (unique per request), `status` (running / applied / failed / interrupted), `requested_by_member_id`, `requested_by_api_key_id`, `runs_as_member_id`, `report` (encrypted `ConfigApplyReport`), `failure_area`, `failure_ref`, `failure_code` (first failure, for listing), `started_at`, `finished_at` |
| `config_blob_alias` (`cba`) | `organization_id`, `area`, `source_instance_id`, `source_id`, `local_id`, `created_by_change_request_id`. Unique on (org, area, source_instance, source_id) |
| `config_blob_export` (`cbe`, optional) | the last N exports per org, keyed by `base_hash`, so the three-way diff has field-level base values |

Delete purge: these tables are added to `delete-organization.ts`.

## As built (den-api `src/config-blobs/service.ts`, `worker.ts`)

- **Worker:** `startConfigBlobWorker` (1 s tick, started in `server.ts`, stopped on shutdown) analyzes up to 10 requests, then applies up to 10. `claimNextApply` keeps one apply per org; a long apply extends its lease every minute. With `configBlobs` off for an org, its requests are put back and retried a minute later.
- **Invalid vs. blocked:** unknown or newer areas and duplicate ids/keys make a request `invalid`. An item whose spec fails validation is only `blocked` (skip it, or fix the file). Secret placeholders outside an area's `secretFields`, or a raw value in a secret field, also block the item.
- **Approvals:** `{ memberId, at, apiKeyId? }` against the current plan hash. "Require a second approver" (`GET/PATCH /v1/config-blobs/settings`, organization metadata `configBlobs.requireSecondApprover`) needs two different members, and the second one must be neither the creator nor the first approver. Re-plans that change the hash, and any secret *value* entered, drop approvals.
- **Who applies:** the last approver (for a config-token approval, its issuing member). At apply time the worker checks that this member is still in the org and holds every written area's manage permission, and that the token is still enabled.
- **Step-up (as built):** approving and applying from the dashboard need a recent sign-in (the organization's "Enforce fresh admin sessions" window, `reauth` / `fresh_auth_required` otherwise), whatever the areas; agents (the MCP re-entry session) can't approve. Config tokens approve without one (D3). The apply then runs under a session counted as fresh, so it only runs while the last approval is under **24 hours** old; older, the request goes back to `needs_review` with its approvals dropped ("Approval expired").
- **Who queued it:** `apply_requested_by` records who queued the apply (explicit apply, or the approval that auto-applied). The apply's audit operation has that member as its initiating actor and the last approver as its actor; both start/completed events carry `requestedBy` and `runsAs` ids.
- **Interrupted applies:** a worker that loses its lease stops before its next write (the claim is extended before every operation): that item fails with code `interrupted`. A request whose lease expired while `applying` is never applied again: the next claim marks it `failed` and its `running` run `interrupted` (the item in flight failed with code `interrupted`), keeping its before-snapshot.
- **IDs (D4, as built):** a blob from this same instance (a clone into another organization, a re-import after a delete) or with no `source` never reuses ids: creates get new ids and aliases. A blob from another instance reuses an id only when no row of the area's tables holds it on the instance and it never appeared in this organization's audit history (`audit_event_resource`, one lookup on its organization index), and only when it has the area's TypeID prefix.
- **Aliases (as built):** an alias match shows "matched via an earlier import (ccr_…)" in the plan. Deleting an item through an apply deletes the aliases pointing at it. A confirmed match ("decision") becomes an alias only for a blob from another instance or one this instance recorded as an export (`config_blob_export`, by source organization and `baseHash`).
- **Stored errors:** `errors` are not encrypted, so each is one line, at most 500 characters, and replaced by `[withheld]` when it looks like a credential (the audit log's `auditText`). Run reports are encrypted and get the same redaction on failure messages, step details and warnings.
- **Revert size:** the 5 MB limit applies to uploads only; a revert of a large organization's before-snapshot is accepted.
- **Stale:** right before applying, the worker re-reads the items it writes (see Apply, step 2). A written item whose rev, name or key changed, a referenced item gone, a unique value now taken, or an area no longer supported → `stale` → re-analyzed → `needs_review` with approvals dropped. A request without a stored execution plan falls back to a full re-plan whose hash must match.
- **Planning reads:** analysis exports the areas in scope and the areas a `$ref` points at, nothing else (`dependsOn` only orders writes).
- **Transactions:** none across items (see Apply, step 6). It stops at the first failing item (the rest are `not_reached` in the run's report).
- **Preflight:** see Preflight above. Covered by `test/api/config-blobs-preflight.api.test.ts` and the engine tests.
- **Whole-organization round trip:** `test/api/config-blobs-whole-org.api.test.ts` sets up an organization with something in every one of the 25 areas through the public API, exports it, imports it into an empty organization (secrets entered, the GitHub source blocked by preflight and skipped, approval from a fresh sign-in), compares both exports area by area (ids and references by name), re-imports the source's file (nothing to do: aliases and natural keys) and the clone's own export (all unchanged; a no-op apply makes ~40 statements and writes no item), and rotates one credential-set key through an import. Intentional differences: people are `invited` on the clone (an import never makes anyone join), and the GitHub source is missing (its installation belongs to the source).
- **Audit:** one `tenant_job` operation per apply (`jobRunId` = change request id): `config_change_request.apply_started`, every domain change event the adapters' services emit (via `runWithAuditJobChangeCapture`, e.g. `invitation.created`), and `config_change_request.apply_completed` with counts. Services that only record request evidence leave no per-item event.
- **Restore previous config (revert):** a new request (source `revert`, title "Restore previous config: …") from the before-snapshot, `mirror` mode over the areas written, with the deletes of the items any attempt created already ticked. Other items of those areas show as untouched (not ticked). Each item's `rev` is set to its state right after the apply (the runs' `afterRevs`), so untouched items revert cleanly and items changed since show as drift. Old secret values were never stored: placeholders become `keep` (or `unset` when the source had none); an item the apply deleted needs its secrets entered again, and the plan says so.
- **`env` secrets:** only on self-hosted, for names in `DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST` (comma-separated, trailing `*` = prefix; a bare `*` is refused). Read at apply time; a missing variable fails the apply before anything is written.
- **Dry run:** `POST /v1/config-blobs/change-requests?dryRun=true` (scope `config:submit`) runs the same checks (size, envelope, import permissions → 413 / 400 / 403) and the same planning synchronously, and returns `200 { dryRun: true, plan, errors }`. **Nothing is stored**: no request row, no supersede, no export copy (simpler and safer than a cancelled row with a 24 h expiry). `errors` are what would make the request `invalid`; `plan.summary.blocking` counts items needing a decision.
- **JSON Schema:** `GET /v1/config-blobs/schema/1` is public (`publicRoute`, not behind `configBlobs`), generated from `configBlobSchema`, the item schema and every adapter's `specSchema` (`z.toJSONSchema`, input side; `src/config-blobs/json-schema.ts`). Exports set `$schema` to `${DEN_API_PUBLIC_URL}/v1/config-blobs/schema/1` (left out when the server has no public API URL).
- **Secret input expiry:** the worker, at most once a minute, clears `secret_inputs` of up to 50 open requests (`needs_review`, `approved`, `stale`, `queued`) uploaded more than 7 days ago and marks them `stale` with approvals dropped, so they ask for their secrets again. `status IN (…)` uses the queue index; only open requests are scanned. Requests clear their inputs when they become `applied`, `failed`, `cancelled`, `superseded` or `invalid`.
