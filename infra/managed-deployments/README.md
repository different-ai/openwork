# Managed deployments: customer-cloud installers

OpenWork installed in a customer's own cloud account, launched and monitored
from hosted OpenWork. AWS uses CloudFormation/CodeBuild; GCP adds a
customer-approved Cloud Shell installer and Cloud Run platform behind the
default-off `managedDeployments` rollout, shared with AWS and the deployment
agent tools. Azure remains unsupported.
GCP offline validation is not a live-install or publication receipt; do not
roll it out before those gates pass.

```
contract/            Provider-neutral Terraform contract (inputs, naming, outputs)
aws/
  bootstrap/         CloudFormation the customer approves: runner + state only
  runner/            Installer run inside the customer's account (CodeBuild)
  health/            Read-only health agent (Lambda) reporting to OpenWork
  terraform/         AWS root: contract + network + shared platform + health agent
    modules/network/       AWS network building block
    modules/health-agent/  AWS health agent building block
gcp/
  bootstrap/         Customer approval tutorial (immutable GCS artifact)
  runner/            Cloud Shell bootstrap and impersonated Terraform runner
  health/            Read-only Cloud Run health job
  terraform/         Cloud Run, Cloud SQL, HTTPS load balancer, DNS and secrets
  README.md          GCP permission, identity, state and rollout gates
tools/               Release build and publication (provider argument)
tests/               Installer, runner and health agent tests
```

## Optional AI Gateway module support

AWS and Google Cloud roots consume the native Terraform modules **directly**, not
Helm. The modules' new `ai_gateway_*` inputs are documented in
[the AI Gateway guide](../terraform/AI_GATEWAY.md); these managed roots do not set
them, so the AI Gateway remains **off**. This does not change installer payload
publication, bootstrap permissions, managed defaults or rollout state. Enabling a
managed install needs a separately reviewed root/image/DNS/certificate/permission
change, required re-approval and fresh live install/upgrade proof. Mock module
plans are not a managed-readiness receipt. The AI Gateway is distinct from
OpenWork Web's den-gateway and Den API's MCP gateway.

## AWS shared-module adoption

The AWS root consumes `infra/terraform/modules/openwork-aws-ecs`. The former
operational frozen copy is removed. The release includes the shared module's
operational Terraform files **and `migration.py`**, byte-checked against the
source; module-local file references must resolve inside the payload allowlist.
Tests/examples/state/plans/credentials are never release payloads.

### Approval and maintenance window

**Existing customers must approve the new CloudFormation template with
`CAPABILITY_NAMED_IAM` through Den's generated Update handoff before adoption.**
Review the changed permissions: the runner may create/update/invoke only this
deployment's migration Lambda, manage its narrowly named role and log group,
and pass that role only to Lambda. The Lambda can start only the owned migration
family in the chosen cluster and pass only the two ECS roles. No administrator
policy or `ecs:DeregisterTaskDefinition` on `*` is added. A prior template approval
is not approval for these additional resources.

The first adoption deliberately has downtime. Before Terraform can invoke its
single migration step, the runner reads installed service state and **live
primary and rollback task definitions**. If any is migration-capable, it disables
rollback and scales only the two owned services to zero. It waits for zero
service counts AND actual STOPPED task status, including pending/draining tasks
in those task families. Unknown state, a resumed service or timeout fails closed.
It does not stop unrelated tasks in a shared cluster. Exclusive installer/schema
ownership is required; do not run manual legacy tasks or another Terraform
coordinator during maintenance.

After draining, the runner refreshes/replans and checks protected resources again.
This records desired-count restoration, so only the new migration-gated API-only
rollout can end maintenance. Failed migration/apply leaves maintenance in place;
inspect the actual migration task before a deliberate retry. Never restore a
legacy migration-capable revision automatically or rotate DB credentials as a
fencing shortcut.

### TLS ordering, secrets and retained revisions

The shared module owns the portable safety primitives:

1. All new API, web and standalone migration definitions include CA setup and a
   credential-free strict-TLS configuration check **before Node starts**.
2. In managed compatibility mode, CA-capable definitions precede strict
   SecretVersion promotion. Unlike the former online CA-only phase, the first
   adoption has already stopped old tasks; no new application replica is started
   before migration. Managed API/web rollback is disabled, so a historical no-CA
   revision cannot restart against a strict URL on an automatic failed rollout.
3. The native Lambda invocation runs one strict-TLS migration task and requires
   explicit exit zero with the intended image before API/web services roll out.
4. After apply, the runner forces both intended strict revisions and requires a
   single COMPLETED primary deployment on each, not just healthy old replicas.
   Failed waits fail the run; this is not an atomic multi-service transaction.

Managed installs explicitly set **`write_only_secrets=false` and
`managed_legacy_secrets=true`**, for existing and new managed deployments. Direct
users still default to write-only. There is no automatic mode conversion or key
rotation. The old `app` seed version is preserved; the existing strict `tls`
version moves to `tls[0]` without recreating it or demoting AWSCURRENT. Fresh
managed installs create the legacy seed first, but no client consumes its accept
URL: the strict current version precedes the migrator and services. The runner's
exception permits only known, exact accept-to-strict promotion with every other
secret/credential unchanged; unknowns and protected deletes/replacements fail
closed. Existing encrypted state history remains customer-owned, not purged.

Changing the module's **source directory does not change `module.platform`**.
RDS, secret parents, ALB and cluster keep their addresses/physical identities.
Native moves preserve unindexed legacy random-password values and the strict
SecretVersion. Old `api`/`web` definition addresses are forgotten without destroy;
retained `api_ca`/`web_ca` move to stable `api_v1`/`web_v1`. New core definitions,
including `migrate_v1`, use `skip_destroy=true` from creation. The installer never
deregisters retained revisions. Historical pre-TLS/migrating revisions may remain
ACTIVE: **never start them manually**. Decommissioning must inventory and remove
owned retained definitions only after services are destroyed.

The executable managed root upgrades AWS **5.100.0 to 6.69.1** and random
**3.7.2 to 3.9.1**, with committed Linux/macOS lock checksums; archive remains
2.8.1 and HTTP 3.6.2. Provider state normalization/ForceNew is an upgrade risk:
the protected plan guard must refuse any data-bearing replacement. Synthetic
native state tests verify address/value preservation, not a real v5-state/v6
provider upgrade. That requires the separate live Update proof.

### New-version Update and test handoff

Den intentionally rejects same-version Update; Retry is not Update. For an
isolated test-only newer installer version using a verified existing application
pair, build with `--image-pins <approved-json-file>` containing `den_api`
and `den_web` fixed-repository Linux/amd64 digests (plus both assistant images
when opting into the profile below). The builder re-verifies every supplied
image through the registry. The release stores those pins; the runner passes
them to the shared module rather than inventing a tag for the test version.
Ordinary known release versions retain their built-in immutable image pair.
No production publication or hosted configuration change is part of offline work.

The later authorized harness must use an isolated Den: published baseline ->
new-version **real Update** and IAM re-approval -> preserved DB/data/session/core
secret fingerprints, one migration and API-only replicas -> fresh install ->
destroy and independent absence verification. Record actual immutable artifact
hashes, version and image identities. A local/mock pass is not that live receipt.

`tls_task_revision` remains an optional non-secret root input, empty by default;
it feeds `OPENWORK_MANAGED_TASK_REVISION`. For a controlled second-update fixture,
copy `tests/second-update_override.tf` into `aws/terraform/` before ordinary build.
Never ship that fixture in production or use administrator ECS mutation as proof.

## Optional AWS assistants (qualification required)

The managed AWS root can opt into the shared module's single headless runner,
Workbot at `https://chat.<domain_name>`, Slack assistant and Freestyle computers.
All are **off by default**. Existing core-only installations and release image
pairs remain supported. GCP does not receive these options. The hosted creation
and approved-Update controls additionally require `managedDeploymentAssistants`
(cloud only, off), as well as `managedDeployments`. Turning either flag off blocks
new approvals, not running services or authenticated health reports.

The installer supports the module-managed runner, not its `external_url` fleet
mode. Workbot, Slack and computers require that runner. Configure a direct model
ID, HTTPS endpoint and `anthropic`, `openai` or `openai-responses` protocol. There
is **no AI Gateway** in this path. Freestyle is the installer's only opt-in
computer provider in this profile; direct-module Daytona support is unchanged.
**Freestyle computers execute in Freestyle's cloud, outside the customer's AWS
account.** Enabling the Slack assistant does not create or configure a Slack app:
the customer still creates the app in the installed Den's connector settings.

### Customer-owned key references

Before approval, the customer creates two plain-string Secrets Manager secrets
in the target account and region: the direct model API key, and (only when using
Freestyle) the Freestyle API key. Supply their full secret ARNs, never the values.
Use AWS's console or a customer-controlled secret provisioning process; never put
keys in shell history, URLs, Den, CloudFormation parameters or installer logs.
This profile supports the default Secrets Manager AWS-managed encryption key;
a customer-managed KMS key requires a separately reviewed key policy/grant.

Hosted Den stores only these references. The installer validates account/region,
passes `headless_model_secret_arn` / `headless_computer_secret_arn` through the
managed root, and ECS injects them directly into the runner. Terraform and the
installer do not read their values or copy them into state. The module's existing
generated runner/Workbot credentials remain state-backed, as do managed core
secrets; protect encrypted customer-owned state and its retained history. Keep
customer key secrets through updates. Updating a key's current version requires
an approved task rollout before an ECS task consumes it; key rotation is not an
automatic installer action.

### Images, approval and update behaviour

Build AWS assistant releases with `--include-assistants`, or pass
`--image-pins <approved-json-file>` containing all four fixed-repository
Linux/amd64 digest pins: `den_api`, `den_web`, `headless_runner`, `workbot`.
Core-only image pin files remain valid when assistants are off. Partial optional
inventories, mutable image tags and enabling assistants with a core-only release
are refused. GCP retains its existing core pair plus health image inventory.

**Re-approve the regenerated CloudFormation template before enabling or updating
these services.** The additional grants cover deployment-scoped EFS, runner
secrets, AWS Backup, the backup role, and the existing ECS/ALB/Service Connect
resources. Use Den's version-increasing Update handoff: review IAM with
`CAPABILITY_NAMED_IAM`, update the installer stack, and only then let its CodeBuild
run plan/apply. Never run the expanded Terraform payload using an old approved
role. Do not weaken the protected-resource guard or bypass it with administrator
Terraform. Removing the runner disk, secrets or backup protection is refused.

There is one runner task and one SQLite database on encrypted EFS at `/var/data`.
**Every runner task-definition rollout stops the old task before starting the new
one** (`minimum_healthy_percent=0`, `maximum_percent=100`). There is no turn-drain
protocol in this change. Running Workbot/Slack turns and headless Automations may
be interrupted; callers must inspect their actual outcome before deliberately
retrying any tool action. Chat and headless execution are unavailable until the
replacement runner is ready. Plan a maintenance window, stop sending new turns
and let known active runs finish before approving an update. The installer does
not force an additional runner restart during the core Den strict-TLS redeploy.

Enabling Workbot on an existing install expands the ACM certificate with
`chat.<domain_name>`. The module validates the replacement certificate before
switching the HTTPS listener, then retires the old certificate. An already-issued
certificate is not sent through the failed-certificate retry replacement path.
The saved-plan guard continues to protect data-bearing resources. This ordering
must still be observed on a real managed Update; a native/mock plan is not an
outage-free certificate-rotation receipt.

### Conversation disk protection and health

A managed runner opts into daily AWS Backup of its EFS file system with seven-day
retention, an encrypted deployment-specific vault and a narrowly scoped backup
role. This adds cost. Recovery points are retained rather than force-deleted.
Backups are filesystem recovery points, not a claimed application-consistent
SQLite export or a tested restore procedure. Restore to a separate file system
and validate the SQLite database, conversation history and files before any
manual recovery; restoration is not automated by the installer.

Optional content-free checks cover runner service counts, Workbot HTTPS, EFS
availability/encryption/stored-byte count and the newest completed EFS recovery
point. No conversation content, file names, keys or logs leave the account. A new
vault without a completed recovery point is not reported as backed up; unavailable
or denied reads are unknown, never success. EFS has elastic capacity: its byte
count is usage, not a claim about free disk space.

### Live proof gate

No offline test, build, native Terraform test or plan qualifies this profile for
production publication. Qualify one **test account and isolated test release
bucket/channel**, never an existing customer install or production release
coordinates. Retain exact source and artifact/image identities and independent
observations for:

1. A baseline managed install without Workbot, followed by a newer approved
   release enabling it (including IAM re-approval and certificate handover).
2. Workbot answers a chat, the installed Slack assistant replies in a real thread,
   a real Automation completes headlessly, and a Freestyle command completes from
   a Workbot conversation.
3. A further version-increasing approved Update preserves conversations, core
   secret fingerprints and all four behaviours.
4. Saved, redacted evidence followed by destroy and an independent absence
   inventory, including retained state, recovery points and soft-deleted assets.

Until those observations exist for the candidate under review, the live verdict
is **NotRun / unqualified**, not ready. Production installer promotion and hosted
configuration are separate operator actions and are not part of this change.

## The contract every cloud implements

1. **Bootstrap** the customer approves in their own console. It creates only an
   installer identity, a runner and encrypted, retained Terraform state. AWS:
   CloudFormation quick-create. Azure: a "Deploy to Azure" ARM/Bicep template.
   GCP: Infrastructure Manager or a Cloud Shell tutorial.
2. **Runner** that enrolls with a cloud identity proof, verifies the release
   checksum, runs `terraform plan` + `apply` against the cloud root, refuses to
   delete data-bearing resources, verifies services and HTTPS health, and reports
   the six milestones (`runner_connected` … `health_verified`).
3. **Terraform root** that calls `contract/` with neutral inputs and returns
   `web_url`, `api_url`, `setup_url`, `health_agent`. It composes network,
   platform and health-agent building blocks.
4. **Health agent** that runs every 5 minutes with read-only permissions and
   posts the same allowlisted report to `/v1/managed-deployments/:id/heartbeat`.
5. **Identity proof** the control plane can verify without stored secrets:
   AWS replays a signed STS `GetCallerIdentity`; GCP verifies a service-account
   ID token with exact audience and identity.

Cloud-specific target/account/network values never enter the neutral contract.
Both clouds use ordered milestones, allowlisted reports and customer-approved
updates. Reports keep working when a feature is killed; launches fail closed.

## Security model

- Dedicated account by default, or a validated existing network/cluster; only
  deployment-owned resources are mutable. No customer keys are stored by OpenWork.
- Release bundles and Terraform are SHA-256 verified before execution. Published
  files use immutable object versions; providers use the committed root lock.
- Customer state is encrypted, versioned, S3-native locked and retained when the
  bootstrap stack is deleted. Managed state still contains legacy secret values.
- Only the stack's CodeBuild project may assume its runner role. The launcher
  cannot override buildspec/image/privilege; the runner cannot create/start builds.
- Data-bearing deletes/replacements are refused, with only the exact TLS version
  transition above allowed. No destructive rollout or administrator workaround.
- Health reports contain only allowlisted check ids, states, counts and codes.
  No credentials, logs or customer data leave the account.

## Run the checks

```bash
(cd contract && terraform init -backend=false && terraform test)
(cd aws/terraform && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test)
(cd gcp/terraform && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test)
node aws/bootstrap/template.mjs
python3 -m unittest discover -s tests       # boto3/botocore 1.43.110
node --test tests/build-release.test.mjs tests/test_publish_*_release.mjs
```

Release and operator steps: `docs/managed-deployments.md`.
