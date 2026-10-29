# openwork-aws-ecs (Terraform)

Shared by **direct Terraform users** and the managed AWS installer. Both use
one migration step and API-only replicas. Managed installs explicitly retain
legacy state-backed secrets and use a runner maintenance fence; direct installs
still default to write-only. See the managed installer README for approval and
upgrade boundaries.

## What it deploys

Runs a private, single-organization OpenWork control plane (Den) on AWS
**ECS Fargate**, without Kubernetes:

| Piece | AWS resource |
| --- | --- |
| ECS cluster | `<name>-den`, or your existing cluster (`ecs_cluster_arn`) |
| Den API (`ghcr.io/different-ai/openwork-den-api`, port 8788) | Fargate service, registered in Cloud Map |
| Den web (`ghcr.io/different-ai/openwork-den-web`, port 3005) | Fargate service |
| Database migrations | One standalone Fargate task, synchronously observed by a Lambda invocation; terminal exit 0 gates API and web rollout |
| MySQL 8.4 | RDS, encrypted, private (or bring your own `database_url`) |
| Cache (optional) | ElastiCache Redis with TLS (`create_redis = true`) |
| HTTPS | ALB: `domain_name` → den-web, `api.<domain_name>` → den-api, HTTP redirects (or your existing ALB / listener) |
| Certificate | Your ACM ARN, or created and DNS-validated in a Route 53 zone |
| Secrets | One Secrets Manager secret, injected as ECS `secrets` |
| Logs | CloudWatch `/ecs/<name>/den-api` and `/ecs/<name>/den-web` |
| Headless runner and Workbot (optional) | Managed Node runner (Service Connect, SQLite on EFS) or an existing celld/S3 fleet; diskless `workbot` at `chat.<domain_name>` (`headless_runner`, `workbot`) |
| OpenWork Web (optional) | `den-gateway` Fargate service at `web.<domain_name>`, sandboxes in your Daytona organization (`openwork_web_enabled = true`) |

It sets the same environment the [`openwork-ee` Helm chart](../../../../packaging/helm/openwork-ee)
sets on Kubernetes, so the chart's README and `ee/apps/den-api/.env.example`
document every setting you can add through `extra_environment`.

## Tested scenarios

Contract-v1 offline checks: Terraform 1.16.5 / AWS provider 6.69.1 and
OpenTofu 1.11.14 / AWS provider 6.69.0, 2026-10-15, 37 tests each (including write-only existing-database coverage).
The contract-v1 rows below are separate from historical task-local-migration runs.
An earlier AWS 5.100.0 / random 3.7.2 run is historical evidence, not the current
supported provider range. The managed root now adopts AWS 6.x with its own
committed lock; offline adoption tests are not a real provider-upgrade receipt.

What has been applied end to end in an AWS test account with
`examples/complete`, and what has not:

| Scenario | Result | Release / tools | Date |
| --- | --- | --- | --- |
| Contract-v1 offline guards, including write-only existing DB and no legacy bootstrap output in write-only mode | Passed: 37 per tool | Terraform 1.16.5 / OpenTofu 1.11.14 | 2026-10-15 |
| Contract-v1 release → dev, two API-only tasks, exactly one successful migrator per image, recognizable org preserved | Passed | 0.18.58 → dev ef455ca; AWS 6.69.1 | 2026-10-15 |
| Same-version later apply with identical ephemeral inputs; secret hashes/version and pre-apply session unchanged | Passed: plan exit 0, no changes | 0.18.58 | 2026-10-15 |
| Actual core secret values absent from state after release, reapply and upgrade | Passed | Write-only mode | 2026-10-15 |
| Fresh browser and isolated native desktop sign-in against the same preserved database | Passed | dev ef455ca | 2026-10-15 |
| Destroy with protection explicitly disabled; independent absence including automated snapshots | Passed | Contract-v1 disposable stack | 2026-10-15 |
| HTTPS on both hosts, migrations, `/setup` first administrator, sign-in, optional Redis | Passed | 0.18.54 | 2026-09 |
| OpenWork Web: sign-in through the gateway, a Daytona sandbox per member, a chat that edits files | Passed | 0.18.54 | 2026-09 |
| Tasks in private subnets behind a NAT gateway (`private_subnets = true` in the example) | Passed | 0.18.57 | 2026-10-13 |
| Two den-api tasks (`den_api.desired_count = 2`): both healthy, one session served by both, no Redis | Passed | 0.18.57, 0.18.58 | 2026-10-13 |
| Upgrade 0.18.57 → 0.18.58 with two den-api tasks: migrations ran, users and sessions kept | Passed | 0.18.57 → 0.18.58 | 2026-10-13 |
| OpenWork Desktop signs in to the deployment and runs a chat | Passed | 0.18.58 | 2026-10-13 |
| Email through Amazon SES SMTP (member invite delivered) | Passed | 0.18.58 | 2026-10-13 |
| Legacy per-task migrations with two API tasks (fresh install and release → dev) | Failed: concurrent peers required ECS replacement; eventual apply success did not mean every migration succeeded | 0.18.58 → dev | 2026-10-14 |
| Certificate created and validated by the module in a Route 53 zone (`route53_zone_id`) | Not run live (offline tests only) | | |
| Existing ECS cluster, ALB or HTTPS listener | Not run live (offline tests only) | | |
| Headless runner, Workbot, Slack assistant | Not run live | | |
| Upgrades across more than one release, rollback | Not run | | |

## Support level

> OpenWork's Terraform modules are **beta**. If you hit an issue:
> - **Customers with a support agreement:** contact your OpenWork team through your usual support channel.
> - **Everyone else:** [open a GitHub issue](https://github.com/different-ai/openwork/issues/new/choose).
> - **Security issues:** report them privately ([SECURITY.md](https://github.com/different-ai/openwork/blob/dev/SECURITY.md)).

Only the recorded core scenarios above are qualified. Optional headless runner,
Workbot and Slack paths remain unqualified by the contract-v1 live run. Complete your review before pinning a
source commit. The module and its deployment-contract improvements are available
on `dev` in **beta**. The shared [module contract](../../MODULE_CONTRACT.md) describes the
baseline and known limits, not a production load or legacy-upgrade guarantee.

## Before you start

- A VPC with subnets in at least two AZs.
  - **ALB**: public subnets (`alb_subnet_ids`, or private with `internal_alb = true`), or bring your own ALB / listener (`load_balancer_arn` or `alb_listener_arn`).
  - **Tasks**: private subnets with a NAT gateway (they pull images from
    `ghcr.io` and call model providers), or public subnets with
    `assign_public_ip = true`. To avoid `ghcr.io`, mirror the images to ECR
    and set `den_api_image` / `den_web_image`.
  - **RDS / ElastiCache**: private subnets (`database_subnet_ids`).
- Two hostnames: `domain_name` and `api.<domain_name>` (or `api_domain_name`).
  **HTTPS is required.** Den refuses to start with a plain-HTTP public URL
  outside dev mode.
- A certificate for both names: pass `certificate_arn`, or pass
  `route53_zone_id` and the module creates and validates one. If DNS is
  elsewhere, check the domain's CAA records allow `amazon.com`.

## Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-aws-ecs?ref=<commit>"

  openwork_version = "0.18.58" # built-in digest pins; other versions need both image overrides
  write_only_secrets = true
  secret_values_wo   = var.den_secrets # ephemeral input, supplied by your secret manager
  owner_emails     = ["admin@example.com"]
  org_name         = "Example Co"

  domain_name     = "openwork.example.com" # API: api.openwork.example.com
  route53_zone_id = "Z0123456789ABC"        # creates the cert and DNS records

  vpc_id              = "vpc-..."
  alb_subnet_ids      = ["subnet-public-a", "subnet-public-b"]
  service_subnet_ids  = ["subnet-private-a", "subnet-private-b"]
  database_subnet_ids = ["subnet-private-a", "subnet-private-b"]

  # Optional
  ecs_cluster_arn       = "arn:aws:ecs:us-east-1:123456789012:cluster/platform" # empty creates <name>-den
  create_redis          = false
  wait_for_steady_state = true # apply waits until the new tasks are healthy
  email_from            = "OpenWork <no-reply@example.com>"
  smtp = {
    host     = "email-smtp.us-east-1.amazonaws.com"
    username = var.ses_smtp_user
    password = var.ses_smtp_password
  }
}
```

After `terraform apply`:

1. `terraform output -raw bootstrap_code` (generated unless you set
   `initial_admin_bootstrap_code`).
2. Open the `setup_url` output, enter an owner email and that code, and
   create the first administrator. `/setup` works once, while the database
   has no users.
3. In OpenWork Desktop, set **Cloud control plane URL** (on the sign-in
   screen) to `web_url`. The desktop reads `web_url/api/runtime-config` and
   finds the API from there.

`examples/complete` is a disposable end-to-end stack that creates its own VPC
and uses a certificate you provide. By default the tasks run in public
subnets with public IPs; set `private_subnets = true` to run them in private
subnets behind a NAT gateway, as in production. `den_api_desired_count`,
`email_from` and `smtp` are passed through to the module.

Without a Route 53 zone, import or request an ACM certificate for both
hostnames yourself, pass it as `certificate_arn`, and point both hostnames
at the `alb_dns_name` output (CNAME) at your DNS provider.

## Notes

- **Existing ECS cluster.** Set `ecs_cluster_arn` to deploy the two services
  into a cluster you already run; the module then creates no cluster. The
  services are named `den-api` and `den-web`, so they must not collide with
  services already in that cluster; set `service_name_prefix` (for example
  `openwork-`) to prefix every service name. They use `launch_type = "FARGATE"`,
  which overrides the cluster's default capacity provider strategy. The
  module still creates its own Cloud Map namespace (`<name>.internal`), ALB
  (unless you bring one, below), security groups and IAM roles.
- **Existing load balancer.** By default the module creates an ALB
  (`<name>-den`) in `alb_subnet_ids`, a security group allowing 80/443 from
  `allowed_ingress_cidrs` (or attaches `alb_security_group_id` instead), the
  HTTPS and HTTP-redirect listeners, and, with `route53_zone_id`, DNS records
  for both hostnames. To use a load balancer you already run, set
  `alb_security_group_id` to its security group and one of:
  - `alb_listener_arn`: an HTTPS listener, for example on a shared ALB. The
    module adds host-header rules for `domain_name` and the API host
    (`web_listener_rule_priority`, `api_listener_rule_priority`; pick
    priorities that are free on that listener). Set
    `attach_listener_certificate = true` unless the listener's certificates
    already cover both hostnames.
  - `load_balancer_arn`: an ALB with nothing on ports 80 and 443. The module
    adds its own listeners to it.

  In both cases the module creates no DNS records: point both hostnames at
  your load balancer. `route53_zone_id` is then only used to validate a
  certificate the module creates.
- **Wait for steady state.** `wait_for_steady_state = true` also waits for app
  health and task drain. Its compatibility default is `false`; migration
  completion is mandatory regardless of that setting.
- **Migrations** run once in a dedicated task before either service rolls out.
  A Lambda invocation starts exactly one task and polls its terminal container
  exit. Failed, missing or timed-out exits block rollout; no automatic SQL
  retry. The 15-minute observation budget includes image pull and migration;
  timeout requests task stop and requires inspection before retry. Existing
  app tasks can still serve during an additive upgrade; incompatible changes
  require maintenance. This is deployment ordering, not a database mutex,
  dirty-state detector or schema-compatibility certification. Only one state /
  release coordinator may own a physical schema.
- **Native trigger vs provisioner.** ECS has no native Terraform RunTask-and-wait
  resource. A tiny Python Lambda plus `aws_lambda_invocation` avoids a
  workstation CLI, local credentials and `local-exec` portability exceptions.
  Its IAM can run only this deployment's migration task family in this cluster
  and pass only the two ECS roles. The family permission is stable across task
  revisions: changing IAM on every image upgrade can race policy propagation
  and reject RunTask before any SQL starts. Describe/stop task APIs use a wildcard resource constrained
  to the cluster. A deterministic ECS client token deduplicates uncertain
  invocation retries within ECS's token lifetime; it is not cross-state locking.
  Change `migration_run_id` only after inspecting failed/unknown tasks. Refresh
  does not rerun the invocation. Replica scaling never runs bootstrap.
- **Secrets** use ECS secret references, including SMTP username/password.
  `extra_environment` rejects secret-like names and collisions; use
  `extra_secrets` for additional Secrets Manager/SSM references. Core secrets
  support ephemeral inputs and provider write-only fields; see State guidance.
- **MySQL TLS** requires `sslaccept=strict` (default) or `sslmode=verify-full`.
  The module downloads the public regional RDS CA bundle via verified HTTPS,
  writes it into each API/web/migration container's temporary filesystem before
  Node starts, and sets `NODE_EXTRA_CA_CERTS`. No image rebuild or unverified
  connection exception is needed. This verifies the certificate chain. The
  current application's MySQL parser does not enable mysql2's separate hostname
  identity check, even for a `sslmode=verify-full` URL; full hostname verification
  needs a follow-up application change and is not claimed here. For an existing database pass its public
  `database_ca_bundle` and a strict-TLS URL. Custom images must provide `/bin/sh`,
  `base64`, Node and the documented application paths; no migration-on-start
  custom entrypoint is supported. Migration currently shares the DB principal
  with the app; a separate DDL principal / DML-only app user is a follow-up.
- **Email is optional to start.** Setup, sign-in and admin work without it.
  Without `smtp` or `resend_api_key`, member invites fail (the API returns
  `email_not_configured` and no invite link) and password reset is
  unavailable. To add a second user during a test, either configure email
  or set `allow_public_signup = true` for a while.
- **OpenWork Web** (chat in the browser, each member's workspace in a
  Daytona sandbox) is off by default; see [OpenWork Web](#openwork-web).
- **Anything else** (SSO, proxies, Gateway, observability): add env vars with
  `extra_environment` and secrets with `extra_secrets`.

## Upgrade notes

**Database size default: `db.t4g.micro` → `db.t4g.small`.** New installs get
2 GiB of database memory instead of 1 GiB; API and web sizes are unchanged.
Existing direct users who omitted `database.instance_class` will see an
**in-place instance-class change** in their next plan. Applying it queues the
change for the next RDS maintenance window by default (`apply_immediately = false`);
the class change restarts the database and interrupts connections when performed.
With `apply_immediately = true`, that restart happens during apply instead.
Review pending modifications and schedule maintenance before applying. See
[AWS modification behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.Modifying.html).

Estimated Single-AZ MySQL instance cost in **us-east-1** increases from
**$11.68 to $23.36/month (+$11.68)** at 730 hours ($0.016 → $0.032/hour,
public on-demand list prices checked 2026-10-19). Storage, CPU credits,
backups, networking, taxes and discounts are excluded; this is not a total-stack quote.
See [RDS pricing](https://aws.amazon.com/rds/mysql/pricing/).
To keep the old size, set this in your module call **before upgrading**
(merge it into your existing `database` object; keep its other settings):

```hcl
database = { instance_class = "db.t4g.micro" }
```

This opts out of the resize, but retains the measured low-memory risk of micro.
Managed installers explicitly pin their own sizes and are unchanged by this default.

**First upgrade from the old per-task migrator requires maintenance.** Reducing
replicas to one is not an exclusion barrier. Before applying this module:

1. Inventory all schema owners, including other clusters, manual jobs and retries.
   Back up the database and freeze all independent deployment/migration owners.
2. With the old module still installed, scale the old API service to **zero** and
   disable autoscaling/replacement/manual launch sources. Wait for every old
   task/migration to become terminal and for DB sessions/in-flight DDL to drain.
   Stop other writers if their compatibility cannot be established. Revoke the
   old migration credential after terminating sessions where feasible; queued
   legacy definitions must not be able to regain DDL access.
3. Only after that fence, apply this module with the required target replica
   count (for example two). The dedicated task must finish successfully before
   API-only tasks start. Keep legacy launch sources disabled. The API circuit
   breaker does not automatically roll back to a migration-capable definition.
4. Resume scaling using API-only definitions. Roll back application code only
   to a schema-compatible API-only image; never restore the old init container
   or assume rolling back Terraform rolls back the schema.

This module does not invent the application-level database lock, interruption
marker or schema-range protocol. If the legacy fence cannot be enforced, stay
in maintenance rather than running a second migrator.

**Digest migration:** `openwork_version = "0.18.57"` or `"0.18.58"` selects the
corresponding built-in API/web index digests. The 0.18.57 pair remains available to
direct users without floating tags. Other releases require `den_api_image` and `den_web_image`
with `@sha256` digests. Tags are rejected, including custom optional service
images when enabled. Existing image override names remain unchanged; pin their
current digest before upgrading. Gateway, runner and Workbot runtime behavior
is otherwise unchanged and not included in the contract-v1 live run.

**Secret migration:** the default is now `write_only_secrets = true`. For an
existing installation, explicitly set **false before upgrading** to preserve the
legacy random-resource addresses through `moved` blocks without regenerating
auth/encryption keys. Missing ephemeral values fail validation before changes;
there is no automatic key-generation conversion. For new installations supply
`secret_values_wo` from your own secret manager on every apply. It contains
`database_password`, `better_auth_secret`, `db_encryption_key`, `bootstrap_code`
and, for an existing DB, `database_url`. These inputs are ephemeral; RDS uses
`password_wo`, Secrets Manager uses `secret_string_wo`. Keep `secrets_version`
unchanged on ordinary application upgrades. The write-only bootstrap code is
not exported: retrieve it from your source secret manager for setup. A leftover
`initial_admin_bootstrap_code` is also never exported in write-only mode.
Remove regular legacy secret inputs when converting; supply only the ephemeral
object so old input values do not remain in saved plan files.

For an existing deployment, do not switch modes until the exact existing DB
password, auth secret, encryption key and bootstrap code have been captured
securely in that source secret manager. Supply those **same values**, change
mode, inspect the plan, apply in maintenance and verify existing sessions and
stored encrypted credentials. Never generate replacements as part of this
conversion. A later deliberate rotation changes `secrets_version` and must
preserve the encryption key unless application data is explicitly re-encrypted.
Historical state snapshots still contain old values; follow your backend's
retention and restricted-access policy rather than assuming write-only purges
them. Optional integration secrets remain on the compatibility state-backed
path; they are not converted implicitly.

## State guidance

Use an encrypted, access-controlled remote state backend. The reusable module
contains neither a provider configuration nor a backend. For S3, use native
locking, not a new DynamoDB lock table:

```hcl
terraform {
  backend "s3" {
    bucket       = "your-private-terraform-state"
    key          = "openwork/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

Require Terraform **>= 1.11, < 2.0** or OpenTofu **>= 1.11, < 2.0**.
This module is for **direct Terraform users** and requires AWS `~> 6.69`,
random `~> 3.9`, archive `~> 2.7` and HTTP `~> 3.5`. The temporary AWS 5.x/6.x
compatibility-range exception has been removed.

The managed AWS installer consumes this module with `write_only_secrets=false`
and `managed_legacy_secrets=true`. The latter is an installer-only compatibility
mode, not a direct-user default: it preserves the old accept seed and strict
current version while the runner fences legacy tasks before migration. It must
not be enabled by direct callers without that orchestration. Customers must
approve the updated scoped migration Lambda/IAM/log permissions and a maintenance
window. Direct-module live results do not certify that managed Update path.
See `infra/managed-deployments/README.md` for the complete upgrade/recovery flow.

Core definition addresses now use `api_v1`, `web_v1`, `migrate_v1`, with
`skip_destroy=true` from creation. Earlier API/web/migrator addresses are
forgotten without deregistration; managed `api_ca`/`web_ca` addresses move to the
new ones. This intentionally retains historical revisions, including pre-CA or
migration-capable ones: never manually restart them. Inventory/deregister owned
retained definitions only after services are destroyed during decommissioning.
API rollback remains disabled; managed web rollback is also disabled for safe
first adoption. Direct web rollback behavior is unchanged.

No provider lock file is shipped in this reusable module. Generate your root
or example lock with the tool you use (`terraform init` / `tofu init`), then
commit it in that root. Registries differ; regenerate with `init -upgrade`
when deliberately switching tools (a newly released provider may appear in
one registry before the other). `.openwork-migration.zip` is generated locally
from the shipped public controller source and is not committed.

Compatibility mode retains generated core values in state. Write-only mode
keeps core values out of new plan/state snapshots, but optional integration
inputs (SMTP, Resend, Daytona, runner) still use legacy sensitive variables /
state and must not be committed. Losing the persistent encryption key makes
stored encrypted credentials unreadable. The task definition and Lambda input
contain only secret references, never secret bytes. Do not disable Node TLS
verification through custom environment overrides.

## Inputs and defaults

All inputs remain listed in `variables.tf`, `security.tf` and `managed.tf`; equivalent cloud
concepts use the common names below. AWS uses `tags` rather than GCP `labels`.

| Input | Default / meaning |
| --- | --- |
| `openwork_version` | Required release label; built-in pins for 0.18.57/0.18.58 |
| `den_api_image`, `den_web_image` | Empty selects built-in release pins; custom refs require digests |
| `domain_name`, `api_domain_name` | Required web host; API defaults to `api.<domain_name>` |
| `owner_emails`, `org_name`, `org_slug` | Required owners; `OpenWork`, `default` |
| `name`, `tags` | `openwork`, `{}` |
| `vpc_id`, `service_subnet_ids` | Required existing VPC and task subnets |
| `alb_subnet_ids`, `database_subnet_ids` | `[]`; supply two AZs for managed ALB/RDS |
| `create_database`, `database_url` | `true`, empty legacy URL; false brings an existing strict-TLS DB (write-only mode uses `secret_values_wo.database_url`) |
| `deletion_protection` | `true`; deprecated `database.deletion_protection` overrides if set |
| `database` | t4g.small, MySQL 8.4, 20–100 GiB gp3, single AZ, 7-day backups, final snapshot, deferred changes, strict TLS |
| `database_ca_bundle` | Empty fetches regional public RDS CA; PEM override for existing DB |
| `den_api` | 1024 CPU units / 2048 MiB / one task; no migrations in replicas |
| `den_web` | 512 CPU units / 1024 MiB / one task |
| `cpu_architecture` | `X86_64`; also ARM64 |
| `migration_run_id` | `initial`; intentional same-definition rerun only |
| `write_only_secrets`, `secret_values_wo`, `secrets_version` | `true` write-only by default (existing deployments explicitly set false); ephemeral core object; version `1` |
| `initial_admin_bootstrap_code` | Empty generates code in compatibility mode only |
| `ecs_cluster_arn`, `service_name_prefix` | Empty creates cluster; empty service prefix |
| `load_balancer_arn`, `alb_listener_arn`, `alb_security_group_id` | Empty creates resources; nonempty brings existing infrastructure |
| `certificate_arn`, `route53_zone_id` | Empty; provide validated ACM or Route 53 zone |
| `api_listener_rule_priority`, `web_listener_rule_priority`, `attach_listener_certificate` | `10`, `20`, `false` |
| `internal_alb`, `assign_public_ip`, `allowed_ingress_cidrs` | `false`, `false`, public ALB ingress |
| `allow_public_signup`, `require_email_verification` | Both `false` |
| `automations_enabled`, `dashboards_enabled`, `slack_assistant_enabled` | All `false` |
| `email_from`, `smtp`, `resend_api_key` | Empty / disabled; SMTP port 587, nonimplicit TLS |
| `extra_environment`, `extra_secrets` | Empty maps; nonsecret settings / secret references |
| `create_redis`, `redis_node_type` | `false`, `cache.t4g.micro` |
| `wait_for_steady_state`, `log_retention_days`, `secret_recovery_window_days` | `false`, `30`, `7` |
| `openwork_web_enabled`, `openwork_web_domain_name`, `openwork_web_url` | Off; `web.<domain_name>`; no override |
| `den_gateway`, `den_gateway_image`, `openwork_web_listener_rule_priority` | 256 CPU / 512 MiB / one; digest override required if enabled; `30` |
| `provisioner_mode`, `daytona`, `daytona_api_key` | Auto stub/Daytona; hosted API with empty snapshot/target; empty key |
| `headless_runner`, `headless_runner_image`, `headless_runner_token` | Off; 512 CPU / 1024 MiB; digest override if managed; empty external token |
| `headless_model_api_key`, `headless_computer`, `headless_computer_api_key` | Empty key; computer off; empty key |
| `workbot`, `workbot_image`, `workbot_listener_rule_priority` | Off; 256 CPU / 512 MiB / one; digest override if enabled; `40` |

## Outputs

| Output | Meaning |
| --- | --- |
| `web_url`, `api_url` | Common public HTTPS endpoints |
| `database_identifier` | Common managed DB identifier, null for existing DB |
| `migration_step_identifier`, `migration_result` | Common migration task definition; terminal task/image/exit result |
| `setup_url`, `bootstrap_code` | First administrator URL; sensitive legacy code (null in write-only mode) |
| `secret_arn`, `database_endpoint` | Secret reference; managed RDS endpoint |
| `cluster_name`, `cluster_arn`, `service_names` | ECS identities |
| `alb_arn`, `alb_dns_name`, `alb_zone_id`, `alb_security_group_id` | ALB/DNS integration |
| `task_security_group_id`, `target_group_arns`, `log_groups`, `certificate_arn` | Network and observation references |
| `openwork_web_url`, `workbot_url` | Optional app endpoints, null while disabled |

## Slack, headless Automations and Workbot

These run agent turns without a member's desktop or a sandbox, on the
**headless runner**: a private service that calls your model provider directly
and reaches the organization's tools through Den's `/mcp/agent`, with
short-lived member-scoped tokens Den mints per turn. Den and Workbot reach it
at `http://headless-runner:8795` through ECS Service Connect; it runs as one
task with its SQLite database on EFS (one mount target per service subnet, so
keep `service_subnet_ids` in different availability zones).

```hcl
  automations_enabled     = true # headless cloud Automations
  slack_assistant_enabled = true
  headless_model_api_key  = var.anthropic_api_key
  headless_runner = {
    enabled = true
    model   = "claude-sonnet-4-5" # any model at model_base_url
    # model_protocol = "openai"; model_base_url = "https://…/v1" for OpenAI-compatible endpoints
  }
  workbot = {
    enabled       = true # https://chat.<domain_name>
    desired_count = 2    # encrypted-cookie sign-in, no disk or sticky sessions
  }
```

Workbot stores sign-in state in encrypted cookies using one shared
`WORKBOT_SESSION_SECRET` in Secrets Manager. It has no EFS mount or
`WORKBOT_DB_PATH`; replicas use rolling deployments (100% minimum healthy,
200% maximum). The managed Node runner still needs EFS and remains a single
writer, regardless of Workbot's replica count.

### Existing celld/S3 fleet

To use an already deployed celld fleet instead of the managed Node runner:

```hcl
  headless_runner = {
    enabled      = true
    external_url = "https://cells.example.com"
  }
  headless_runner_token = var.cells_api_token # sensitive; fleet's HEADLESS_API_TOKEN
  workbot = {
    enabled       = true
    desired_count = 2
  }
```

Den and Workbot use this endpoint and receive its token through Secrets Manager.
The module creates **no Node runner, runner token, EFS filesystem or mount targets**
in this mode. The endpoint must be reachable from the task subnets. HTTPS is
required except for a single-label private HTTP hostname such as
`http://headless-cells:8795`; that hostname must resolve on your private network
(the module does not register an external fleet with Service Connect).

The fleet itself, its private peer networking and its S3/R2 bucket are managed
separately. Deploy the worker with `celld deploy`, using the same stable worker
and class names. Configure its model, MCP and computer settings there; this
module's `headless_model_api_key` and `headless_computer` settings apply only to
the managed Node runner. Cells require `HEADLESS_FILES=s3` (or `off`), with saved
file bytes separate from the fleet database objects. Never put bucket credentials
or fleet tokens in committed `.tfvars` files. See
[`OWNER-CELLS.md`](../../../../ee/apps/headless-runner/OWNER-CELLS.md).

**Required on Fargate and other temporary disks: set `CELLD_DURABILITY=bucket`
on every fleet node.** The default `fleet` mode can keep acknowledged writes
only on node-local disks until they reach the bucket. If all nodes stop
together and lose those disks, celld refuses to open affected cells until it can
verify the missing data. Bucket mode avoids that availability failure. Use
`fleet` only with persistent `CELLD_WATCH` disks and stable node identities.
Consider `CELLD_TTL_MS=30000` to tolerate brief bucket outages.

**Migration safety:** upgrade Workbot to a build with encrypted-cookie sign-in
before applying the diskless task definition. Older builds require the database.
The plan removes Workbot's obsolete EFS access point; its old sign-in sessions no
longer apply. Switching an existing deployment to `external_url` also plans to
**destroy the managed runner and its EFS storage**. Do not apply that plan while
you need the old conversations or a rollback: back up the data, retain the old
resources outside this module's state/configuration, and inspect the full plan
first. Conversations are not migrated into cells and in-flight turns can fail at
cutover. To roll back using the retained Node runner, set `external_url` to its
reachable private endpoint and pass its original token, rather than creating a
fresh managed runner.


- **Workbot** is a chat app at `workbot.domain_name` (default
  `chat.<domain_name>`; covered by a module-created certificate and Route 53).
  Members sign in with their OpenWork account; the dashboard links to it.
- **Slack**: `slack_assistant_enabled` turns the Slack assistant on. Replies
  run on the headless runner when it is enabled (and work a reply hands to a
  member's desktop is posted back to the thread), otherwise on OpenWork Web.
  Then, in Den, add the Slack connector and follow its Slack assistant setup:
  it generates the Slack app manifest with this deployment's URLs. See
  [Set up the Slack app](https://openworklabs.com/docs/slack/set-up-the-slack-app).
- **Headless Automations**: with `automations_enabled` and the runner,
  scheduled cloud Automations run on the runner.

### Optional Workbot computer (Daytona or Freestyle)

The runner's `bash` and `look` tools can use either provider, off by default.
Daytona shares this deployment's Daytona connection, but **not the Web snapshot**:

```hcl
  headless_computer = {
    provider = "daytona"
    snapshot = "<snapshot from snapshot:build:daytona>"
  }
  daytona_api_key = var.daytona_api_key
```

Build it with `DAYTONA_API_KEY=… pnpm --filter @openwork-ee/headless-computer snapshot:build:daytona`.
For Freestyle, set `provider = "freestyle"` and `headless_computer_api_key`;
its snapshot defaults to the existing prepared computer image. The backend
setting changes where tools run, not organization feature access. Turning it
off stops new computer use; existing computers retain their provider's idle
and retention policies and can be explicitly cleaned up by their owner.

## OpenWork Web

OpenWork Web lets members chat with OpenWork in the browser. Each member gets
their own workspace in a [Daytona](https://www.daytona.io) sandbox (daytona.io
or a self-hosted Daytona); nothing runs on member machines. With
`openwork_web_enabled = true` the module adds:

- a `den-gateway` service at `openwork_web_domain_name` (default
  `web.<domain_name>`), which serves the web app, forwards `/api/den` to
  den-api, and proxies each signed-in member to their sandbox;
- that hostname on the HTTPS listener, the certificate (when the module
  creates it) and Route 53 (when the module manages DNS);
- the den-api settings Web needs: the gateway origin and a shared gateway key,
  Daytona, sandbox activity reports to the public API URL, and the dashboard's
  OpenWork Web button pointing at your gateway.

You provide:

1. **A Daytona API key** (`daytona_api_key`) for the organization the
   sandboxes run in.
2. **A sandbox snapshot** in that organization (`daytona.snapshot`), built
   from this repository at the same release as `openwork_version`:

   ```bash
   git checkout v<openwork_version>
   DAYTONA_API_KEY=... ./scripts/create-daytona-openwork-snapshot.sh openwork-<openwork_version>
   ```

   It needs Docker and the Daytona CLI.
3. **An internet-facing ALB.** Sandboxes report activity to the public API
   URL, so `internal_alb = true` is not supported with Web.

```hcl
  openwork_web_enabled = true
  daytona_api_key      = var.daytona_api_key
  daytona = {
    snapshot = "openwork-0.18.57"
  }
```

After `terraform apply`, sign in to `web_url` as the administrator you
created at `/setup`, open **Admin**, find your organization, and turn on
**OpenWork Web** access. Then add a model provider for members, and they can
use the `openwork_web_url` output (also the dashboard's OpenWork Web button).

Sandbox and volume names start with `daytona.name_prefix` (default `name`), so
several deployments can share one Daytona organization.

## Cost notes

### Small / trial baseline

| Component | Default per copy |
| --- | --- |
| Den API | 1 vCPU / 2 GiB, one task |
| Den web | 0.5 vCPU / 1 GiB, one task |
| Database | db.t4g.small (2 GiB), 20 GiB gp3, single AZ, 7-day backups |
| Migration task | 1 vCPU / 2 GiB, one task per deployment |

This provisional baseline comes from light setup/sign-in measurements, not a
user-capacity load test. Medium/Large and optional service sizes are not qualified.
Use two API copies for service redundancy when needed (additional compute cost);
this does not make the single-AZ database highly available.

The instance-only monthly estimate and old-size opt-out are in
[Upgrade notes](#upgrade-notes). Budget separately for Fargate, ALB, optional
NAT/Redis, storage/backups, logs and image-transfer traffic. API/web size changes
in this revision cost **$0/month extra** because those defaults are unchanged.
Managed installer sizes are separately pinned; this module-default change does
not update their small profile.
