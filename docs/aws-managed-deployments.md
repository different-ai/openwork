# Managed AWS deployments

## Scope and extraction boundary

`packages/aws-deployments` owns the shared schemas, ordered progress protocol,
account/role-bound STS verification, and CloudFormation launch parameters. It
imports only Zod, the XML parser and Node crypto: no Den database, Hono,
organization, feature registry or UI code. This is the extractable library.

`infra/aws-managed` contains the customer-side adapter: CloudFormation bootstrap,
CodeBuild runner, verified release bundler, publication CLI and Terraform root.
It communicates through the HTTP protocol, not Den internals. Its Terraform
root reuses the OpenWork ECS module, which is the product-specific dependency.

Den supplies the host adapter: organization ownership, permissions, durable
MySQL storage, audit attribution, feature rollout and screens. A full extraction
would move those persistence and UI adapters into another host; it would not
need to move the rest of Den or copy the runner. The cloud-provider adapter is
AWS-specific; this does not claim Azure or GCP support.

## Customer flow

1. In hosted Den, open Settings > AWS deployments and create a deployment.
2. Enter a dedicated AWS account, supported region, deployment domain, public
   Route 53 hosted zone in that account, and first-administrator email.
3. Confirm AWS billing and permission review. Prepare the AWS launch, then
   explicitly open the AWS approval link. Nothing launches on page render.
4. Review the CloudFormation template and named IAM permissions in AWS. Create
   the stack. The customer-owned CodeBuild runner provisions ECS, private RDS,
   an HTTPS load balancer, private task subnets, and a NAT gateway.
5. Den reports six verified installation milestones. The final milestone
   requires ECS stabilization, public HTTPS API health, database readiness,
   and the web setup page. A launch request is never treated as a success.
6. Open the deployment's `/setup` page. Retrieve the one-time administrator
   code from the customer-owned Secrets Manager secret's
   `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE` field. That code never reaches hosted Den.

The hosted zone must be publicly delegated and contain the requested domain.
Custom networking, private-only load balancers and air-gapped installation are
not part of this guided flow; use the existing Terraform/Helm paths for those.
The initial setup deliberately turns email verification off: configure SMTP
and the customer's SSO policy after the owner signs in.

## Security and lifecycle

`awsManagedDeployments` is cloud-only and defaults off. Owners and super-admins
with a fresh privileged session can create/launch; admins can read. Disabling
it blocks new launches while existing, bounded runs can finish reporting.

The bootstrap uses a customer-owned CodeBuild role, not stored AWS access keys
or an inbound network connection. Its IAM policy enumerates infrastructure
operations, scopes DNS changes to the supplied hosted zone and role/secret
access to the deployment prefix, restricts PassRole to ECS tasks and the managed
execution policy, and limits regional operations to the selected region.
Some AWS create/describe APIs require wildcard resources. Use a dedicated
account; do not treat this role as permission to administer unrelated workloads.

Enrollment replays only a signed `GetCallerIdentity` POST to the fixed regional
STS endpoint. It binds the account, exact runner role, freshness window and
signed run challenge. Single-use enrollment issues a two-hour run token whose
hash alone is stored. Events contain only ordered milestones and allowlisted
error codes; arbitrary logs and secrets are rejected. Detailed logs remain in
CloudWatch. A lost enrollment response requires a new run after expiration;
there is no credential recovery bypass.

Release bundle and Terraform binary checksums are verified before execution.
Terraform/provider versions and platform checksums are pinned. Plans containing
resource deletions are refused by the installer. RDS backups and deletion
protection default on. Encrypted, versioned Terraform state and its lock table
are retained in the customer account even if the bootstrap stack is removed.
Deleting the bootstrap is not an application uninstall.

## Operator release setup

1. Build the installer for an **already published image version**:
   `node infra/aws-managed/build-release.mjs <version> <output-directory>`.
   The GitHub `Build AWS Deployment Installer` workflow performs the same build.
2. Use a dedicated release account and a versioned S3 bucket. Grant public
   GetObject/GetObjectVersion only on `releases/*`; put no customer state or
   credentials in that bucket. Enable encryption and block public ACLs.
3. Publish using that account's credential chain:
   `node infra/aws-managed/publish-release.mjs <output-directory> <bucket> <account-id> <region>`.
   The script verifies the account and refuses overwrites. Output URLs pin
   immutable S3 object version IDs, not mutable latest paths.
4. Configure hosted Den from the publication output:
   `DEN_AWS_DEPLOYMENT_VERSION`, `DEN_AWS_DEPLOYMENT_TEMPLATE_URL`,
   `DEN_AWS_DEPLOYMENT_BUNDLE_URL`, `DEN_AWS_DEPLOYMENT_BUNDLE_SHA256`.
   `DEN_API_PUBLIC_URL` must be the reachable HTTPS hosted API origin.
5. Roll out through `/admin`, first to an internal organization. Unconfigured
   operators get a blocked UI, not a broken or synthetic launch.

## Validation and remaining limits

Protocol unit tests exercise identity mismatch, signature freshness, input
bounds and milestone order. Installer tests exercise checksum-first extraction,
archive traversal rejection, HTTPS constraints and retained/private state.
The E2E journey exercises the real Den UI, consent, durable launch records,
reload recovery and role/workspace isolation without launching paid resources.
Live AWS validation is separate and must be explicitly approved and cleaned up.

This version is an initial-install path, not a completed fleet-operations
product. Continuous health heartbeats, scheduled/automatic updates, approved
upgrade plans and automatic cleanup are not implemented. The UI shows the last
installation report, not a claim of current health. A ready installation cannot
be relaunched through the initial-install endpoint.
