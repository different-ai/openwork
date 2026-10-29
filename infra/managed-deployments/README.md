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
pair, build with `--image-pins <approved-json-file>` containing exactly `den_api`
and `den_web` fixed-repository Linux/amd64 digests. The builder re-verifies both
images through the registry. The release stores those pins; the runner passes
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
