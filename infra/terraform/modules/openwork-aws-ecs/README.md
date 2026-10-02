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

It sets the same environment the [`openwork-ee` Helm chart](../../../../packaging/helm/openwork-ee)
sets on Kubernetes, so the chart's README and `ee/apps/den-api/.env.example`
document every setting you can add through `extra_environment`.

> **Status: draft.** Applied end to end in an AWS test account with
> `examples/complete` (release 0.18.54): HTTPS on both hosts, migrations,
> the one-time `/setup` administrator flow, sign-in, and the optional Redis.
> Not yet exercised: private subnets behind NAT, multiple den-api replicas,
> SMTP/SES delivery, upgrades across releases, OpenWork Web sandboxes.

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
  ecs_cluster_arn = "arn:aws:ecs:us-east-1:123456789012:cluster/platform" # empty creates <name>-den
  create_redis    = false
  email_from   = "OpenWork <no-reply@example.com>"
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
  module still creates its own Cloud Map namespace (`<name>.internal`), ALB,
  security groups and IAM roles.
- **ALB and security groups.** By default, the module creates an Application
  Load Balancer (`<name>-den`) in `alb_subnet_ids` and creates a dedicated security
  group allowing HTTP (80) and HTTPS (443). If `alb_security_group_id` is omitted,
  that security group is created and attached to the ALB. To deploy behind an
  existing ALB, pass `load_balancer_arn` (or `alb_listener_arn` to attach rules
  to an existing listener) and set `alb_security_group_id` so ECS tasks permit
  ingress from your load balancer. You can also pass `alb_security_group_id` when
  creating an ALB to attach a custom security group instead of generating one.
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
- **OpenWork Web** (cloud chat sessions) is off by default. The dashboard's
  OpenWork Web button points at the hosted service unless you set
  `openwork_web_url`. It needs a sandbox
  provider; none runs inside this stack. Set `openwork_web_enabled = true`,
  `provisioner_mode = "daytona"`, and pass `DAYTONA_API_KEY` via `extra_secrets`.
- **Anything else** (SSO, proxies, Gateway, observability): add env vars with
  `extra_environment` and secrets with `extra_secrets`.

## Rough cost (us-east-1, defaults)

About $3/day: den-api 1 vCPU/2 GB and den-web 0.5 vCPU/1 GB on Fargate, a
db.t4g.micro RDS, and an ALB. ElastiCache adds about $0.40/day. A NAT
gateway, if your VPC needs one, adds about $1/day.
