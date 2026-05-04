# GitHub Connector

This document describes how the GitHub connector should work for the new plugin architecture.

## Goal

Let an organization use a GitHub repo as a source of truth for config objects and plugins.

The GitHub connector should:

- connect through a GitHub App;
- let admins choose a repo and branch;
- let admins map repo paths to config object types and optional plugins;
- ingest matching files into OpenWork;
- keep OpenWork in sync when GitHub sends webhook events.

## Core model

The recommended model is:

- GitHub is an external source;
- OpenWork stores a connector account, connector instance, target repo, and path mappings;
- GitHub webhooks notify OpenWork that the selected branch changed;
- OpenWork then reconciles against the current branch head state;
- OpenWork does not treat individual changed files in the webhook payload as the final source of truth.

That means the primary sync model is:

- branch-head reconciliation, not event-by-event mutation replay.

## Why branch-head reconciliation is the right model

When a commit lands on the selected branch, the safest thing to do is:

1. determine the new head commit for the tracked branch;
2. read the current repo state at that commit;
3. evaluate all configured mappings against that state;
4. create, update, or tombstone config objects accordingly.

This is better than replaying per-file webhook changes because it:

- makes merges and squash merges behave the same way as regular pushes;
- avoids drift if webhook deliveries arrive out of order;
- makes retries idempotent;
- lets us recover from partial ingestion failures by re-running the same reconciliation at the same commit;
- treats GitHub branch state as the authoritative source, not webhook payload details.

The webhook tells us that something changed.
The repo head tells us what is now true.

## Main components

### GitHub App

We create and operate a GitHub App.

Users:

- install the app on their GitHub org or selected repos;
- authorize OpenWork to see which installations/repos they can use;
- choose one installed repo during connector setup.

The GitHub App gives us:

- installation identity;
- repo access;
- webhook delivery from GitHub;
- installation tokens for API access.

### OpenWork connector records

The GitHub connector should fit the generic connector model already documented in `prds/new-plugin-arch/datastructure.md`.

Relevant records:

- `connector_account`
  - represents the GitHub App installation / account binding;
- `connector_instance`
  - represents one configured use of GitHub inside an org;
- `connector_target`
  - represents a specific repo + branch target;
- `connector_mapping`
  - maps paths in that repo to config object types and optional plugin auto-membership;
- `connector_sync_event`
  - records each webhook-triggered or manual sync run;
- `connector_source_binding`
  - links an ingested config object to its GitHub source path;
- `connector_source_tombstone`
  - preserves deleted path history.

### Flexible connector ids

The shared connector model should always keep:

- a local OpenWork `id`
- a connector `type`
- a connector-native `remote_id`

Current GitHub mapping:

- `type`: `github`
- target `remote_id`: `org/repo`

Recommended GitHub-specific examples:

- `connector_account.remote_id`
  - GitHub installation id, or installation-scoped account key if we need a string form;
- `connector_target.remote_id`
  - `org/repo`;
- `connector_source_binding.remote_id`
  - GitHub blob/file identifier if useful, otherwise nullable and path-based identity is enough.

This keeps the schema flexible for other connectors while still preserving GitHub-specific identifiers.

## Setup flow

### 1. Install GitHub App

Admin installs the GitHub App into their GitHub org or user account.

OpenWork stores:

- GitHub installation id;
- GitHub account/org identity;
- available repos for that installation.

This becomes the `connector_account`.

Recommended stored fields:

- `connector_type = github`
- `remote_id = <github_installation_id>`
- installation account login/name
- installation account type (`Organization` or `User`)

### 2. Create connector instance

Inside OpenWork, an admin creates a GitHub connector instance.

They choose:

- installation/account;
- repo;
- branch;
- optional name for this connector instance.

This becomes:

- `connector_instance`
- one `connector_target` for repo + branch.

Recommended stored target fields:

- `connector_target.connector_type = github`
- `connector_target.remote_id = org/repo`
- repo numeric id
- repo owner login
- repo name
- branch name / full ref
- default branch at time of setup if useful for validation

### 3. Create repo mappings

Admin configures one or more mappings from repo paths to config object types.

Examples:

- `/sales/skills/**` -> `skill` -> plugin A
- `/sales/agents/**` -> `agent` -> plugin A
- `/finance/commands/**` -> `command` -> plugin B
- `/shared/mcps/**` -> `mcp` -> no auto-plugin

Each mapping may include:

- path selector/glob;
- target config object type;
- parser mode if needed;
- plugin id if auto-adding to a plugin;
- `auto_add_to_plugin` flag.

This becomes `connector_mapping`.

### 4. Initial full sync

After setup, OpenWork should run an initial full reconciliation against the selected branch head.

This seeds:

- config objects;
- config object versions;
- plugin memberships;
- source bindings.

## Webhook model

### Endpoint shape

GitHub Apps support a single webhook URL per app registration.

So the recommended shape is:

- one public GitHub ingress endpoint;
- internal routing to event-specific handlers.

Recommended public endpoint:

- `POST /v1/webhooks/connectors/github`

Recommended internal handler split:

- `githubWebhookIngress()`
  - receives the raw HTTP request
  - verifies the signature
  - parses headers and payload
  - dispatches by event type
- `handleGithubPushEvent()`
- `handleGithubInstallationEvent()`
- `handleGithubInstallationRepositoriesEvent()`
- `handleGithubRepositoryEvent()` optional later

If we want subpath-style organization inside the app, we can still do that after ingress.

Example internal structure:

- public ingress: `POST /v1/webhooks/connectors/github`
- internal modules:
  - `webhooks/connectors/github/push`
  - `webhooks/connectors/github/installation`
  - `webhooks/connectors/github/installation-repositories`

Important constraint:

- GitHub itself should send to one externally registered webhook URL;
- event-specific subpaths are best treated as internal server organization, not multiple GitHub-facing URLs.

### Events we care about

For v1, the main event should be GitHub `push` webhook deliveries.

Why:

- a merge to the tracked branch produces a push event;
- a direct commit to the tracked branch also produces a push event;
- the push event gives us the repo, branch ref, and head commit.

So the practical rule is:

- ignore webhook events that do not change the selected branch;
- enqueue reconciliation when a push hits the selected branch.

We may also care about some non-content events for connector health, but not for ingestion truth:

- installation removed;
- repo access removed;
- repo renamed or archived.

Those should update connector state, but they should not replace branch-head content sync.

Current implementation note:

- `installation.deleted` updates matching `connector_account` rows to `disconnected` and does not enqueue a content sync job.

### Events we can ignore for ingestion

For config ingestion, we should ignore or de-prioritize:

- pushes to other branches;
- pull request open/update events;
- issue events;
- comment events;
- check runs;
- release events.

We do not need PR merge events separately if push-to-branch is our source trigger.

## What happens on webhook

### Recommended flow

When GitHub sends a webhook:

1. verify the GitHub webhook signature before doing anything else;
2. identify the GitHub installation and repo;
3. find matching `connector_target` rows;
4. ignore any target where the webhook ref does not equal the configured branch ref;
5. create a `connector_sync_event` in `pending` or `running` state;
6. enqueue a reconciliation job keyed by connector target + head commit;
7. return success to GitHub quickly.

Important:

- signature verification is mandatory, not optional;
- webhook handling should be lightweight;
- actual ingestion should happen asynchronously in a job worker.

### Signature verification requirements

OpenWork must verify the GitHub App webhook secret on every incoming webhook delivery.

Requirements:

- store the GitHub App webhook secret securely on the server side;
- validate the signature header from GitHub against the raw request body before JSON parsing or event processing;
- reject the request if the signature is missing, invalid, or computed from a body that does not match the raw bytes received;
- use a constant-time comparison when checking the computed signature;
- log verification failures at a security/ops level, but do not process the event.

Practical rule:

- no signature match, no webhook processing.

Additional hardening:

- record the GitHub delivery id for traceability;
- make delivery handling idempotent so safe retries are possible;
- optionally track duplicate delivery ids to reduce redundant work.

### Verification implementation shape

The signature check should happen in the public ingress endpoint before event dispatch.

Recommended flow:

1. read the raw request body bytes exactly as received;
2. read GitHub headers:
   - `X-Hub-Signature-256`
   - `X-GitHub-Event`
   - `X-GitHub-Delivery`
3. compute HMAC SHA-256 over the raw body using the GitHub App webhook secret;
4. compare the computed digest with `X-Hub-Signature-256` using constant-time comparison;
5. reject the request if verification fails;
6. only then parse JSON and dispatch by event type.

Key implementation rule:

- the signature must be computed from the raw body, not from re-serialized JSON.

Recommended pseudocode shape:

```ts
async function githubWebhookIngress(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-hub-signature-256")

  if (!signature) return new Response("missing signature", { status: 401 })

  const expected = signGithubBody(rawBody, env.GITHUB_CONNECTOR_APP_WEBHOOK_SECRET)
  if (!timingSafeEqual(signature, expected)) {
    return new Response("invalid signature", { status: 401 })
  }

  const event = req.headers.get("x-github-event")
  const deliveryId = req.headers.get("x-github-delivery")
  const payload = JSON.parse(rawBody)

  return dispatchGithubWebhook({ event, deliveryId, payload })
}
```

Recommended helper responsibilities:

- `signGithubBody(rawBody, secret)`
  - returns `sha256=<digest>`
- `timingSafeEqual(a, b)`
  - prevents naive string comparison timing leaks
- `dispatchGithubWebhook()`
  - routes to event-specific handlers

### Dispatch model

After signature verification, the ingress should dispatch by event type.

Recommended event routing:

- `push` -> `handleGithubPushEvent`
- `installation` -> `handleGithubInstallationEvent`
- `installation_repositories` -> `handleGithubInstallationRepositoriesEvent`
- `repository` -> `handleGithubRepositoryEvent` optional later
- everything else -> acknowledge and ignore

That gives us:

- one secure ingress path;
- explicit event-specific logic;
- easy expansion later without changing the GitHub App registration URL.

For GitHub, useful preserved webhook fields include:

- `X-GitHub-Delivery`
- installation id
- repository id
- repository full name
- ref
- after SHA / head SHA

### API shape

This is the recommended API contract shape around the webhook ingress and async sync pipeline.

#### Public webhook ingress

Endpoint:

- `POST /v1/webhooks/connectors/github`

Input:

- raw GitHub webhook request body
- GitHub headers including:
  - `X-Hub-Signature-256`
  - `X-GitHub-Event`
  - `X-GitHub-Delivery`

Behavior:

1. verify signature against raw body
2. reject with `401` if invalid or missing
3. parse event metadata
4. if event is irrelevant, acknowledge and return success
5. if event is relevant, create or update a `connector_sync_event`
6. enqueue async reconciliation keyed by connector target and head SHA
7. return quickly without doing full ingestion inline

Recommended responses:

- `401 Unauthorized`
  - signature missing or invalid
- `202 Accepted`
  - valid event accepted for async processing
- `200 OK`
  - valid but intentionally ignored event

Example response shape for accepted events:

```json
{
  "ok": true,
  "accepted": true,
  "event": "push",
  "deliveryId": "<github-delivery-id>",
  "queued": true
}
```

Example response shape for ignored events:

```json
{
  "ok": true,
  "accepted": false,
  "reason": "event ignored"
}
```

Example response shape for invalid signature:

```json
{
  "ok": false,
  "error": "invalid signature"
}
```

#### Internal webhook dispatch contract

Recommended normalized dispatch input:

```ts
type GithubWebhookEnvelope = {
  deliveryId: string
  event: string
  installationId?: number
  repositoryId?: number
  repositoryFullName?: string
  ref?: string
  headSha?: string
  payload: unknown
}
```

The ingress should build this envelope once, then hand it to event-specific handlers.

#### Internal sync enqueue contract

For relevant push events on a tracked branch, enqueue an internal sync job.

Recommended job payload shape:

```ts
type GithubConnectorSyncJob = {
  connectorType: "github"
  connectorInstanceId: string
  connectorTargetId: string
  connectorSyncEventId: string
  deliveryId: string
  installationId: number
  repositoryId: number
  repositoryFullName: string
  ref: string
  headSha: string
}
```

Important:

- dedupe jobs on `connectorTargetId + headSha`
- preserve `deliveryId` for observability
- do not require webhook redelivery to retry; the job should be rerunnable internally

#### Internal sync trigger behavior

The enqueue layer should:

- resolve matching connector targets by `connector_type`, repo identity, and branch ref
- create one logical sync event per target + head SHA
- avoid double-enqueuing the same target/head combination
- mark the sync event as queued/running before worker execution

#### Worker result contract

The reconciliation worker should update the corresponding `connector_sync_event` with at least:

- final status (`completed`, `failed`, `partial`)
- target id
- head SHA
- counts for created / updated / deleted / skipped objects
- per-file parse failures if any
- completed timestamp

This does not need to be a public API response, but it should be the internal result shape we can rely on for UI and debugging.

## Reconciliation job

### Input

The reconciliation job should take:

- `connector_instance_id`
- `connector_target_id`
- repo owner/name
- branch ref
- head commit SHA from the webhook

### Step 1: fetch current repo state

OpenWork should fetch repo state at the selected branch head commit.

Recommended rule:

- treat the head commit tree as the truth;
- do not rely solely on the changed-file list in the webhook.

Implementation choices:

- use GitHub contents/tree APIs for mapped paths;
- or fetch an archive / git tree snapshot for the relevant branch;
- or diff previous ingested SHA vs new SHA as an optimization later.

For v1, the clearest behavior is:

- enumerate all files matching the configured mappings at the new branch head.

### Step 2: resolve applicable files

For each `connector_mapping`:

1. list files under the mapped selector;
2. filter to files that are valid for that config type;
3. parse the file into the normalized config type shape;
4. build the desired-state set for that mapping.

This gives us the desired current set of GitHub-backed config objects for that target and commit.

### Step 3: compare desired state to current bindings

For each mapping, compare:

- desired files at branch head
vs
- active `connector_source_binding` rows for that mapping.

Then:

- file exists and binding exists -> update existing object with a new version if content changed;
- file exists and no binding exists -> create a new object and binding;
- binding exists and file no longer exists -> tombstone the binding and mark the object deleted/inactive;
- file reappears at a previously deleted path -> create a new object identity, do not revive the tombstoned one.

### Step 4: create or update config objects

For each live file:

1. parse raw source according to config type;
2. create a new `config_object_version` if content or relevant parsed state changed;
3. project current searchable metadata onto `config_object`;
4. update `connector_source_binding.last_seen_source_revision_ref`;
5. ensure plugin membership exists if the mapping auto-adds to a plugin.

### Step 5: handle deletions

For files no longer present at the branch head:

1. create a deleted version or otherwise mark the object deleted/inactive;
2. close the active `connector_source_binding`;
3. insert `connector_source_tombstone` with the deleted path and prior object id;
4. keep plugin membership history intact, but exclude deleted objects from active delivery.

## Plugin auto-membership behavior

If a mapping is bound to a plugin and `auto_add_to_plugin = true`:

- newly discovered files create config objects and are automatically added to that plugin;
- updated files stay in the plugin;
- deleted files remain historically associated but are not active downloadable members.

If a mapping has no plugin binding:

- config objects are still ingested and managed by the connector;
- plugin membership can be added manually later through the API/UI.

## Current recommendation on diffs vs full scan

The recommended answer to your question is:

- yes, after a qualifying webhook we should read the repo state and ingest from that state.

More precisely:

- we should reconcile against the selected branch head, not trust file diffs alone.

The changed-file list from GitHub push events can be useful later as an optimization, but it should not be the authoritative ingestion algorithm for v1.

## Idempotency and retries

The sync worker should be idempotent.

That means:

- same connector target + same head SHA should be safe to process more than once;
- if a previous attempt failed halfway through, we should be able to rerun it;
- duplicate webhook deliveries should not create duplicate objects or bindings.

Good guardrails:

- dedupe jobs on `connector_target_id + head_sha`;
- store sync event status transitions;
- skip creating a new version if parsed content did not materially change.

## Failure handling

If some files fail to parse:

- do not fail the entire connector target unless the repo itself could not be read;
- record per-file failures in sync metadata;
- leave previously successful objects intact;
- mark the affected object or sync event with an ingestion error state.

Admins should be able to see:

- last successful sync time;
- last attempted commit SHA;
- parse failures by file path;
- whether the connector target is currently healthy.

## Security and permissions

### GitHub side

We should request the smallest practical GitHub App permissions needed for branch-head reconciliation.

Recommended repository permissions:

- `Contents: Read-only`
  - required to read files, trees, and branch-head content for mapped paths;
- `Metadata: Read-only`
  - required for basic repository identity and repo metadata;

Recommended account/install scope:

- installable on organizations and optionally user accounts if we want both use cases;
- repo access should preferably be selected repos, not all repos, unless the user explicitly chooses broader scope.

Recommended webhook subscriptions:

- `push`
  - primary content-ingestion trigger for the selected branch;
- `installation`
  - detect app uninstalls or installation-level lifecycle changes;
- `installation_repositories`
  - detect when repo access is added or removed from the installation.

Optional later webhook subscriptions if product needs them:

- `repository`
  - useful for rename/archive/default-branch changes if we want explicit lifecycle updates.

Permissions we should avoid unless later requirements demand them:

- write permissions on repository contents;
- issues, pull requests, actions, deployments, or admin permissions;
- any org/user permissions unrelated to connector setup and repo reading.

Operational note:

- installation tokens are generated from the GitHub App installation and are not themselves a separate permission choice, but the app/server must securely mint and use them only when reading the configured repo state.

### OpenWork side

Separate RBAC should govern:

- who can connect a GitHub installation;
- who can create connector instances;
- who can edit mappings;
- who can bind mappings to plugins;
- who can manually edit ingested objects after sync.

## State we should preserve

For every ingested GitHub-backed object, we should preserve:

- installation id;
- GitHub account/org login;
- repository id;
- repo owner/name;
- branch;
- mapping id;
- connector target `remote_id` (`org/repo`);
- source path;
- file name and extension;
- last seen commit SHA;
- sync event history;
- tombstone history for deleted paths.

## Suggested lifecycle summary

### On setup

1. install GitHub App
2. create connector account
3. create connector instance and target repo/branch
4. create mappings
5. run initial full reconciliation

### On qualifying push webhook

1. verify event
2. check selected branch match
3. enqueue reconciliation
4. fetch current branch-head state
5. evaluate mappings
6. create/update/delete/tombstone config objects
7. update plugin memberships
8. mark sync event complete

## Recommendation summary

The GitHub connector should work like this:

- GitHub App installation gives OpenWork repo access and webhooks;
- admins map repo paths on a selected branch to config object types and plugins;
- GitHub push events on the selected branch trigger async reconciliation;
- OpenWork reads the current branch-head repo state and ingests from that state;
- OpenWork compares desired current files against existing bindings to create, update, delete, and tombstone objects;
- plugin auto-membership is driven by connector mappings.

That keeps the system deterministic, retryable, and aligned with the one-source-of-truth rule.

## Open questions

- Should v1 read repo state through tree APIs, archive downloads, or a shallow git mirror worker?
- Should we ingest only mapped paths, or fetch the whole tree and filter locally?
- Do we want manual "resync now" controls per connector target?
- Do we want to expose last synced commit SHA in the admin UI?
