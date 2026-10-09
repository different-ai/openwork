# Managed deployments

A workspace owner installs OpenWork in their own AWS account from hosted
OpenWork, approves it in the AWS console, and then sees its status checks and
available updates in **Manage › Deployments**. Behind the `managedDeployments`
feature (cloud only, off by default). Design and contract:
`infra/managed-deployments/README.md`.

## What the customer needs

- A **dedicated AWS account** (AWS Organizations member account is ideal) and
  someone who can create a CloudFormation stack with IAM resources in it.
- A **public Route 53 hosted zone in that account** containing the address,
  for example `openwork.example.com` in zone `example.com` (or a delegated
  `openwork.example.com` zone). The installer creates `openwork.example.com`,
  `api.openwork.example.com` and their certificates.
- One of the supported regions. Expect roughly $100–150 a month at the small
  size (two Fargate services, `db.t4g.micro` RDS MySQL, an Application Load
  Balancer, one NAT gateway, public IPv4 addresses). AWS bills the customer.
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
- Deleting the installer stack does **not** delete OpenWork, its database or the
  Terraform state. Decommissioning is a manual, customer-run `terraform destroy`
  against the retained state (disable RDS deletion protection first).

## Operator setup

1. Build an installer for an **already published** image version:
   `node infra/managed-deployments/tools/build-release.mjs aws <version> <dir>`
   (or run the **Managed Deployments** workflow with that version).
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

## Limits

- AWS only. The contract, API, data model and UI are provider-neutral; Azure
  and GCP need their bootstrap, identity proof, Terraform root and agent.
- Dedicated-account model: some AWS create/describe APIs used by the runner
  cannot be scoped to resources, so the runner role is scoped to the region and
  resource-name prefixes but should not share an account with other workloads.
- No alert notifications yet: health is shown in OpenWork, not emailed.
- Single NAT gateway and single-AZ database at the small size (cost over HA).
