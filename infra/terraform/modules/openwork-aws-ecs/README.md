# openwork-aws-ecs (Terraform, draft)

Runs a private, single-organization OpenWork control plane (Den) on AWS
**ECS Fargate**, without Kubernetes:

| Piece | AWS resource |
| --- | --- |
| ECS cluster | `<name>-den`, or your existing cluster (`ecs_cluster_arn`) |
| Den API (`ghcr.io/different-ai/openwork-den-api`, port 8788) | Fargate service, registered in Cloud Map |
| Den web (`ghcr.io/different-ai/openwork-den-web`, port 3005) | Fargate service |
| Database migrations | Init container in each den-api task; den-api starts only if it succeeds |
| MySQL 8.4 | RDS, encrypted, private (or bring your own `database_url`) |
| Cache (optional) | ElastiCache Redis with TLS (`create_redis = true`) |
| HTTPS | ALB: `domain_name` → den-web, `api.<domain_name>` → den-api, HTTP redirects (or your existing ALB / listener) |
| Certificate | Your ACM ARN, or created and DNS-validated in a Route 53 zone |
| Secrets | One Secrets Manager secret, injected as ECS `secrets` |
| Logs | CloudWatch `/ecs/<name>/den-api` and `/ecs/<name>/den-web` |
| Headless runner and Workbot (optional) | `headless-runner` service (Service Connect, SQLite on EFS) and `workbot` at `chat.<domain_name>` (`headless_runner`, `workbot`) |
| OpenWork Web (optional) | `den-gateway` Fargate service at `web.<domain_name>`, sandboxes in your Daytona organization (`openwork_web_enabled = true`) |

It sets the same environment the [`openwork-ee` Helm chart](../../../../packaging/helm/openwork-ee)
sets on Kubernetes, so the chart's README and `ee/apps/den-api/.env.example`
document every setting you can add through `extra_environment`.

> **Status: draft.** Applied end to end in an AWS test account with
> `examples/complete` (release 0.18.54): HTTPS on both hosts, migrations,
> the one-time `/setup` administrator flow, sign-in, and the optional Redis.
> OpenWork Web was applied end to end the same way: sign-in through the
> gateway, a Daytona sandbox per member, and a chat that edits files.
> Not yet exercised: private subnets behind NAT, multiple den-api replicas,
> SMTP/SES delivery, upgrades across releases.

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

  openwork_version = "0.18.54"
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
(no NAT gateway) and uses a certificate you provide.

## Notes

- **Existing ECS cluster.** Set `ecs_cluster_arn` to deploy the two services
  into a cluster you already run; the module then creates no cluster. The
  services are named `den-api` and `den-web`, so they must not collide with
  services already in that cluster. They use `launch_type = "FARGATE"`,
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
- **Wait for steady state.** With `wait_for_steady_state = true`,
  `terraform apply` waits until the new tasks pass health checks and the old
  ones drain, so a crash or failed migration fails the apply. The default
  (`false`) returns as soon as ECS accepts the update.
- **Migrations** run in each den-api task before the app starts, like the Helm
  chart's pre-upgrade Job. They are idempotent but not locked, so keep
  `den_api.desired_count = 1` until you need more, and scale after a deploy
  settles.
- **Secrets** (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY`,
  the setup code, SMTP/Resend/Redis) live in Secrets Manager and in Terraform
  state. Use an encrypted remote backend. Losing `DEN_DB_ENCRYPTION_KEY` makes
  encrypted database values unreadable.
- **MySQL TLS** defaults to `sslaccept=accept` (encrypted, certificate not
  verified), because the RDS CA is not in Node's trust store. For verified TLS,
  add the RDS CA bundle to the images and set `database.tls_query`.
- **Email is optional to start.** Setup, sign-in and admin work without it.
  Without `smtp` or `resend_api_key`, member invites fail (the API returns
  `email_not_configured` and no invite link) and password reset is
  unavailable. To add a second user during a test, either configure email
  or set `allow_public_signup = true` for a while.
- **OpenWork Web** (chat in the browser, each member's workspace in a
  Daytona sandbox) is off by default; see [OpenWork Web](#openwork-web).
- **Anything else** (SSO, proxies, Gateway, observability): add env vars with
  `extra_environment` and secrets with `extra_secrets`.

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
    enabled = true # https://chat.<domain_name>
  }
```

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

## Rough cost (us-east-1, defaults)

About $3/day: den-api 1 vCPU/2 GB and den-web 0.5 vCPU/1 GB on Fargate, a
db.t4g.micro RDS, and an ALB. ElastiCache adds about $0.40/day. A NAT
gateway, if your VPC needs one, adds about $1/day.
