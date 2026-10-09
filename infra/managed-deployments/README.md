# Managed deployments: customer-cloud installers

OpenWork installed in a customer's own cloud account, launched and monitored
from hosted OpenWork. AWS is implemented; the layout is designed so Azure and
GCP plug in without changing the lifecycle, the API or the UI.

```
contract/            Provider-neutral Terraform contract (inputs, naming, outputs)
aws/
  bootstrap/         CloudFormation the customer approves: runner + state only
  runner/            Installer run inside the customer's account (CodeBuild)
  health/            Read-only health agent (Lambda) reporting to OpenWork
  terraform/         AWS root: contract + network + platform + health agent
    modules/network/       AWS "network" building block
    modules/health-agent/  AWS "health agent" building block
tools/               Release build and publication (provider argument)
tests/               Installer, runner and health agent tests
```

The platform building block for AWS is the existing
`infra/terraform/modules/openwork-aws-ecs` module, so a managed install and a
hand-run Terraform install deploy the same thing.

## The contract every cloud implements

1. **Bootstrap** the customer approves in their own console. It creates only an
   installer identity, a runner and encrypted, retained Terraform state. AWS:
   CloudFormation quick-create. Azure: a "Deploy to Azure" ARM/Bicep template.
   GCP: Infrastructure Manager or a Cloud Shell tutorial.
2. **Runner** that enrolls with a cloud identity proof, verifies the release
   checksum, runs `terraform plan` + `apply` against the cloud root, refuses to
   delete data-bearing resources, verifies services and HTTPS health, and reports
   the six milestones (`runner_connected` … `health_verified`).
3. **Terraform root** that calls `contract/` with the neutral inputs
   (`deployment_id`, `domain_name`, `owner_email`, `openwork_version`,
   `control_plane_origin`, `size`), adds its own cloud inputs, and returns the
   neutral outputs (`web_url`, `api_url`, `setup_url`, `health_agent`). It
   composes the same building blocks: network, platform (containers, database,
   load balancer, certificate, DNS, secrets) and health agent.
4. **Health agent** that runs every 5 minutes with read-only permissions and
   posts the same allowlisted report (`packages/managed-deployments/src/schema.ts`,
   `healthReportSchema`) to `/v1/managed-deployments/:id/heartbeat`.
5. **Identity proof** the control plane can verify without stored secrets:
   AWS replays a signed STS `GetCallerIdentity`; Azure would verify a managed
   identity token and GCP a service-account ID token against their issuers.

Cloud-specific values (AWS account and Route 53 zone; later Azure subscription
or GCP project) live in the deployment's `target`, never in the contract.

## Security model

- Dedicated cloud account per deployment. No customer cloud keys are stored by
  OpenWork and no inbound access is needed: the runner and the agent call out.
- Release bundles and the Terraform binary are verified by SHA-256 before
  execution; published files are referenced by immutable S3 object versions.
  Terraform and provider versions are pinned with a committed lock file.
- State is customer-owned: versioned, encrypted S3 with S3-native locking,
  retained if the bootstrap stack is deleted.
- The runner role has no delete permissions except Terraform's own lock file and
  superseded ECS task definitions. Plans that delete or replace databases,
  secrets, storage or the VPC are refused.
- Health reports contain only check ids, states, numbers and codes. No logs,
  hostnames, secrets or customer data leave the account.

## Run the checks

```bash
(cd contract && terraform init -backend=false && terraform test)
(cd aws/terraform && terraform init -backend=false -lockfile=readonly && terraform validate && terraform test)
node aws/bootstrap/template.mjs            # regenerates aws/bootstrap/cloudformation.json
python3 -m unittest discover -s tests       # needs boto3
```

Release and operator steps: `docs/managed-deployments.md`.
