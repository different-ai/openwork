---
name: dry-run-a-risky-change
description: Billing, plans, seats, permissions, access rules, auth, flag removals or data migrations that could lock real organizations out or change what they pay. Use before merging or deploying such a change to see exactly which production organizations it affects, prove the UI on production-shaped data, and only with explicit approval test against a PlanetScale copy of real data.
---

# Dry-run a risky change

Tests prove the rule you wrote. They do not tell you which real organizations
the rule changes. Before a risky change ships, answer three questions in order
and stop at the first level that answers them:

1. **Who changes?** Every production organization whose outcome differs
   before vs after (blocked, unblocked, billed differently, loses access).
2. **Does it look right to them?** The real screens on organizations shaped
   like the affected ones.
3. **Does it behave right on real data?** Only when 1 and 2 cannot answer it.

Confidentiality (AGENTS.md, hard rule): production names, ids, emails and
counts stay in chat. Never put them in a branch, commit, fixture, screenshot,
PR or issue. Describe affected organizations generically ("one grandfathered
org with ~30 SSO users").

## Level 1: read-only production dry run (always)

Run the new rule against production inputs without writing anything.

1. Write the new rule's inputs as the smallest set of columns (plan metadata,
   member counts, subscription status, feature overrides). Express the rule
   either as SQL or by feeding query results into the PR's pure function.
2. Read them with the platform admin MCP `den_query` (read-only SQL against
   the Den database). Never use admin write tools (`den_update_org_plan`,
   `den_set_org_capability`, `den_set_feature_rollout`) during a dry run.
3. Compute **before** (current `dev` rule) and **after** (the PR) for every
   organization the rule can touch, and report only the ones that differ, plus
   anyone at or near a new limit.
4. Put the query (no results) in the PR as the pre-deploy check, and list the
   ops steps it implies (for example "give one org enough seats first").

`den_query` traps that produced wrong answers before:

- JSON values compare as **text**: `GREATEST(5, JSON_EXTRACT(m,'$.limits.members'))`
  says `'40' < '5'`. Always `CAST(JSON_UNQUOTE(JSON_EXTRACT(...)) AS UNSIGNED)`.
- It refuses credential tables (`invitation`, `session`, `account`, keys and
  tokens) and any statement containing a write keyword as a word, including
  inside string literals (`'%grant%'`, `'invitation.create.attempted'`). Use
  `LIKE 'invitation.%.attempted'`, or count placeholder `member` rows
  (`joined_at IS NULL`) instead of reading invitations.
- It stops at 14 seconds. Filter `audit_event` by `org_id` and a `created_at`
  range; never scan it whole.
- Feature state lives in `feature_rollout` and `organization_feature`, not
  `organization.metadata.capabilities` (a legacy copy).

## Level 2: production-shaped preview (UI changes)

Reproduce each affected shape with generic data and drive the real screens.

1. From Level 1, list the distinct shapes (for example: Enterprise trial with
   an end date, full admin-set plan, paid in Stripe, old grant over its limit,
   Free at its limit).
2. Seed them in an evals world (`evals/worlds/*.ts`, generic names such as
   "Acme") and prove the journeys in a proof (`write-a-spec`). Use the fake
   Stripe lab (`evals/worlds/fake-stripe.ts`) when billing must be configured,
   or limits that depend on Stripe being set up switch off.
3. Run headless: `pnpm evals:e2e <name> --local`, or boot a preview with
   `preview-my-work` (`preview-den` / `preview-full`, locally or on Daytona)
   and click through by hand. Attach screenshots to the PR (`upload-photo`).

## Level 3: PlanetScale copy of real data (exceptional, needs approval)

Use only when Levels 1 and 2 cannot answer the question (data-dependent
migrations, performance on real volume). Ask the person first and name the
cost and the data involved.

Use the **Dry run on a copy of production data** workflow
(`.github/workflows/prod-data-dry-run.yml`). It seeds an isolated
`dry-run-<run-id>-<attempt>` copy from the latest production backup (Data
Branching), runs one read-only check, and attempts deletion when the job ends,
including on failure or cancel. Verify absence after the run; cleanup can fail.
Both `--restore` and `--seed-data` can create a branch classified as production.
The token therefore needs read-only production connection and production-branch
deletion permissions. The real source must be deletion-protected, and the job
verifies that protection before creation, credentials and cleanup. The token
cannot change branch protection or write production data. The PlanetScale MCP
has no branch-creation tools.

1. Write the check in `ee/apps/den-api/scripts/dry-run/<name>.ts` on your
   branch, using `connect.ts` (`dryRunDb`, `report`, `fail`, `finish`). It may
   import the PR's own code (for example a pure rule) and must print
   **aggregates and pass/fail only**: this repository is public, so the job
   log and summary are public. Start from `smoke.ts`.
2. Push the branch, then run the workflow from GitHub Actions (or
   `gh workflow run prod-data-dry-run.yml --ref <branch> -f check=<name>.ts`).
   Database access is always read-only. This workflow cannot apply migrations.
3. A required reviewer approves the run on the `prod-data-dry-run`
   environment after reading the check. Approve only checks that print
   aggregates.
4. Read the summary. If a run is interrupted, run it again with
   `cleanup_only` to delete leftover `dry-run-*` branches.

What the workflow needs (set once, by a person, never pasted in chat): on the
`prod-data-dry-run` environment, a PlanetScale service token limited to the
Den database with `read_database`, `read_branch`, `create_branch`,
`delete_branch`, `connect_branch`, `read_backups`,
`restore_production_branch_backup`, `connect_production_read_only_branch` and
`delete_production_branch` (never `connect_production_branch` or `write_database`).
The real source must be deletion-protected first. These scopes also allow
read-only credentials on the live source and deleting other unprotected
production branches in this database; run-name guards limit the workflow,
not the underlying token. Store it only in the protected environment as `PLANETSCALE_DRY_RUN_TOKEN_ID` /
`PLANETSCALE_DRY_RUN_TOKEN`, the PlanetScale organization and database names as
variables `PLANETSCALE_DRY_RUN_ORG` and `PLANETSCALE_DRY_RUN_DATABASE`, and a restored branch costs as much as the production branch while
it exists.

Guards the workflow already applies: manual runs only, a required reviewer,
no secrets besides the branch connection (no email, Stripe, Slack, connector
or model credentials), masked credentials, one run at a time, a 90 minute
timeout, and branch deletion in an `always()` step. Never copy rows out of the
branch, never screenshot it, and never point a full Den deployment with real
integrations at it.

## Before merge and deploy

- The PR states the rule, the Level 1 query, the ops steps that must happen
  first, and the deploy order when more than one service changes.
- Do the ops steps with the person's numbers, re-run the Level 1 query, and
  confirm nobody is newly blocked before deploying.
- Know the rollback: revert the PR, or, if the change is behind a feature,
  the kill switch in `/admin` (`add-a-feature`).
