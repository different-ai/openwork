# Managed AWS deployments: backend draft

Status: backend foundation only. This branch does not yet create AWS resources.
The feature must remain off until the UI, customer-side runner, release artifacts,
and end-to-end AWS validation are implemented.

## Current scope

Hosted Den can register an organization-owned deployment, mint an initial launch
run, prepare a CloudFormation quick-create URL, verify the AWS runner identity,
and accept a bounded progress stream. Runs and events are durable MySQL rows.

`awsManagedDeployments` is cloud-only and defaults off. Owners and super-admins
with a fresh privileged session can create and launch; admins can read.
Disabling the feature blocks new launches but permits existing, unexpired runs
to finish reporting. No automatic upgrade or deletion action exists.

A launch is a request, not evidence that AWS resources exist. Ready requires all
six milestones in order. Only an enrolled runner may submit milestones. The
future runner must perform the actual service and HTTP health checks before
reporting the final milestone; Den does not independently verify those checks.

## Operator configuration

These settings describe a reviewed, published release; they do not enable the
feature. Missing or invalid configuration makes creation and launch unavailable.

- `DEN_AWS_DEPLOYMENT_TEMPLATE_URL`: HTTPS CloudFormation template URL.
- `DEN_AWS_DEPLOYMENT_BUNDLE_URL`: HTTPS URL of the pinned runner/Terraform bundle.
- `DEN_AWS_DEPLOYMENT_BUNDLE_SHA256`: expected 64-character SHA-256 checksum.
- `DEN_AWS_DEPLOYMENT_VERSION`: version pinned by the Terraform bundle.
- `DEN_API_PUBLIC_URL`: HTTPS hosted Den origin receiving runner enrollment.

Do not configure these until the template and bundle are actually published.
Template publishing, artifact signing, checksum verification by the runner,
and the customer's consent to AWS costs are not implemented by this draft.

## Runner protocol

The launch URL includes a public, random run challenge, not an AWS credential or
Den bearer token. The runner signs an STS `GetCallerIdentity` POST with temporary
AWS role credentials. Its `x-openwork-run` header must equal `<runId>:<challenge>`
and must be covered by SigV4 alongside content type, host, date and session token.

Den replays only the fixed POST to the deployment's allowlisted regional STS
endpoint, refuses redirects, checks signature freshness, and verifies the AWS
account plus the exact deployment-specific runner role. Enrollment is single-use
and issues a run-scoped token whose hash alone is stored. The run expires after
two hours. A lost enrollment response requires a new run after expiration; no
credential recovery protocol is implemented yet.

Events contain only an ordered step, success/failure, and an allowlisted error
code. Logs, Terraform output, bootstrap codes and arbitrary error text cannot
be uploaded through this endpoint. Exact event repeats are idempotent; changed
or out-of-order repeats are rejected. Detailed logs should stay in CloudWatch.

## Work required before rollout

1. CloudFormation template creating a restricted CodeBuild runner role/project
   and a customer-owned, encrypted Terraform state backend.
2. Signed, versioned runner bundle; dedicated-account VPC wrapper around
   `infra/terraform/modules/openwork-aws-ecs`; pinned tool/provider versions.
3. Real runner: temporary identity proof, checksum verification, Terraform
   plan/apply, ECS stabilization and HTTPS health probes, sanitized events.
4. Hosted Den list/create/run screens with explicit AWS account, permissions,
   cost consent and AWS-console approval. No root email or AWS key collection.
5. Live tests for install, failed apply, safe retry, existing-stack recovery,
   credential replay, cross-organization access and feature shutdown.
6. Approved upgrades with plan review, backups and migration compatibility;
   ongoing health heartbeats and pre-expiry warnings.

Current tests exercise validation, ordered milestones, launch URL pinning,
STS endpoint constraints, identity mismatch and replay-window rejection. They
use stubbed STS responses, not AWS. No UI or deployed-install proof exists yet.
