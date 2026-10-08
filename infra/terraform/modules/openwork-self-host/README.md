# openwork-self-host (Terraform, draft)

Installs a private, single-organization OpenWork on an existing Kubernetes
cluster. It wraps the published `openwork-ee` Helm chart
(`oci://ghcr.io/different-ai/charts/openwork-ee`), so it deploys the same
thing as the [AWS](../../../../docs/aws-eks-helm.md),
[Azure](../../../../docs/azure-aks-helm.md) and
[Google Cloud](../../../../docs/gcp-gke-helm.md) Helm guides, with typed
inputs and generated secrets.

> **Status: first draft.** Validated with `terraform validate` and by
> rendering its values through `helm template` against the chart. It has not
> yet been applied to a live cluster. Expect input names to change.

## What it creates

| Resource | Notes |
| --- | --- |
| Namespace | Optional (`create_namespace`). |
| `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY` | Generated when not supplied. Stored in Terraform state. |
| Kubernetes Secret | Written by Terraform by default. Can instead be rendered by the chart or supplied by you (`existing_secret_name`). |
| Helm release `openwork-ee` | Den API, Den web, and the migration Job that runs before each install or upgrade. Ingress is optional. |

## What you provide

The module deploys the app only. Before `terraform apply`, you need:

- A Kubernetes cluster and a kubeconfig context for it.
- **MySQL 8** reachable from the cluster, with an empty database (for
  example `openwork_den`) and a user that can create tables.
- An **ingress controller** (or your own load balancer: set
  `ingress.enabled = false` and point it at the `services` output).
- **DNS** for your host, and a **TLS** Secret for it, such as one issued by
  cert-manager.
- Optional: an SMTP relay for email, Redis for caching, and a private CA
  bundle if MySQL or your proxy uses one.

## Required inputs

| Input | Example |
| --- | --- |
| `openwork_version` | `"0.18.54"`: pins the chart and every image |
| `web_origin` | `"https://openwork.example.com"` |
| `database_url` | `"mysql://openwork:…@mysql.internal:3306/openwork_den?sslmode=verify-full"` |
| `owner_emails` | `["admin@example.com"]` |
| `initial_admin_bootstrap_code` | output of `openssl rand -hex 16` |
| `ingress.web_host` | `"openwork.example.com"` (when ingress is enabled) |

Everything else has a private-deployment default: public signup is off,
single-org mode, Automations and Dashboards are off. See `variables.tf`.

## Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-self-host?ref=<commit>"

  openwork_version             = "0.18.54"
  web_origin                   = "https://openwork.example.com"
  database_url                 = var.database_url
  owner_emails                 = ["admin@example.com"]
  initial_admin_bootstrap_code = var.setup_code

  ingress = {
    class_name      = "nginx"
    web_host        = "openwork.example.com"
    tls_secret_name = "openwork-ee-tls"
  }
}
```

A complete root module with provider setup is in
[`examples/basic`](./examples/basic).

After apply, open the `setup_url` output, enter an owner email and the
bootstrap code, and create the first administrator. `/setup` works only
while the database has no users.

## Secrets

- **Terraform (default):** the module writes the Secret. Values, including
  generated keys, live in Terraform state, so use an encrypted remote
  backend.
- **Existing Secret:** set `existing_secret_name`. Pods load it with
  `envFrom`, so its keys are env var names: `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY`,
  `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE`, and any `SMTP_*`, `EMAIL_FROM` or
  `DATABASE_REDIS_URL`.
- **Chart:** `manage_secret_with_terraform = false` renders the Secret from
  Helm values.

Keep `DEN_DB_ENCRYPTION_KEY` safe. Encrypted database values cannot be read
without it.

## Anything else in the chart

Pass any other chart value through `extra_helm_values`. Helm deep-merges it
over the module's values, for example to enable Gateway or change probes:

```hcl
extra_helm_values = {
  migrations = { activeDeadlineSeconds = 3600 }
}
```

The chart's [README](../../../../packaging/helm/openwork-ee/README.md) lists
every value.

## Not covered yet

- Provisioning the cluster, MySQL, Redis, DNS or certificates for a specific
  cloud.
- A tested apply on a live cluster, and an upgrade across chart versions.
- First-class inputs for Gateway, Daytona provisioning, the GitHub connector
  and installer artifacts (use `extra_helm_values` for now).
- Helm provider 3.x (`kubernetes = {}` attribute syntax); pinned below 3.0.
