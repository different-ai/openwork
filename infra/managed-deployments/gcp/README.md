# GCP managed deployments (off by default)

This installer runs in the customer's Cloud Shell, not in OpenWork's cloud.
Use a **dedicated, billing-enabled project**: the runner's deployment roles are
project-wide and are not safe isolation from unrelated workloads. Only the
customer approves IAM, API enablement, and billable resources. No account keys
are created. OpenWork receives an audience-bound service-account ID token and
allowlisted progress/health reports, never credentials, Terraform state, logs,
secret values, or the administrator bootstrap code.

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
Concurrent shells must not share local directories; a contending run fails
closed rather than waiting, expiring the lock, or stealing it.

### Interrupted-run lock recovery (customer administrator only)

Normal success or caught failure releases the orchestration lock. A killed
process, lost acquisition receipt, or failed release leaves it retained. There
is deliberately **no automatic stale-lock recovery**: an old timestamp does not
prove that an installer or migration has stopped.

1. Confirm the owning Cloud Shell process has stopped and no migration execution
   or rollout from it is still running. Do not recover a lock while its owner can
   continue. Inspect the lock's JSON `runId` and object metadata in the customer's
   project; do not send state, tokens, or command logs to OpenWork.
2. Record the lock's exact live object `generation`:
   `gcloud storage objects describe gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock --raw`.
3. Only after reviewing the interrupted run, remove **that specific generation**:
   `gcloud storage rm 'gs://STATE_BUCKET/deployments/DEPLOYMENT_ID/orchestration.lock#GENERATION'`.
   The generation-qualified URL cannot remove a newer owner's lock. Never use
   an unqualified delete, recursive delete, wildcard, or bucket deletion.
4. Retry the installer. If a lock still exists, inspect it again rather than
   deleting a different generation blindly. Do not force-unlock Terraform state
   merely because the orchestration lock exists; its lock is independent.

ADC consent is an explicit `gcloud auth application-default login` step; the
Terraform provider and backend impersonate the runner. The approving principal
gets Token Creator **only on that runner**. Terraform never runs as the user.
Runner roles allow changes across the dedicated project (not owner/editor or
project IAM admin); runtime and health IAM are bootstrapped by the customer.
The API/migration runtime gets access only to this deployment's secrets and
Cloud SQL. Den Web uses a separate identity with no project roles, secret access,
or Cloud SQL mount; the installer can act as it only to deploy Web.
The health identity has read-only Cloud Run/SQL/certificate visibility and no
secret accessor, DNS write, IAM write, or Terraform state access. Cloud Scheduler
uses a separate identity scoped to invoke the health job.

### Approving operator permissions (before bootstrap)

The **signed-in Cloud Shell operator**, not the runner, performs bootstrap IAM
changes. Project IAM Admin plus Role Administrator is **not sufficient**:
project IAM policy and a service account's own IAM policy are different resources.
The operator also needs `iam.serviceAccounts.setIamPolicy` (and
`iam.serviceAccounts.getIamPolicy`) on the five deployment-owned service accounts,
including the runner. Bootstrap grants the runner `roles/iam.serviceAccountUser`
on runtime/web/health/scheduler and grants the approving operator
`roles/iam.serviceAccountTokenCreator` on the runner. Those grants cannot be
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

These are **operator prerequisites, not additional runner permissions**. Do not
add Service Account Admin, Role Administrator or Project IAM Admin to the runner
to recover an operator's failed bootstrap. An administrator must explicitly
authorize any temporary operator grant; remove temporary grants after the
approved work, preserving pre-existing access. A denial before ADC enrollment is
not proof of a Terraform/runtime permission failure. Inspect the exact denied
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
both deletion protections. Use the installer, not an unguarded raw apply/destroy.

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
Linux amd64 and macOS amd64/arm64 checksums. Synthetic state tests are not proof of
a real Google 6→8 state refresh; the isolated live update must verify that.

**Customer re-approval and maintenance are required.** The approving principal
must be able to create the deployment's custom IAM role (`iam.roles.create`,
and list/get roles on reuse). The runner's only additional grant is that custom
role's single `monitoring.timeSeries.list` permission on the dedicated project;
no monitoring viewer/admin, project-IAM administration or new web privileges.
Cloud Monitoring does not scope this read to one service; the observer filters
it to the two owned services. The existing Cloud Shell project-ID approval names
this grant; do not silently update customer IAM outside that handoff.

Under the retained deployment mutex, the runner clears traffic tags (tag-only
revisions are not disabled by scale zero), disables both owned services and
requires fresh explicit zero active **and idle** instance observations for every
previously observed/routed revision. Missing, stale or incomplete observations
are unknown, not zero. A timeout leaves maintenance enabled for inspection.
Then it applies the migration and API-only revisions **still at manual zero**,
verifies latest-created/latest-ready and all actual traffic belong to the new
pinned revision, and only then separately restores autoscaling. Failed checks
never automatically restore old revisions or tags. Manual jobs, independent
controllers/deployers and manual rollback are unsupported while this installer
owns the schema. The fence's real metric emission and disabled-revision readiness
behavior are explicit live-test gates, not certified by mocks.

Updates and retries remove Cloud Run revision tags on the OpenWork services;
recreate any you need afterwards on the new API-only revisions.

Before merging/rollout, the managed-deployments owners must review the grant and
maintenance behavior, and an isolated Den must exercise a published legacy
install → genuinely newer test installer Update → fresh install → destroy.
Use reviewed `--image-pins` if testing a new installer label with existing
application digests; never bypass Den's same-version rejection or publish mocked
registry artifacts.

The runner enrolls using `{"provider":"gcp","idToken":"..."}` with audience
`API_ORIGIN/v1/managed-deployments/DEPLOYMENT/runs/RUN/enroll#CHALLENGE`.
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

No cloud resources have been provisioned or releases published as part of
implementation. Local mocked security/protocol tests and Terraform validation
do not prove a live Cloud Run deployment. Customer-project end-to-end validation
and a real immutable release are rollout gates. Serverless NEG target health
is inapplicable and omitted (the actual HTTPS routes are checked instead).
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
Terraform: `terraform init -backend=false -lockfile=readonly`, `terraform validate`.
