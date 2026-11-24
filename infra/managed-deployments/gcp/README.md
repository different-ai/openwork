# GCP managed deployments (off by default)

This installer runs in the customer's project, not in OpenWork's cloud. A
person approves it in a terminal (Cloud Shell); the installation itself is a
**Cloud Build build in that project, running as the deployment's runner service
account**. The terminal can close once the build is submitted.
Use a **dedicated, billing-enabled project**: the runner's deployment roles are
project-wide and are not safe isolation from unrelated workloads. Only the
customer approves IAM, API enablement, and billable resources. No account keys
are created and nothing impersonates a service account. OpenWork receives an
audience-bound service-account ID token and allowlisted progress/health
reports, never credentials, Terraform state, logs, secret values, or the
administrator bootstrap code.

**Not proven live.** The Cloud Build runner, tuning and take-over below have
offline tests only. See [What is and is not proven](#what-is-and-is-not-proven)
before publishing a release that contains them.

## How a run works

1. **Approval command** (unchanged shape, `cloudShellCommand` in
   `packages/managed-deployments/src/gcp.ts`): download the pinned bundle, check
   its SHA-256, extract it safely, run `runner/install.py --config-base64 …`.
2. **In the approving person's terminal**, with that person's own `gcloud`
   credentials, `install.py`:
   - validates every launch value and verifies the project number and public
     DNS zone;
   - stops if the deployment has been taken over (`ejected.json`, see
     [Take over](#take-over-eject));
   - prints the scope and asks for the exact project ID;
   - verifies the whole bundle again, runs the idempotent bootstrap, and
     submits one build with `gcloud builds submit --no-source --async`;
   - prints the build ID and log link and exits.
   There is no `gcloud auth application-default login`, no Terraform and no
   waiting in the terminal.
3. **In the build**, as the runner service account, the generated step
   downloads the pinned bundle again, refuses it unless its SHA-256 matches,
   and starts `install.py --cloud-build`. That repeats the full inventory
   verification, confirms the build's identity is this deployment's runner, and
   starts `runner.py`: enrol with OpenWork, check the project, the take-over
   marker and `overrides.json`, mirror images, run Terraform, record the apply,
   verify health, report the six milestones.

### The build

`install.py` generates the build configuration at approval time (the bundle
still contains only `.py`, `.tf` and the provider lock file):

| Setting | Value | Why |
| --- | --- | --- |
| `serviceAccount` | `projects/PROJECT/serviceAccounts/ow-…-runner@PROJECT.iam.gserviceaccount.com` | Explicit. Never the project's default build account |
| `options.logging` | `CLOUD_LOGGING_ONLY` | Required with a user-specified service account. Logs stay in the project's Cloud Logging |
| `timeout` | `10200s` (2 h 50 min), build and step | Certificate issuance alone can take an hour; it stays inside OpenWork's three-hour run lifetime, which now starts at enrolment |
| Region | `global` (Cloud Build's default pool), or `OPENWORK_CLOUD_BUILD_REGION` exported before the approval command | Never derived from the deployment region: Cloud Build and Cloud Run offer different regions |
| Source | none (`--no-source`) | Nothing is uploaded; no source bucket is created |
| Step image | Google's Cloud CLI image `594.0.1-slim`, pinned by digest (`BUILD_IMAGE`) | Provides `gcloud` and CA certificates |
| Step entrypoint | the image's bundled Python (`BUILD_PYTHON`) | The image has no `python3` on `PATH` |
| Substitutions | only `$BUILD_ID`; every other `$` is escaped | The runner records the build ID in the orchestration lock |

The image has no Docker client and no Terraform. `runner.py` downloads both
from their publishers and refuses them unless the SHA-256 matches the pinned
value (`TERRAFORM_SHA256`, `DOCKER_SHA256`): Terraform 1.16.5, and Docker's
static client 28.5.2 used against Cloud Build's Docker daemon.

Google deletes Cloud CLI image versions after one year. **Refresh `BUILD_IMAGE`
in a new installer before the pinned version is a year old**, or builds from
older installers stop starting.

### Runner identity, no impersonation

- `gcloud`, Terraform and the GCS backend use the build's own credentials from
  the metadata server. `install.py --cloud-build` removes credential selectors
  from the environment (`GOOGLE_*CREDENTIALS`, `GOOGLE_OAUTH_ACCESS_TOKEN`,
  `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, `GOOGLE_BACKEND_*`, `CLOUDSDK_AUTH_*`),
  refuses a local application-default credentials file, refuses to start
  without a Cloud Build `BUILD_ID`, and refuses any active account other than
  this deployment's runner. Terraform never runs as a person.
- The Terraform root and its backend name no identity. A deployment bootstrapped
  from Cloud Shell keeps its bucket, state prefix and runner account; the next
  run migrates it. `tests/cloud-shell-root` is the root as those installers
  applied it, and `adoption.tftest.hcl` proves the current root plans no change
  on that state (mocked provider).
- **Enrolment token.** OpenWork requires `email` and `email_verified` claims
  and a token less than 60 seconds old. The runner calls the IAM Credentials
  API `generateIdToken` for **itself** with `includeEmail: true`, authorized by
  its own access token. That is the API `gcloud` used when a person
  impersonated the runner, so the token has the same shape. Bootstrap grants
  the runner `roles/iam.serviceAccountOpenIdTokenCreator` **on itself only**;
  that role cannot mint access tokens, sign blobs or create keys. The Cloud
  Build metadata server's `format=full` token is not relied on.

## Release and launch contract

Package `runner/install.py`, `runner/runner.py`, `health/health_agent.py`,
`terraform/*.tf`, `terraform/.terraform.lock.hcl`, `../contract/*.tf`, and every
operational `.tf` in `infra/terraform/modules/openwork-gcp-cloud-run` in the
checksummed release bundle, preserving repository paths. Tests/examples, state,
plans and credentials are never packaged. The builder checks module-local file
references against the payload, and extraction requires the complete module.
`release.json` must contain `provider: "gcp"`, `version`, `protocolVersion: 1`,
a `files` map of path to SHA-256, and an `images` inventory with exactly
`den_api`, `den_web`, and `health`. Every image is a Linux/amd64 manifest pinned as
`ALLOWLISTED_REPOSITORY@sha256:64_LOWERCASE_HEX_DIGITS`. The only repositories are
`ghcr.io/different-ai/openwork-den-api`, `ghcr.io/different-ai/openwork-den-web`,
and `docker.io/library/python`, respectively. Image pins are protected by the
same bundle SHA-256 as the executable inventory. Missing pins, tags, other
repositories, and invalid digests are rejected before bootstrap. Publish `tutorial.md`, the bundle and
manifest as immutable GCS object generations. The control plane supplies the
pinned bundle hash. The launch command verifies that hash before safely
extracting and executing `infra/managed-deployments/gcp/runner/install.py`;
it **must not** pipe an unverified download to a shell.

### Operator image pinning (before publication)

Build with `node infra/managed-deployments/tools/build-release.mjs gcp VERSION OUTPUT_DIRECTORY`.
The operator needs Docker CLI with `docker manifest inspect --verbose` support,
registry network access, and registry credentials if the published OpenWork
images require them (`docker login ghcr.io`). No Docker daemon or customer-cloud
credentials are needed to resolve manifests. The builder resolves the exact
published OpenWork version tags to a unique Linux/amd64 manifest, then verifies
each digest exists by reading that immutable reference again. It selects health
from the already approved hardcoded Python index digest, never a Python tag.
Schema-v2 and OCI manifests are supported; attestations and other platforms
cannot become the selected image. Resolution failures stop the build, with no
fallback to mutable tags.

An operator may supply `--image-pins APPROVED_JSON_FILE` after the output
directory to select approved Linux/amd64 OpenWork manifest digests explicitly.
The file must contain exactly `den_api` and `den_web` with the same repository
allowlist. **This does not skip registry verification**: each supplied immutable
manifest must exist and be Linux/amd64. Health always comes from the hardcoded
approved digest. Never publish artifacts made with mocked registry metadata;
offline tests use a separate mocked Docker executable and synthetic pins.

Installer input is `--config-base64 <base64 JSON>` using the `GcpLaunch` shape in
`packages/managed-deployments/src/gcp.ts`: `deploymentId`, `runId`, `challenge`,
`target: {projectId, projectNumber, region, dnsZoneName}`, `domainName`,
`ownerEmail`, `size: "small"`, and
`release: {templateUrl, bundleUrl, bundleSha256, version, apiOrigin}`.
All fields are public configuration, not credentials. The bundle URL must be
`https://storage.googleapis.com/BUCKET/OBJECT?generation=DIGITS`.

The customer reviews the project, resource scope and cost, then types the exact
project ID to approve. The script verifies the project number and public DNS
zone before changing anything, checks the bundle before executing anything,
enables the required APIs, creates deterministic identities, and creates a
versioned GCS state bucket with uniform access and public-access prevention.
Google encrypts objects at rest. State is outside Terraform and never removed
by the installer. Terraform's native GCS backend supplies generation-based
locking. Retrying uses the same bucket and identities; existing insecure state
buckets are rejected rather than silently adopted. A separate retained GCS
`deployments/DEPLOYMENT_ID/orchestration.lock` object serializes the entire
image-mirroring, migration, rollout and readiness sequence, not just individual
Terraform commands. Creation requires `ifGenerationMatch=0`; only the process
holding the returned generation releases the live lock with that exact
`ifGenerationMatch`. Terraform's native state lock remains enabled as well.
The lock records `{"runId": …, "buildId": …}`: the OpenWork run and the Cloud
Build build that own it. A contending run fails closed rather than waiting,
expiring the lock, or stealing it.

### Interrupted-run lock recovery (customer administrator only)

Normal success or caught failure releases the orchestration lock. A killed
process, lost acquisition receipt, or failed release leaves it retained. There
is deliberately **no automatic stale-lock recovery**: an old timestamp does not
prove that an installer or migration has stopped.

1. Read the lock's `buildId` and confirm that build has ended
   (`gcloud builds describe BUILD_ID --region=global` shows a final status, not
   `QUEUED` or `WORKING`; a build that timed out or was cancelled leaves its
   lock). A lock without `buildId` came from a Cloud Shell installer: confirm
   that shell process has stopped. Confirm no migration execution or rollout
   from the owner is still running. Do not recover a lock while its owner can
   continue; do not send state, tokens, or command logs to OpenWork.
2. Record the lock's exact live object `generation`:
   `gcloud storage objects describe gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock --raw`.
3. Only after reviewing the interrupted run, remove **that specific generation**:
   `gcloud storage rm 'gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock#GENERATION'`.
   The generation-qualified URL cannot remove a newer owner's lock. Never use
   an unqualified delete, recursive delete, wildcard, or bucket deletion.
4. Retry the installer. If a lock still exists, inspect it again rather than
   deleting a different generation blindly. Do not force-unlock Terraform state
   merely because the orchestration lock exists; its lock is independent.

The approving principal gets `roles/iam.serviceAccountUser` ("act as") **only
on that runner**, which is what Cloud Build requires to start a build as it. It
is not a project role and cannot mint the runner's tokens or keys. A run on a
deployment bootstrapped from Cloud Shell removes that person's earlier
`roles/iam.serviceAccountTokenCreator` grant on the runner and lists any other
members that still hold it, without changing them. Terraform never runs as the
user. Runner roles allow changes across the dedicated project (not owner/editor
or project IAM admin); runtime and health IAM are bootstrapped by the customer.
The runner's project roles are exactly `RUNNER_ROLES` in `runner/install.py`
plus the one-permission drain role; this change adds only
`roles/logging.logWriter`, which lets the build write its own log entries.
The API/migration runtime gets access only to this deployment's secrets and
Cloud SQL. Den Web uses a separate identity with no project roles, secret access,
or Cloud SQL mount; the installer can act as it only to deploy Web.
The health identity has read-only Cloud Run/SQL/certificate visibility and no
secret accessor, DNS write, IAM write, or Terraform state access. Cloud Scheduler
uses a separate identity scoped to invoke the health job.

### Approving operator permissions (before bootstrap)

The **signed-in operator in the terminal**, not the runner, performs bootstrap
IAM changes and starts the build. Project IAM Admin plus Role Administrator is
**not sufficient**: project IAM policy and a service account's own IAM policy
are different resources. The operator also needs
`iam.serviceAccounts.setIamPolicy` (and `iam.serviceAccounts.getIamPolicy`) on
the five deployment-owned service accounts, including the runner. Bootstrap
grants the runner `roles/iam.serviceAccountUser` on
runtime/web/health/scheduler, grants the runner
`roles/iam.serviceAccountOpenIdTokenCreator` on itself, and grants the approving
operator `roles/iam.serviceAccountUser` on the runner. Those grants cannot be
created merely with project-level `resourcemanager.projects.setIamPolicy`.

Have the customer's administrator approve the following capabilities before
running the command; use equivalent scoped custom grants where appropriate:

| Operator operation | Required permission boundary / example role |
| --- | --- |
| Verify project and public DNS zone | Project read and `dns.managedZones.get` on the selected project/zone |
| Enable the listed APIs | `serviceusage.services.enable` and supporting service/operation reads; Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`) |
| Create/list the five deployment service accounts | `iam.serviceAccounts.create` and `iam.serviceAccounts.list` on the project |
| Set/read policies on those service accounts | **`iam.serviceAccounts.setIamPolicy` and `iam.serviceAccounts.getIamPolicy`**; Service Account Admin (`roles/iam.serviceAccountAdmin`) is an administrative example, scoped to the deployment accounts where possible |
| Grant the documented project roles | `resourcemanager.projects.getIamPolicy` / `setIamPolicy`; Project IAM Admin (`roles/resourcemanager.projectIamAdmin`) |
| Create or verify the one-permission drain role | `iam.roles.create`, `iam.roles.list`, `iam.roles.get`; Role Administrator (`roles/iam.roleAdmin`) is an administrative example; bootstrap does not update an existing role |
| Create/verify the versioned private state bucket and grant object access | Bucket create/list/get/update and bucket get/set IAM-policy permissions on the selected project/bucket; Storage Admin (`roles/storage.admin`) is an administrative example |
| Read the take-over marker before approval | `storage.objects.get` on the state bucket once it exists |
| Start the build as the runner | `cloudbuild.builds.create` on the project; Cloud Build Editor (`roles/cloudbuild.builds.editor`) is an example. "Act as" on the runner is granted by bootstrap |
| Read the build log | `logging.logEntries.list`; Logs Viewer (`roles/logging.viewer`) is an example. Not needed for the installation to succeed |

An organization policy that restricts Cloud Build to private worker pools
(`constraints/cloudbuild.allowedWorkerPools`) blocks the default pool the build
uses. Resolve it with the customer's administrators; the installer does not
create worker pools.

These are **operator prerequisites, not additional runner permissions**. Do not
add Service Account Admin, Role Administrator or Project IAM Admin to the runner
to recover an operator's failed bootstrap. An administrator must explicitly
authorize any temporary operator grant; remove temporary grants after the
approved work, preserving pre-existing access. A denial in the terminal, before
the build is submitted, is not proof of a Terraform/runtime permission failure;
the terminal prints `gcloud`'s own error for it. Inspect the exact denied
service-account resource and operator permissions before retrying normal approval;
never patch service-account policies outside the approved bootstrap as a bypass.

## Runtime

Cloud SQL MySQL 8 with backups and deletion protection; Secret Manager;
Cloud Run API/Web services and an explicit migration job; a global HTTPS load
balancer with managed certificate and Cloud DNS records; a five-minute Cloud
Run health job authenticated with a Google metadata ID token. The health image
is copied by digest into the customer's Artifact Registry alongside the
release-pinned OpenWork images. The runner reads source references only from the
verified bundle's `release.json`, never runtime environment overrides or version
tags. After each pinned pull it verifies the local Linux/amd64 image and repository
digest, tags the inspected immutable local image ID, and pushes it. The resulting
Artifact Registry manifest digest must equal the release's source digest before
it can become a Terraform/Cloud Run input; mismatch fails closed, with no tag
fallback. The shared module's native `run_execution_token` runs the API
migration job **once before** new service revisions are applied; the runner does
not execute the job a second time. Failed/unknown migration outcomes block
rollout; inspect the execution before any deliberate retry. Plans reject
protected resource deletion/replacement, existing secret-version/generator
updates, database-password changes and database-version changes. Cloud SQL keeps
both deletion protections. While OpenWork manages the deployment, change it
through the installer and `overrides.json` ([Tune](#tune)), not a raw apply: the
installer's next run would undo other edits. To run Terraform yourself, take the
deployment over first ([Take over](#take-over-eject)), after a run has finished,
never during one.

## Tune, take over and remove

Same contract as AWS (`../README.md`): the same folder layout, `overrides.json`
keys and units, `applied/` files, marker and reported failure code. The
differences are listed at the end of this section.

```
gs://ow-<id>-<project number>-state/deployments/<deployment id>/
  default.tfstate          Terraform state (GCS backend, prefix deployments/<id>)
  orchestration.lock       present while a run owns the deployment
  overrides.json           customer-owned, optional
  applied/                 written by the runner after every successful apply
    release.json           provider, version, installerRevision (when present), bundleUrl, bundleSha256, deploymentId, runId
    inputs.auto.tfvars.json  exactly what Terraform was given, overrides included
    backend.tf.json        backend settings for this state, as a Terraform JSON file
    terraform-version.json version, sha256, platform and URL of the Terraform release
    outputs.json           non-sensitive outputs
    unmanaged.json         what bootstrap and the runner created outside the Terraform state
    README.md              how to tune, take over and remove this deployment
  ejected.json             customer-written marker; the installer refuses to run
```

`applied/` never holds secrets, state, the run token or the enrolment challenge.
The runner checks both run credentials against every file before writing any of
them. "Infrastructure installed" is reported only after the folder was written;
if the write fails, the run fails with `infrastructure_failed` and a retry
writes it. After a run that failed before that step, `applied/` still describes
the apply before it. The runner already has object access to this bucket, so
none of this needs a new approval.

### Tune

A customer writes `deployments/<id>/overrides.json`. The next run they approve
(update or retry) and every run after it applies the file; hosted OpenWork has
no separate "apply tuning now" action yet. The runner reads it before anything
changes, validates it and passes it to Terraform as the one typed `overrides`
variable in the same `managed.auto.tfvars.json` (`terraform/overrides.tf`). No
file means the inputs are exactly what they were before overrides existed.

| Key | Allowed | Google Cloud meaning |
| --- | --- | --- |
| `api.cpu`, `web.cpu` | 1024, 2048, 4096 or 8192, not below the size profile | Cloud Run CPU, 1024 per vCPU |
| `api.memory`, `web.memory` | MiB in whole GiB that Cloud Run offers for the CPU (1024: 1–4 GiB, 2048: 1–8, 4096: 2–16, 8192: 4–32), not below the size profile | Cloud Run memory |
| `api.min_instances`, `web.min_instances` | 1 to 10 | Cloud Run minimum instances |
| `api.max_instances`, `web.max_instances` | 1 to 100, not below the minimum | Cloud Run maximum instances |
| `database.tier` | `db-custom-<1,2,4,8,16,32>-<MB>` within Cloud SQL's memory rules | Cloud SQL machine type; changing it restarts the database |
| `database.disk_size_gb` | Profile disk (20) up to 4096 | Cloud SQL disk. A disk never shrinks: a plan that lowers it is refused before apply |
| `database.high_availability` | `true` or `false` | Cloud SQL regional availability |
| `extra_environment` | Up to 32 `OTEL_` variables | Added to Den API, web and the migration job; names or URLs that carry credentials are refused |

```json
{
  "api": { "cpu": 4096, "memory": 8192, "min_instances": 2, "max_instances": 20 },
  "web": { "memory": 2048 },
  "database": { "tier": "db-custom-2-7680", "disk_size_gb": 50, "high_availability": true },
  "extra_environment": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318" }
}
```

Anything else is refused: unknown keys, the database version, deletion
protection, backups, secrets, images and the network. A refused file fails the
run at "Google Cloud project and domain verified" with `infrastructure_failed`, before the
lock, image mirroring or Terraform; the build log names each refused setting,
never its value. The Terraform variable repeats the same checks and does not
declare anything else, and the plan guard still refuses data-bearing deletes
and replacements.

- **The disk only grows.** If the plan would make the Cloud SQL disk smaller
  than it is now (the setting was lowered or removed, or Cloud SQL grew the
  disk by itself), the run stops before maintenance with the current size and
  `infrastructure_failed`. Set `database.disk_size_gb` to at least that size.
- **Tuning is an update.** The run that applies the file uses the update's
  maintenance sequence, so both services scale to zero briefly.
- A size, tier or availability that Google Cloud does not offer in the region
  fails during apply, like any other provider refusal.

### Take over (eject)

`applied/README.md` in the customer's bucket has the exact commands for that
deployment. In short: write `deployments/<id>/ejected.json`, download and check
the bundle named in `release.json`, unpack it, install the recorded Terraform
version, copy `inputs.auto.tfvars.json` and `backend.tf.json` (as
`backend_override.tf.json`: the root declares an empty `backend "gcs" {}`, which
an override file replaces) into `infra/managed-deployments/gcp/terraform/`, then
`terraform init -lockfile=readonly && terraform plan`. The plan is expected to
show no changes.

- **Marker.** While `ejected.json` exists the runner refuses every run right
  after the project check, changes nothing, and reports `infrastructure_failed`
  with the reason in the build log. Its content is not read. The approval
  command also checks it with the approving person's credentials before the
  prompt, so normally no bootstrap change is made and no build starts. A marker
  that cannot be read (denied, network error) also stops the run; only a
  definite "not found" continues. Health reports continue. Deleting the marker
  hands the deployment back: the next run applies the installer's inputs again.
  Hosted OpenWork does not yet show such a deployment as self-managed.
- **Plan determinism.** The root reads no remote data at plan time besides the
  project and DNS zone. The health job embeds `health/health_agent.py` from the
  bundle, so the plan needs the bundle unpacked unchanged.
- **Credentials.** The configuration names no identity; the customer plans
  with their own (`gcloud auth application-default login`) or a service
  account they choose. It needs read and write on objects under the
  deployment's folder and read access to the deployment's resources, including
  its Secret Manager secret versions. Apply and destroy need to create, change
  and delete those resources; the runner's project roles are listed in
  `unmanaged.json`. The state holds the database password and application keys.
- **After taking over** the installer's protected-resource guard no longer
  runs; the customer reviews every plan for the database, secrets and services.

### Remove

Customer-run, with the same record: take over, get a plan with no changes,
export the database, `terraform apply -var allow_destroy=true` (turns off
deletion protection on Cloud SQL and the services), `terraform destroy -var
allow_destroy=true`, then remove what `unmanaged.json` lists (the Artifact
Registry repository, the five service accounts and their roles, the custom
role) and delete the state bucket last. `allow_destroy` is a root variable the
installer never sets and overrides cannot set.

### Where Google Cloud differs from AWS

| | AWS | Google Cloud |
| --- | --- | --- |
| `cpu`, `memory` | Fargate sizes | Cloud Run sizes: the same units (1024 per vCPU, MiB), different allowed values |
| `max_instances` | Must equal `min_instances` (fixed task count) | 1 to 100 and at least the minimum: Cloud Run scales between them |
| `database.tier` | RDS instance classes | Cloud SQL custom tiers |
| `log_retention_days` | CloudWatch retention | **Refused with a message.** Cloud Run logs go to the project's Cloud Logging buckets, which the deployment does not own; set retention there |
| Credential-bearing names | AWS list | The AWS list plus `bootstrap_code`, `database_url`, `smtp_pass`, which the shared Cloud Run module also refuses |
| Disk shrink | Refused when the autoscaling limit would drop to the current disk or below | Refused when the disk itself would shrink; Cloud SQL has no separate limit setting here |
| Orchestration lock | None (one CodeBuild build at a time) | Kept: two approvals can start two builds |
| Marker check | In the build | In the build, and earlier in the approving terminal |
| Deletion protection for removal | Turned off with the AWS CLI | `-var allow_destroy=true`: Terraform itself refuses to destroy a protected Cloud SQL instance |
| Recorded trust roots | `database_ca_bundle` | None needed: the connector verifies TLS |

## What is and is not proven

Checked offline for this change, with no cloud call:

- Unit tests for the terminal hand-off, build configuration, bootstrap grants,
  in-build identity checks, token request, overrides, marker and applied record
  (`tests/test_gcp_*.py`); Terraform tests for sizing, overrides, removal and
  state-neutral migration (`terraform/tests`).
- In the pinned build image, run locally under amd64 emulation: the bundled
  interpreter exists at `BUILD_PYTHON` and runs these unit tests; HTTPS
  verification works; `runner.py` downloaded and checksum-verified the pinned
  Terraform and Docker client, and the client negotiated with a Docker 29
  daemon.

**Not proven, required before a release that contains this is published:**

1. Cloud Build starts the build as the runner account in a fresh project (the
   Cloud Build service agent's access to a same-project user-specified account,
   `CLOUD_LOGGING_ONLY`, the `global` pool, the image pull).
2. Inside the build: `gcloud` reports the runner as the active account, and
   Terraform and its backend authenticate from the metadata server.
3. OpenWork accepts the enrolment token from `generateIdToken` called by the
   runner for itself.
4. The Docker socket is available to the step, and pull, tag and push to
   Artifact Registry work with the downloaded client.
5. The mirrored image digest equals the release pin for all three images.
6. A full install to Ready, and a version-increasing update of a deployment
   that was bootstrapped from Cloud Shell, including removal of the earlier
   token-creator grant and an unchanged plan from the migration alone.
7. Tuning on a real project: an update with an `overrides.json` (including a
   database tier change), one with a refused file, and a refused disk shrink,
   including how the provider plans a shrink and a disk Cloud SQL grew itself.
8. The record: a takeover whose `terraform plan` shows no changes; a run
   refused by `ejected.json` in the terminal and in a build. The credentials
   listed under Take over are the expected minimum, not a tested policy.
9. A removal that leaves nothing owned behind.
10. The terminal closing, and Cloud Shell expiring, after submission.

### Shared-module adoption and existing installs

The managed root consumes `infra/terraform/modules/openwork-gcp-cloud-run` with
explicit `managed_legacy=true` and `write_only_secrets=false`. **Managed secrets
remain state-backed**, including fresh managed installs; protect historical and
current GCS state. Direct module users retain their write-only defaults. Address
moves preserve the database, user, secret containers/versions, services and load
balancer; compatibility settings preserve their physical names and the existing
48-character generators. Web retains its separate identity, without DB access or
secret environment values. Bootstrap, DNS and health monitoring stay managed-only.

**MySQL stays on 8.0 for existing and fresh managed installs in this adoption.**
The direct module default remains 8.4. A managed major upgrade requires a separate
owner-approved plan; this installer never silently upgrades an existing instance.
The managed lock upgrades Google 6.49.0 to 8.7.0 and random 3.7.2 to 3.9.1, with
Linux amd64 and macOS amd64/arm64 checksums. The isolated October 21 Den Update
passed on head `26fdbbf2bf`, including the provider transition, all 31 address
moves, one migration after drain, and preservation of data, SQL 8.0/users, four
secrets, the original session and fresh sign-in. That frozen image set used a
dev-built legacy baseline, not a published stable installer. Fresh installation
passed on earlier head `0510ce753e`, not the final October head.

**Customer re-approval and maintenance are required.** The approving principal
must be able to create the deployment's custom IAM role (`iam.roles.create`,
and list/get roles on reuse). The runner's only additional grant is that custom
role's single `monitoring.timeSeries.list` permission on the dedicated project;
no monitoring viewer/admin, project-IAM administration or new web privileges.
Cloud Monitoring does not scope this read to one service; the observer filters
it to the two owned services. The project-ID approval names this grant; do not
silently update customer IAM outside that handoff.

Under the retained deployment mutex, the runner clears traffic tags (tag-only
revisions are not disabled by scale zero), disables both owned services and
requires fresh explicit zero active **and idle** instance observations for every
previously observed/routed revision. Missing, stale or incomplete observations
are unknown, not zero. Each fence/readiness CLI call and drain access-token
mint has a 30-second timeout, matching the health-execution command cap. A timeout
records a safe diagnostic and stops without replaying the command or restoring
traffic. A remote write may still complete, so inspect the partial outcome before
retrying. Already-disabled services remain disabled; a timeout before fencing
finishes does not prove both services stopped.
Then it applies the migration and API-only revisions **still at manual zero**,
verifies latest-created/latest-ready and all actual traffic belong to the new
pinned revision, and only then separately restores autoscaling. Failed checks
never automatically restore old revisions or tags. Manual jobs, independent
controllers/deployers and manual rollback are unsupported while this installer
manages the deployment (after taking over, they are yours to coordinate). Each update causes a short outage, with both services at zero
while migration runs. Previously old code kept serving during migration.
Pre-resume failures retain maintenance. Final health verification happens after
resume, so a later health failure can leave services serving. The October live
run covered metric emission and disabled-revision readiness for its frozen images,
not arbitrary later images.

Updates and retries remove Cloud Run revision tags on the OpenWork services;
recreate any you need afterwards on the new API-only revisions.

Before merging, the managed-deployments owners must review or explicitly waive
the grant, maintenance behavior and historical baseline/fresh-install boundaries.
Before publishing newer images, qualify that exact image set through isolated
Den Update, migration/auth/readiness and preservation checks, fresh install and
cleanup. The October pass does not certify today's images. Use reviewed
`--image-pins` if testing a new installer label with existing application digests;
never bypass Den's same-version rejection or publish mocked registry artifacts.

The runner enrolls using `{"provider":"gcp","idToken":"..."}` with audience
`API_ORIGIN/v1/managed-deployments/DEPLOYMENT/runs/RUN/enroll#CHALLENGE`
(see "Runner identity, no impersonation" for how the token is obtained).
Enrolment renews the run's three-hour lifetime for every run kind, so an
approval that waited does not shorten the installation.
Health uses `Authorization: Bearer <Google ID token>` with audience
`API_ORIGIN/v1/managed-deployments/DEPLOYMENT/heartbeat#SHA256(EXACT_BODY)`.
Each GCP report includes a fresh 32-character hex `nonce`, so even identical
snapshots request a different metadata-token audience. The API requires this
nonce and still enforces strict token freshness and issued-at replay checks.
The installed version is reported only when both services have observed the
current generation, the expected image, matching latest-created/latest-ready
revisions, and 100% actual traffic to that revision. Desired template images
alone cannot prove the installed version; old/split/missing traffic status
reports `services_running` as failing and omits the version.
SA names are `ow-<first 12 UUID hex digits>-runner` and `...-health`.
The API validates issuer, signature, audience, fresh issued-at, exact email,
and `email_verified`; no opaque self-reported identity is trusted.

## Limits / operator checks

The installer adopts the shared GCP module's connector and migration contract,
while explicitly retaining the managed naming, IAM and database compatibility
profile. Gateway and automations are disabled in the initial profile.
A published release must include Cloud SQL Unix-socket support. Public Cloud Run
invocation is needed behind the external load balancer; ingress is restricted to
`INTERNAL_LOAD_BALANCER`. Org policies may forbid public invocation or APIs,
service-agent creation, IAM grants, or public IP Cloud SQL. Resolve those with
customer administrators, never weaken policy automatically. Cloud SQL uses the
authenticated connector and no authorized networks. DNS must already be
authoritative. If your domain or a parent domain has CAA records, allow
`pki.goog` (Google Trust Services) in the closest non-empty CAA record set,
or the managed HTTPS certificate will not be issued. Certificate issuance
can take 60 minutes; a failed run can be retried after correcting DNS/CAA.

Isolated experimental cloud resources and installer artifacts were used for the
October tests, then cleaned up. No production rollout or stable installer
publication is claimed. Local mocked security/protocol tests and Terraform
validation do not prove a live Cloud Run deployment. Exact-image qualification
and an operator-approved immutable release remain publication gates. Serverless
NEG target health is inapplicable and omitted (the actual HTTPS routes are checked
instead).
Disk metrics and backups report `unknown/unavailable` while Google has no
measurements or successful backup yet, not fabricated successful checks.
Source image digests are pinned by the operator before publication and protected
by the control-plane-approved bundle checksum. Destination digests are verified
against those release pins, not merely resolved from a runtime version tag.
Registry metadata checks and local tests do not prove customer-registry mirroring
or a live installation. Do not enable the feature until the live validation
gates pass.

Run offline checks: `python3 -m unittest discover -s infra/managed-deployments/tests -p '*gcp*'`
and `node --test infra/managed-deployments/tests/build-release.test.mjs`.
Terraform: `terraform init -backend=false -lockfile=readonly`, `terraform validate`,
`terraform test`.
