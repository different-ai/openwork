# Managed deployments

A workspace owner installs OpenWork in their own cloud from hosted OpenWork,
approves it in the provider console or Cloud Shell, and then sees its status
checks and available updates in **Manage › Deployments**. AWS, Google Cloud and
the deployment agent tools share `managedDeployments` (cloud only, off by
default). GCP remains unverified until a real
published release and approved customer-project install pass. Design and contract:
`infra/managed-deployments/README.md`.

## What the customer needs

- An AWS account and someone who can create a CloudFormation stack with IAM
  resources in it. Choose the network when creating the deployment:
  - **New dedicated network** (default): the installer creates a VPC, one NAT
    gateway and an ECS cluster. Use an account that holds nothing else
    (an AWS Organizations member account is ideal).
  - **Existing VPC**: the installer uses your VPC, two or more private subnets
    (in different availability zones, with outbound internet through NAT or a
    transit gateway) for services and the database, two or more public subnets
    for its load balancer, and optionally your ECS cluster. The VPC needs DNS
    resolution and DNS hostnames. Services in a shared cluster are named
    `ow-<id>-den-api` and `ow-<id>-den-web`. The installer checks all of this
    before changing anything and explains what to fix.
- A **public Route 53 hosted zone in that account** containing the address,
  for example `openwork.example.com` in zone `example.com` (or a delegated
  `openwork.example.com` zone). The installer creates `openwork.example.com`,
  `api.openwork.example.com` and their certificates.
- One of the supported regions. Expect roughly $100–150 a month at the small
  size (two Fargate services, `db.t4g.micro` RDS MySQL, an Application Load
  Balancer, one NAT gateway, public IPv4 addresses). AWS bills the customer.
- If the domain (or a parent domain) has CAA records, they must allow
  `amazon.com`, or AWS cannot issue the HTTPS certificate. The installer
  reports this as a certificate failure; fix the record and retry, and the
  retry requests a new certificate.
- Brand-new AWS accounts sometimes start with a CodeBuild build quota of zero.
  If the stack fails with "CodeBuild is not yet available in this new AWS
  account", request the CodeBuild concurrent-build quota increase and retry.

## Customer flow

1. **Create deployment**: name, AWS account ID, region, address, hosted zone ID,
   first administrator email, cost confirmation.
2. **Prepare AWS approval** › **Review and approve in AWS**. The CloudFormation
   console opens prefilled. Review the installer permissions, acknowledge IAM,
   create the stack. Nothing is launched until this approval.
3. OpenWork shows the installer's six steps as they happen (about 15–25
   minutes): installer connected, release verified, account and domain verified,
   infrastructure installed, services started, HTTPS and database verified.
4. **First sign-in**: open `https://<address>/setup` and enter the one-time code
   from the deployment's Secrets Manager secret (`ow-…-den-…`), field
   `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE`. OpenWork never receives this code.
   Configure SMTP and SSO after setup.

## From an agent (MCP)

With `managedDeployments` on for the organization (cloud only, off by
default), agents connected to the OpenWork MCP gateway can drive the same flow
through `search_capabilities` / `execute_capability`:

1. Read readiness (`GET /v1/managed-deployments/configuration`).
2. Record the target (`POST /v1/managed-deployments`) after confirming the
   account or project, address and who is billed.
3. Prepare the launch (`POST /v1/managed-deployments/:id/launch`). The response's
   `handoff` is the one step the person takes in their own cloud: `open_link`
   (AWS install: approve the prefilled CloudFormation stack) or
   `run_in_cloud_shell` (GCP, and AWS retry/update: open the cloud shell link and
   run the verified command). OpenWork never runs it. Calling it again reopens
   the same pending run.
4. Follow progress (`GET /v1/managed-deployments`) and give the person `webUrl`
   once health reads operational.

Agents cannot remove deployment records or call the installer's enrollment,
milestone or health endpoints. The routes keep their permissions
(`deployments.view` / `deployments.manage`) and feature checks; turning
`managedDeployments` off hides the capabilities and blocks new launches without
affecting running installs or authenticated enrollment and health reports.

## Status checks

A read-only Lambda health agent in the customer's account reports every
5 minutes: API, database connection, web app, services running, load balancer
targets, database instance, database storage, backups, and the HTTPS
certificate. The deployment reads **Operational**, **Degraded** (warnings or a
non-critical failure), **Down** (API, web, database connection or services
failing) or **Not reporting** (no report for 16 minutes; the last known checks
stay visible). Reports are authenticated by the agent's AWS role identity and
bound to the exact report body; replays are rejected.

## Updates and recovery (approval required)

- **Update to X** appears when the published installer is newer than the
  running version. **Retry** appears after a failed or stalled run.
- Both produce an account-checked command for AWS CloudShell that updates the
  existing installer stack with the new release. The runner re-plans with the
  retained state, refuses to delete or replace the database, secrets or VPC,
  applies, and re-verifies health. Customers approve every change; there are no
  automatic updates.
- **Shared-module adoption requires a new IAM approval and a maintenance window.**
  Review the generated CloudFormation template with `CAPABILITY_NAMED_IAM`: the
  migration Lambda, its deployment-scoped role and logs are new grants. Existing
  template approval is not sufficient. The runner drains old migration-capable
  tasks before the single migration, keeps existing keys/state-backed secrets,
  and refuses data-bearing replacement. A failed adoption stays in maintenance;
  inspect the migration outcome before retrying. No legacy automatic rollback or
  wildcard task-definition deregistration permission is used. See
  `infra/managed-deployments/README.md` for exact ordering and provider-upgrade risk.
- Deleting the installer stack does **not** delete OpenWork, its database or the
  Terraform state. Decommissioning is a manual, customer-run `terraform destroy`
  against the retained state (disable RDS deletion protection first).

## Operator setup

1. Build an installer for an **already published** image version:
   `node infra/managed-deployments/tools/build-release.mjs aws <version> <dir>`
   (or run the **Managed Deployments** workflow with that version).
   A separately approved isolated test may use a newer installer version plus
   `--image-pins <approved-json-file>` for a registry-verified existing application
   pair. That is a real version-increasing Update, not Retry or a fictitious image
   tag. Never point production Den at those test-only artifacts.
2. Publish from a dedicated release account into a versioned, encrypted S3
   bucket whose `releases/*` objects are publicly readable and nothing else:
   `node infra/managed-deployments/tools/publish-release.mjs <dir> <bucket> <account-id> <region>`.
   It refuses the wrong account and overwrites, and prints URLs pinned to
   immutable object versions.
3. Set on hosted den-api: `DEN_MANAGED_DEPLOYMENT_AWS_VERSION`,
   `DEN_MANAGED_DEPLOYMENT_AWS_TEMPLATE_URL`, `DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_URL`,
   `DEN_MANAGED_DEPLOYMENT_AWS_BUNDLE_SHA256`. `DEN_API_PUBLIC_URL` must be the
   public HTTPS API origin (it receives enrollment, milestones and heartbeats).
4. Turn `managedDeployments` on for an internal organization in `/admin`, then
   roll out. Turning it off blocks new launches and hides the page; running
   installs keep reporting and nothing in customer accounts changes.

## Publication troubleshooting

The Deployments page is not proof of installer publication. A feature rollout
only allows the page/API; it does not produce or publish release artifacts.
The **Managed Deployments** workflow's pull-request runs verify code only.
A manual run builds artifacts for operator review; it deliberately does not
publish them or configure hosted Den.

The configuration API reports `not_configured`, `invalid_configuration`,
`feature_disabled`, or `not_supported`, with missing/invalid **field names**
under Technical details (never configuration values or credentials). The
operator must publish real reviewed artifacts and set all four provider fields
and a public `DEN_API_PUBLIC_URL` origin. GCP URLs must pin GCS object
generations. Local fixture URLs must never be used in a real environment.
`available` means syntactically configured and enabled, not a live cloud
installation; checksum verification and cloud identity checks happen at launch.

A cloud CLI login on the customer's Mac cannot fix server-side publication.
Do not hide the lock, invent a checksum or configure a mutable/latest artifact
to make the page look ready. Publication, hosted configuration, and rollout
changes require explicit operator approval.

## Stable-release currency

The **Managed Stable Installer** workflow prepares a candidate from GitHub's
latest public stable release after release/image-publisher completion, with a
six-hour reconciliation fallback. It does not select `dev`, alpha, draft or
prerelease images, and it does not upgrade customer installations. Candidate
preparation verifies the release tag's commit, exact Linux/amd64 image digests
and OCI source identity, then runs installer and container/bootstrap checks.
These checks are **not** a real-cloud fresh-install or approved-Update receipt.

Production promotion stays an explicit, protected operator action until a real
cloud qualification gate is automated. Qualify the exact retained candidate on
an isolated account, including a fresh install and version-increasing Update,
and retain the manifest SHA-256 and review URL. Dispatch the workflow from the
trusted default branch with `promote=true`, that manifest hash, and the trusted
repository qualification review URL. The URL is the operator's attestation,
not an automated assertion that its contents passed. The dedicated
`managed-installer-production` environment must have nonempty required
reviewers and prevent self-review. The workflow verifies that policy before
assuming the release role or publishing; an absent/unprotected environment
fails closed. Do not assume an existing production environment has reviewers,
or change other deployment environments as part of installer setup.
A newer release or changed candidate invalidates the earlier review.

Before enabling promotion, deploy the atomic configuration reader below and
verify the configuration API from a controlled internal organization. A Render
`live` deploy proves deployment completion, not installer availability: after
promotion, verify that `GET /v1/managed-deployments/configuration` advertises the
reviewed version before handing out new approvals.

AWS promotion requires explicit operator configuration (never infer an account
or create public access as a workaround):

- `MANAGED_DEPLOYMENT_AWS_PROMOTION_ENABLED=true`.
- `MANAGED_DEPLOYMENT_AWS_RELEASE_ROLE_ARN`: a narrowly scoped GitHub OIDC role
  in the release account, trusted only for the repository's
  `managed-installer-production` environment.
- `MANAGED_DEPLOYMENT_AWS_RELEASE_ACCOUNT_ID`,
  `MANAGED_DEPLOYMENT_AWS_RELEASE_BUCKET`, and
  `MANAGED_DEPLOYMENT_AWS_RELEASE_REGION`.
- Existing `RENDER_API_KEY` and `RENDER_DEN_CONTROL_PLANE_SERVICE_ID` secrets.
- Publisher permissions include `s3:ListBucketVersions`, bucket/versioning reads
  and conditional object creation, plus public verification of immutable bytes.
  They do not require bucket-policy changes or object deletion.

GCP remains candidate-only in this workflow. Do not silently enable an
unconfigured provider or substitute GKE/Helm testing for managed Cloud Run
qualification. Existing explicit GCP publication steps below still apply.

### Atomic configuration and safe recovery

Promotion writes **one** non-secret coordinate record on hosted Den:
`DEN_MANAGED_DEPLOYMENT_AWS_RELEASE` (the configuration reader also supports
`DEN_MANAGED_DEPLOYMENT_GCP_RELEASE`). Its value is a JSON object with exactly:

```json
{
  "version": "0.18.65",
  "templateUrl": "https://release-bucket.s3.us-east-1.amazonaws.com/releases/aws/0.18.65/cloudformation.json?versionId=immutable-template-version",
  "bundleUrl": "https://release-bucket.s3.us-east-1.amazonaws.com/releases/aws/0.18.65/bundle.tar.gz?versionId=immutable-bundle-version",
  "bundleSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

This is a schema example, **not published artifacts**. Use only the publisher's
verified coordinates and hash. AWS uses regional S3 object-version URLs; GCP
uses exact GCS generation URLs. The control-plane origin still comes only from
`DEN_API_PUBLIC_URL`; the coordinate record cannot override it.

When the record is absent, the four legacy provider fields remain supported.
When present but invalid, Den fails closed: it never silently revives an older
legacy pin. Production promotion changes only this selected record and requests
one Den deploy; it never bulk-rewrites unrelated environment values. Workflow
writers share the `den-api-env` concurrency lock and re-read the selected key
before writing. Render has no server-side compare-and-swap: dashboard/external
API writers must respect that operational lock too.

An old/out-of-order candidate cannot downgrade the advertised release. The
same version with different bytes or coordinates is refused. Re-running a
partial publication reuses only identical, publicly verified immutable object
versions; conflicting bytes fail before uploads. If an installer fix changes
an already-published version, publish a new reviewed version rather than
replace its objects. Deterministic archives require Python 3 alongside the
registry tooling.

On ambiguous publication/configuration/deploy failure, inspect the actual
objects, selected record and deploy receipt before retrying. No automatic
rollback or uncertain mutation replay is performed. Disable the promotion
opt-in to pause future operator promotions; the existing `managedDeployments`
kill switch blocks launches while authenticated enrollment and health reporting
continue. An operator may deliberately restore a prior coordinate record after
review, but that affects new approvals only—it never rolls back a customer's
database. Pending approval runs retain their frozen coordinates.

Automatic **preparation** does not yet mean zero-touch production promotion.
After merging, configure credentials and complete real-cloud qualification
before claiming that the live managed installer follows the latest release.
The proposal to automate qualification and promotion, and to let customers
update with one click, is in `docs/plans/managed-deployment-one-click-updates.md`.

## Google Cloud (GCP)

The managed installer uses the shared Cloud Run module with explicit legacy
naming and state-backed secrets. Existing and fresh managed installs stay on
**MySQL 8.0**; the direct module default remains 8.4. No major database upgrade or
secret rotation is part of adoption. The October 21 isolated Den Update passed
on head `26fdbbf2bf`, including the Google provider 6→8 transition and data,
secret and sign-in preservation for its frozen image set. This historical run
used a dev-built legacy baseline, not a published stable installer. It does not
qualify newer application images.

**Updates require customer re-approval and a maintenance window.** Bootstrap adds
one deployment-specific custom role containing only `monitoring.timeSeries.list`
(the approving administrator needs custom-role creation permission). The runner
clears traffic tags, disables and observes the drain of only the two owned
services, runs one native migration, prepares API-only revisions while disabled,
then verifies actual latest-ready traffic before separately restoring autoscaling.
This causes a short outage on every update while services are scaled to zero,
including during migration. Previously old code kept serving during migration.
Fence/readiness CLI calls and drain-token minting each have a 30-second timeout.
Missing/stale drain evidence, a command timeout or failed/unknown migration
blocks progress without automatically resuming services or replaying the command.
Inspect partial outcomes before retrying. A pre-resume failure retains maintenance,
but a later health failure can happen after traffic resumes. Revision tags are
removed and must be recreated on the new revisions if needed.
The managed-deployments owners must still accept this behavior before merge or
publication. Before publishing newer application images, qualify that exact
image set with a live upgrade. Use a genuinely newer isolated test installer for
Den Update; same-version protection stays unchanged.

Use a dedicated billing-enabled project, a supported region, and an already
public authoritative Cloud DNS zone for the chosen address. The form requires
both project ID and number, zone name, domain, first administrator email, and
cost/permission consent. IAM permissions are project-wide in this initial
profile; do not use a shared production project. See
`infra/managed-deployments/gcp/README.md` for permissions and policy limits.

1. Build a local reviewed installer for an exact published image version:
   `node infra/managed-deployments/tools/build-release.mjs gcp <version> <dir>`.
   Docker registry inspection resolves and verifies unique Linux/amd64 manifest
   digests at operator build time. The checksummed bundle records fixed image
   repositories and digests; customer runs reject missing pins and never pull
   source version tags. The builder needs registry access, not a Docker daemon.
2. After explicit publication approval, publish into an existing dedicated,
   versioned, publicly readable release bucket:
   `node infra/managed-deployments/tools/publish-gcp-release.mjs <dir> <bucket> <release-project-id> <release-project-number>`.
   It checks project/bucket identity, refuses object overwrites, pins generations,
   and verifies unauthenticated downloads and hashes before printing configuration.
   It does not create a bucket or change IAM/public-access policy. This initial
   publisher requires an unconditional `allUsers` → `roles/storage.objectViewer`
   bucket policy; conditional policies and per-object ACLs fail closed. Failed
   multi-object publication can leave partial uploaded objects, but prints no
   ready configuration and never deletes or changes cloud resources.
3. Set `DEN_MANAGED_DEPLOYMENT_GCP_VERSION`,
   `DEN_MANAGED_DEPLOYMENT_GCP_TEMPLATE_URL` (the pinned tutorial),
   `DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_URL`, and
   `DEN_MANAGED_DEPLOYMENT_GCP_BUNDLE_SHA256` on hosted Den. The control plane
   must have a publicly reachable HTTPS origin.
4. Only after live rollout gates pass, opt an internal organization into both
   features through `/admin`. Turning GCP off blocks create/launch but keeps
   existing records and authenticated reports; it never removes cloud resources.
5. Create a deployment and prepare approval. Review the generated command,
   open Google Cloud Shell, and run it there. The command verifies the pinned
   bundle before extraction/execution. The installer checks project number and
   DNS, asks for the exact project ID as approval, and prompts for Google ADC
   consent. It never asks for service-account keys.
6. Terraform runs as the deployment runner identity with customer-owned,
   private, versioned GCS state. Cloud SQL backups/deletion protection and plan
   checks protect data-bearing resources. Updates/retries require another
   explicit approved command; no automatic update or teardown exists.
7. Open `https://<address>/setup` and retrieve
   `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE` from the deployment's Secret Manager
   secret. OpenWork never receives it. Cloud Run logs contain installer/service
   diagnostics; the read-only health job posts allowlisted checks every five
   minutes with a Google-signed, exact-body-bound ID token. Old reports remain
   visible when reporting stops; unknown checks are not shown as successful.

Expected costs include Cloud Run, Cloud SQL, global HTTPS load balancer,
Artifact Registry, DNS, Scheduler and storage; review current Google pricing
rather than reusing AWS estimates. No live project has been installed by these
local tests. Gateway/automations are disabled in the initial GCP profile.

## Limits

- Azure remains unsupported. GCP code and offline validation do not prove a
  live deployment or publication; those are required before rollout.
- Shared accounts (existing VPC): the runner may only create security groups
  in the chosen VPC and change groups tagged with its deployment, services
  named with its prefix in the chosen cluster, and its own load balancer,
  database, secrets, roles and logs. A few AWS create calls cannot be scoped
  (registering task definitions, requesting certificates, Cloud Map
  namespaces); they create new resources and cannot change existing ones.
- The existing-VPC option still creates its own internet-facing load balancer;
  attaching to a shared load balancer is not offered yet.
- No alert notifications yet: health is shown in OpenWork, not emailed.
- Single NAT gateway and single-AZ database at the small size (cost over HA).
