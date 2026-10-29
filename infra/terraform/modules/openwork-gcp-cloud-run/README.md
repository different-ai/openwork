# openwork-gcp-cloud-run

## What it deploys

A single-organization OpenWork control plane (Den), without Kubernetes:

| Component | Google Cloud resource |
| --- | --- |
| Den API / web | Cloud Run services `<name>-den-api` (8788) and `<name>-den-web` (3005) |
| Migrations | One Cloud Run job `<name>-den-migrate`; apply waits for success before updating API |
| MySQL 8.4 | Cloud SQL through Cloud Run's IAM-authorized, verified-TLS connector |
| Secrets | Secret Manager references, never plain secret environment variables |
| Images | Artifact Registry remote repository proxying ghcr.io, or custom digest-pinned images |
| HTTPS | Default run.app URLs; optional global HTTPS load balancer and managed certificate |
| Identity / logs | Dedicated runtime service account, per-secret accessor grants; Cloud Logging |
| Optional network | Direct VPC egress into an existing VPC/subnet |

Uses the environment described in [the manual Cloud Run guide](../../../../docs/gcp-cloud-run.md), `packaging/cloud-run`, and the Helm chart. Workbot, the runner, Slack, OpenWork Web/gateway, Redis and headless Automations are outside this module; their existing inputs are unchanged.

## Tested scenarios

| Date | Tools | Images | Scenario / result |
| --- | --- | --- | --- |
| 2026-10-14 | Terraform 1.16.5 | 0.18.58 → dev b8efc5b (digests) | Earlier module: setup, browser, isolated desktop, same-database upgrade and destroy passed; one API instance |
| 2026-10-15 | Terraform 1.16.5 / OpenTofu 1.11.14 | Mocked Google provider | Init, validate and 32 offline test runs per tool passed; write-only fields, protected DB, 2-instance singleton migration topology |
| 2026-10-15 | Terraform 1.16.5; local testkit | 0.18.58 → dev f450b1a (digests) | Two API instances observed in both revisions; one migrator/task per deployment, exit 0; setup, browser, exact admin/org preservation, isolated source Electron, no secret rotation/state values, 21-resource destroy and independent empty inventory passed |

The live run used new-deployment write-only mode and db-g1-small, no VPC/load balancer. It does not certify legacy write-only adoption, an existing external database, concurrent deployment coordinators or production load. Job CPU/memory had no nonempty Monitoring samples; service memory distributions aggregate the two API instances, and no idle-instance memory sample was available.

## Support level

> OpenWork's Terraform modules are **beta**. If you hit an issue:
> - **Customers with a support agreement:** contact your OpenWork team through your usual support channel.
> - **Everyone else:** [open a GitHub issue](https://github.com/different-ai/openwork/issues/new/choose).
> - **Security issues:** report them privately ([SECURITY.md](https://github.com/different-ai/openwork/blob/dev/SECURITY.md)).

Follow the shared [module contract](https://github.com/different-ai/openwork/blob/dev/infra/terraform/MODULE_CONTRACT.md). Pin the module to a reviewed commit. Existing-database, email-delivery, failure-recovery, sustained-load and production-sizing coverage is not implied by a disposable smoke test. The dedicated job is a deployment-ordering gate, **not** a database mutex, dirty marker or cross-deployment serialization protocol. Keep one deployment coordinator per physical database.

Requires Terraform **>= 1.11, < 2.0** or OpenTofu **>= 1.11, < 2.0**. Provider constraints are `google ~> 8.7`, `random ~> 3.9`. No provider or backend configuration lives in the reusable module.

### Before you start

- Enable Cloud Run, SQL Admin, Secret Manager and Artifact Registry APIs; enable Compute for network/load-balancer options. API enablement remains operator-owned.
- Use normal application-default credentials (`gcloud auth application-default login`) or workload identity. Do not commit credentials.
- The applying identity needs resource creation and IAM-setting permissions. Project Editor alone is insufficient: Project IAM Admin, Secret Manager Admin and Cloud Run Admin are needed for the defaults. Alternatively provision IAM separately and pass `service_account_email` with `grant_iam_roles = false`.
- HTTPS only. The API is reachable without Google sign-in (`invoker_iam_disabled`); Den still authenticates users. With `public_access = false`, den-web cannot call den-api: browser sign-in is unavailable.

### Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-gcp-cloud-run?ref=<reviewed-commit>"
  project_id       = "my-project"
  openwork_version = "0.18.58"
  image_digests = {
    den_api = "sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e"
    den_web = "sha256:b1543b2bb36df0a7c75d7dc18cdd773eb2e87df268169dcb1e284439299ada3f"
  }
  owner_emails      = ["admin@example.com"]
  org_name          = "Example Co"
  # Secrets stay out of state by default; read Secrets and later runs.
}
```

Get the setup code directly from Secret Manager, without logging it, using the `secret_ids.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE` output. Open `setup_url`, create the first administrator, then sign in. In Desktop use `web_url` as the control plane URL: runtime configuration discovers `api_url`. Legacy mode retains the sensitive `bootstrap_code` output. Email is optional for setup/sign-in, but invites/reset need SMTP or Resend.

### Inputs and defaults

| Input | Default / meaning |
| --- | --- |
| `project_id`, `openwork_version`, `owner_emails` | Required; at least one owner |
| `region`, `name`, `labels` | `us-central1`, `openwork`, `{}` |
| `image_digests` | `{}`; set both published digests or supply pinned custom images |
| `den_api_image`, `den_web_image` | Empty: use ghcr.io mirror; every final image must end in `@sha256:<64 hex>` |
| `create_image_mirror` | `true` (not used when both custom images are supplied) |
| `allow_mutable_image_tags` | `false`: digest pinning is the only default; explicit tag opt-in is not recommended or contract-conformant |
| `service_account_email`, `grant_iam_roles` | Empty creates an identity; grants default `true` |
| `deletion_protection` | `true` for database, services and job; explicitly disable for disposable tests |
| `domain_name`, `api_domain_name` | Empty: HTTPS run.app; custom API default `api.<domain_name>` |
| `ssl_certificate_ids`, `load_balancer_ip_address` | `[]`, empty: create managed cert and global IP |
| `restrict_ingress_to_load_balancer`, `public_access` | `false`, `true` |
| `network`, `subnetwork`, `vpc_egress` | Empty existing-network references, `PRIVATE_RANGES_ONLY`; network requires subnet |
| `org_name`, `org_slug` | `OpenWork`, `default` |
| `initial_admin_bootstrap_code` | Empty generates a 24-character code |
| `allow_public_signup`, `require_email_verification` | Both `false` |
| `automations_enabled`, `dashboards_enabled` | Both `false`; retained compatibility inputs |
| `extra_environment`, `extra_secrets` | `{}`; non-secrets / Secret Manager IDs respectively; credential-like plain env names rejected |
| `email_from`, `resend_api_key` | Empty |
| `smtp` | Host/user/password empty, port `587`, secure `false`; password stored in Secret Manager |
| `create_database`, `database_url`, `cloud_sql_connection_name` | `true`, empty, empty; bring an existing database by setting create false and a verified URL |
| `database.tier`, `database.edition`, `database.database_version` | `db-g1-small` (**1.7 GB**), `ENTERPRISE`, `MYSQL_8_4`; micro reached its memory quota at idle |
| `database.disk_size_gb`, `database.availability_type`, `database.backup_enabled` | `20`, `ZONAL`, `true` |
| `database.deletion_protection` | Deprecated nullable alias; when explicitly set it overrides the common input for Cloud SQL only |
| `den_api` | CPU `1`, memory `2Gi`, min `1`, max `3` |
| `den_web` | CPU `1`, memory `1Gi`, min `1`, max `3` (Cloud Run request-driven service floor uses one CPU) |
| `migration_run_id` | `"1"`; changing it deliberately runs another migration |
| `write_only_secrets` | `true`; ephemeral generation and write-only provider arguments; false is a not-recommended legacy compatibility opt-out |
| `database_password_wo_version` | `1`; deliberate database-password rotation counter, coordinate with the connection secret |
| `secret_data_wo_version` | `{}`; per-secret counters default to `1`, change only for deliberate rotation |
| `preserved_secrets_wo` | Ephemeral sensitive map `{}`; existing values for write-only adoption, never committed tfvars |

### Outputs

| Output | Meaning |
| --- | --- |
| `web_url`, `api_url`, `setup_url` | Public HTTPS endpoints |
| `database_identifier` | Common output: managed Cloud SQL instance ID; existing Cloud SQL connection name when supplied; empty for other external databases |
| `migration_step_identifier` | Common output: full Cloud Run job resource ID |
| `database_instance_name`, `cloud_sql_connection_name` | Retained aliases: managed instance name / connector reference (null/empty where external) |
| `migration_job_name` | Retained job-name output; logs use `resource.type="cloud_run_job"` |
| `secret_ids`, `service_account_email`, `service_names` | Managed secret identifiers and runtime identities |
| `images` | Final resolved image references |
| `bootstrap_code` | Sensitive legacy-mode value; null in write-only mode |
| `load_balancer_ip`, `dns_records` | Optional IP and two A records |

### Existing infrastructure and TLS

Existing Cloud SQL: `create_database = false`, `cloud_sql_connection_name = "PROJECT:REGION:INSTANCE"`, and `mysql://USER:PASSWORD@localhost/DB?socket=%2Fcloudsql%2FPROJECT%3AREGION%3AINSTANCE`. IAM grants are in `project_id` only; cross-project access is operator-owned. Other databases must use verified `sslaccept=strict` TLS. Unverified URLs are rejected; there is no private-IP accept-any-certificate fallback. In write-only mode prefer the ephemeral `preserved_secrets_wo.DATABASE_URL` input to avoid storing the URL in state.

Existing `network`/`subnetwork` enable Direct VPC egress for services and job; `ALL_TRAFFIC` needs Cloud NAT. Existing certificates and a reserved global IP can be reused. Custom domain certificates become active after both hostnames resolve to `load_balancer_ip`; HTTP redirects to HTTPS. `restrict_ingress_to_load_balancer = true` disables direct run.app ingress.

## Upgrade notes

**Database disk default: 10 → 20 GB.** Existing direct users who omitted
`database.disk_size_gb` will see an in-place storage increase in their next plan.
[Cloud SQL documents this increase as online, without downtime](https://docs.cloud.google.com/sql/docs/mysql/instance-settings#storage-capacity):
it does not require a restart or replacement. This is a storage-only change,
not an instance-tier change. **The disk cannot shrink afterward.** Review the
whole plan: unrelated changes can still require maintenance. If automatic
storage growth has already taken it above 20 GB, preserve the current allocation;
do not attempt to reduce it to this default.

Estimated zonal MySQL SSD storage in **us-central1**, at the public list price
of **$0.17/GB-month**, goes from **$1.70 to $3.40/month (+$1.70)**.
Estimate checked 2026-10-19; excludes database compute, backups, networking,
taxes and discounts. See [Cloud SQL pricing](https://cloud.google.com/sql/pricing).
To keep an existing 10 GB disk, set this **before applying the increase**
(merge it into your current `database` object, preserving other settings):

```hcl
database = { disk_size_gb = 10 }
```

Automatic storage growth remains enabled; this override does not cap growth or
undo an increase already applied. Managed installer sizes remain separately pinned.

1. Back up and inventory **all** processes/manual jobs/other installations sharing this physical schema. Freeze rollout/retries; choose one coordinator.
2. For legacy per-replica migrators, enter maintenance: scale old API to zero/stop it, disable replacements/autoscale and queued retries, await terminal old task/job/container states, and verify old DB sessions/in-flight DDL are gone. Drain other incompatible DB consumers too. A new lock cannot fence old noncooperating code.
3. Prefer separate migration DDL and application DML credentials. Once terminated, revoke the old migration credential so stale jobs cannot restart. This module still uses one database principal for both: split-principal SQL grants are a follow-up, not an asserted guarantee. If exclusion cannot be established, **do not migrate**.
4. Update both image digests. Apply runs exactly one native job task (zero automatic retries) and waits for success before API rollout; API containers do not run bootstrap. A failed/unknown execution means no promotion: inspect the retained execution/logs before any manual rerun. Do not start another coordinator.
5. Verify data, browser/desktop sign-in, then resume API-only scaling. Roll back application code only when schema-compatible; never re-enable old per-replica migration definitions or auto-rollback the database.

**Default change in this contract revision:** the earlier module merged first with legacy state-backed secrets; this revision makes write-only secrets the default. A stack already created with the earlier mode must explicitly keep `write_only_secrets = false` until its exact existing values are preserved using the adoption procedure below. Do not change modes on a populated deployment without that handover. Changing the SQL tier may restart Cloud SQL; schedule maintenance. New `deletion_protection` controls SQL too; the old nested override retains precedence. Unverified existing database URLs now require an explicit correction to verified TLS.

**Write-only new deployments:** ephemeral random passwords feed `google_sql_user.password_wo` and `google_secret_manager_secret_version.secret_data_wo`. Stable version counters keep the stored values unchanged when ephemeral values are regenerated on later evaluations; image upgrades do not rotate keys. Do not bump these counters, taint/replace secret versions/users, change naming, or toggle modes as a rotation shortcut. Secrets the app needs on restart persist in Secret Manager, not Terraform state. Recover deleted secrets from backups, not regeneration.

**Partial first-apply caution:** ephemeral values are deliberately unrecoverable from state. If the SQL user was created but its connection-secret write failed, stop and inspect before retrying: regenerated values are not proof of the password already installed. Recover the original password from an operator's secure source, or recreate only an empty disposable stack. Never recreate a populated database or rotate its encryption key as a recovery shortcut. Secret deletion/replacement likewise requires an explicit recovery procedure.

**Earlier stacks adopting write-only mode:** explicitly keep `write_only_secrets = false` until an operator has retrieved the exact current values securely. Supply all current `DATABASE_PASSWORD`, `BETTER_AUTH_SECRET`, `DEN_DB_ENCRYPTION_KEY`, `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE`, plus any configured `SMTP_PASS`/`RESEND_API_KEY` and external `DATABASE_URL` through ephemeral `preserved_secrets_wo`. Keep non-secret SMTP configuration unchanged. Review the plan in maintenance; then enable `write_only_secrets`. Switching fields can create a new Secret Manager version, so the supplied values must be identical. Do not toggle back. Historical state backups still contain legacy secrets and must follow your retention/security policy. This is an operator-assisted migration, not an automatic no-downtime adoption promise.

## Secrets and later runs

- **Later applies and upgrades do not rotate secrets or sign anyone out.** In the default write-only mode, values are written once and tracked by a version number. Later evaluations may generate temporary candidate values, but unchanged version numbers keep the stored values unchanged. The 2026-10-15 live release-to-dev run already tested this exact mode; making it the default does not require another live deployment.
- **Rotation is deliberate.** Increase the relevant `*_version` input only when you intend to rotate: `secret_data_wo_version` selects a secret by its environment-variable name, and `database_password_wo_version` controls the SQL password. A change that forces replacement of a secret version resource can also write a new value. Do not decrease or reset counters: any counter change can cause a write. Rotate the SQL password and its `DATABASE_URL` secret together, in the same apply; do not rotate just the URL with a newly generated password that the database did not adopt.
- **Rotating `BETTER_AUTH_SECRET` signs everyone out. Rotating `DEN_DB_ENCRYPTION_KEY` makes stored credentials unreadable: never rotate it without a re-encryption procedure.** There is no automatic re-encryption procedure in this module.
- **Secret Manager is now the only managed copy of generated values.** Terraform state cannot recover them. Protect the secret store from deletion, restrict access and include its values in your backup and disaster-recovery plan. Database backups alone are not a backup of the encryption key.
- **Terraform and OpenTofu no longer detect manual edits of these values.** Write-only fields are not saved for comparison; an unchanged version number does not reconcile an out-of-band value change.
- **Losing state or recreating the secret resources can regenerate values.** Restore state and secret backups or carefully import existing resources before applying; do not treat an empty state as permission to regenerate a populated installation's keys. Resource replacement is not a harmless refresh.
- Both Terraform and OpenTofu need **version 1.11 or later** (and below 2.0 for this module).

## State guidance

Use an encrypted, access-controlled remote backend (for example GCS with locking and least-privilege bucket access). Never commit state, plan files, secret tfvars, tokens or local logs. Write-only mode is the default and keeps generated values out of new state. The explicit, not-recommended legacy mode retains generated credentials in state; historical state snapshots need protection even after adoption. SMTP/Resend/legacy URL input paths remain ordinary sensitive inputs, so prefer ephemeral values where supported and protect state in either mode. Losing the DB encryption key makes stored credentials unreadable.

The reusable module does **not** ship a lockfile: Terraform and OpenTofu registry archives differ. `examples/complete/.terraform.lock.hcl` is a **Terraform** root lock. Terraform: `terraform init -lockfile=readonly`. To use OpenTofu, remove only the example lock in your own copied root and run `tofu init`, then `tofu init -lockfile=readonly`; commit that root's regenerated lock. When switching back, regenerate for Terraform. Do not combine both registries in one lock: both tools reject stale extra dependencies in read-only mode. CI checks both roots with this explicit regeneration, followed by read-only verification. Reusable provider constraints are bounded; production root modules own exact locked versions/checksums.

For an S3 backend outside this GCP example, use native `use_lockfile = true`, not a DynamoDB locking table. Configure backends only in roots.

## Cost notes

Defaults keep one API (1 vCPU / 2 GiB) and one web (1 vCPU / 1 GiB) instance warm plus a db-g1-small (1.7 GB) with 20 GB disk, backups, secrets and image cache. This is a smoke-test baseline, **not** HA or production load sizing. SQL, warm-instance rates, storage, egress and optional load balancer/IP charges vary; estimate current regional prices before apply. The old micro-based daily estimate is no longer applicable. Min instances zero reduces Cloud Run idle cost but adds sign-in cold starts. Disposable `examples/complete` disables deletion protection and backups; do not copy those choices into production. Direct VPC egress can keep a subnet busy for up to roughly two hours after service deletion: budget teardown time, and never force-delete someone else's resources.
