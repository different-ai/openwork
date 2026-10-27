# openwork-azure-container-apps

## What it deploys

A single-organization Den control plane, without Kubernetes:

| Piece | Azure resource |
| --- | --- |
| API / web | Two HTTPS-only Container Apps, API-only application replicas |
| Migration | Manual Container Apps Job, parallelism/completions 1, retries 0 |
| Migration trigger | Native AzAPI `Microsoft.App/jobs/start`, once per API digest/database/deployment identity |
| Completion gate | Read-only Azure CLI observer of that exact execution; only `Succeeded` permits app rollout |
| Database | MySQL Flexible Server 8.4, private with supplied subnets, or an existing database |
| Secrets | Container Apps managed secrets and optional existing Key Vault references |
| Network / logs | New or existing Container Apps environment and Log Analytics workspace |
| Deletion protection | Default `CanNotDelete` ARM lock on the managed database |

Workbot, runners, Slack and OpenWork Web are not deployed. Existing product flag inputs remain accepted.

## Tested scenarios

| Date | Tools / providers | Release / scenario | Result |
| --- | --- | --- | --- |
| 2026-10-13 | Terraform 1.16, OpenTofu 1.11; AzureRM 5.0 / 5.9 | Legacy init-container module, 0.18.58, private MySQL, setup/browser/isolated desktop, destroy | Passed; not proof of the new Job topology |
| 2026-10-14 | Terraform 1.16.5 / OpenTofu 1.11.14; AzureRM 5.9 | Legacy module, 0.18.58 to dev, one API replica, retained administrator/org, browser/desktop, destroy | Passed; not a two-replica result |
| 2026-10-16 | Terraform 1.16.5 / OpenTofu 1.11.14; AzureRM 5.10, AzAPI 2.13, external 2.4, random 3.9 | Contract mocked tests, 33 runs on each tool; registry-specific example locks and fail-closed restricted-ingress guard | Passed |
| 2026-10-15 | Same providers | State-free defaults, two API replicas, 0.18.58 to dev ae7483e; setup, retained data/secrets/session, browser and isolated Electron | Passed; 15 managed resources destroyed, permanent log purge and empty inventories verified |

## Support level

> OpenWork's Terraform modules are **beta**. If you hit an issue:
> - **Customers with a support agreement:** contact your OpenWork team through your usual support channel.
> - **Everyone else:** [open a GitHub issue](https://github.com/different-ai/openwork/issues/new/choose).
> - **Security issues:** report them privately ([SECURITY.md](https://github.com/different-ai/openwork/blob/dev/SECURITY.md)).

The module is available on `dev` in **beta**. Follow the shared
[module contract](../../MODULE_CONTRACT.md) and pin the module to a reviewed commit.
Custom domains, private registries, Key Vault references and bring-your-own infrastructure have mocked coverage, not new live certification. This module does not implement application migration locking, interruption markers or schema compatibility manifests.

The migration **starts natively**, but terminal completion observation currently requires Python 3 and an already authenticated Azure CLI on the Terraform runner. AzAPI's ARM start long-running operation completes on acceptance, not migration success. A read-only `external` data source polls the returned execution's ARM status, bounded by the Job deadline plus 120 seconds, failing closed on errors. It never starts, retries or stops a Job. This is an explicit portability limitation, not a claim of a provider-native terminal waiter; replace it when AzureRM/AzAPI provides that waiter. Automation runners must support Azure CLI authentication as well as provider authentication.

The database lock protects out-of-band deletions. **Terraform destroy removes its own lock**; this is not `prevent_destroy`. AzureRM does not expose a MySQL server deletion-protection field. Keep production database state separate from application rollout state where stronger lifecycle separation is needed.

### Ingress restriction support

Only the empty `allowed_ingress_cidrs = []` default is supported; it performs **no app-level IP filtering**. Non-empty lists now fail variable validation rather than risk breaking den-web's server-side sign-in and `/setup` calls to den-api. This deliberately rejects a previously accepted, unverified prototype option. **Do not clear a required allow-list just to pass validation**: use a separately verified network boundary or defer deployment.

[Microsoft documents](https://learn.microsoft.com/azure/container-apps/connect-apps) that calls between apps in the same environment using the generated FQDN stay inside that environment. Therefore, adding public outbound IPs is not an established remedy. The [IP-restriction documentation](https://learn.microsoft.com/azure/container-apps/ip-restrictions) does not establish an exemption for this request path; restricted-CIDR sign-in/setup has not been live-certified here. An `.internal.` hostname belongs to an app configured with internal ingress; this module does not invent one while leaving external ingress enabled. The existing HTTPS route and empty default are unchanged.

## Before you start

- Terraform or OpenTofu **>= 1.11, < 2.0**, Python 3 and authenticated Azure CLI.
- An existing resource group. No role assignments or subscription registrations are created. Deployment needs resource creation plus `Microsoft.App/jobs/start/action` and Job execution read access. Default database protection additionally needs management-lock write/delete permission; a restricted Contributor role may need an administrator to manage that lock.
- Grant Job start only to trusted deployment identities: Azure's start API can override the execution image/command and use configured secrets/managed identities. Prefer explicit Job read/start/execution-read permissions over a wildcard `jobs/*/action` grant, which also permits secret listing. See [Azure Job permissions](https://learn.microsoft.com/azure/container-apps/jobs#permissions).
- Register `Microsoft.App`, `Microsoft.DBforMySQL`, `Microsoft.Network` and `Microsoft.OperationalInsights` once, using a subscription administrator.
- Recommended: an existing VNet, a `/27` or larger Container Apps subnet delegated to `Microsoft.App/environments`, and a separate MySQL subnet delegated to `Microsoft.DBforMySQL/flexibleServers`. Private access cannot be added to an existing server later.
- Azure creates its own `ME_...` infrastructure resource group; environment deletion owns its teardown.
- Apps and Job need outbound image-registry access. Private mirrors must also use `image@sha256:digest` and `registry` credentials/identity.
- No domain is required: default `azurecontainerapps.io` hostnames have trusted Microsoft HTTPS certificates. Custom domains require DNS verification and a PFX covering both hosts.

## Usage

```hcl
module "openwork" {
  source = "github.com/different-ai/openwork//infra/terraform/modules/openwork-azure-container-apps?ref=<reviewed-commit>"
  providers = {
    azapi             = azapi
    azapi.secret_read = azapi
  }

  openwork_version    = "0.18.58"
  owner_emails        = ["admin@example.com"]
  org_name            = "Example Organization"
  resource_group_name = "openwork-prod"
  infrastructure_subnet_id = azurerm_subnet.apps.id
  database_network = {
    subnet_id          = azurerm_subnet.mysql.id
    virtual_network_id = azurerm_virtual_network.this.id
  }
  den_api = { replicas = 2 }
}
```

Declare `Azure/azapi ~> 2.13` in your root and pass the same authenticated provider to both bindings above (or a separate trusted secret-read configuration). The module declares aliases but configures no providers. `examples/complete` includes the complete root setup. The separate read binding also permits Terraform's mock tests to keep ephemeral-resource schemas real without making any cloud calls.

The default image pair is pinned to 0.18.58 digests, not resolved from mutable tags. For another release provide **both** image digest overrides (or full digest-pinned image references) together with its `openwork_version` label. Tag-only legacy overrides are deliberately rejected; replace them with their verified manifest digest.

After apply, check API `/ready` and web `/api/ready`: migration completion is gated, but ARM app creation still precedes app health. Read `den-initial-admin-bootstrap-code` locally from the API app's managed secrets (prefer the portal; for CLI, select only that name from `az containerapp secret list --show-values`, not the entire secret collection), open `setup_url`, and create the first administrator with an allowed email. Do not paste the secret into logs or chat. `bootstrap_code` is now a deprecated null output so it cannot persist a credential in state; `bootstrap_secret_name` identifies the cloud secret. Set OpenWork Desktop's control plane URL to `web_url`; `/api/runtime-config` advertises the API origin.

## Upgrade notes

**Legacy init-container handover requires maintenance, not an ordinary rolling apply.** A new singleton Job cannot fence an old migration-capable replica:

1. Inventory every owner sharing the physical database: old revisions, Jobs, manual migrators and other installations. Freeze deployments, autoscale/replacement, retries and manual schema changes. Back up and verify recovery access.
2. Stop/drain every old migration-capable API revision and any other database consumer whose compatibility cannot be established. Scaling a min replica setting alone is not proof: disable replacement/activation sources, await terminal containers, and verify old DB sessions and in-flight DDL are gone.
3. Fence stale migration credentials after sessions terminate. Prefer separate migration DDL and application DML users. The managed database currently shares its admin principal; automatic user provisioning remains a follow-up. With an existing database, supply a separately provisioned DDL principal in `migration_database_url` and an app DML principal in `database_url`; the module verifies that both target the same host/port/schema. The Job receives only database/encryption secrets, not app authentication or email credentials. **Do not start the new Job if exclusion cannot be established.**
4. Apply the digest-pinned Job-only migration topology. One native start produces an execution ID; the exact execution must reach `Succeeded` before either app changes. Failure, unknown status or timeout blocks rollout. Inspect the retained execution before any manual retry; never blindly replace a failed start resource.
5. Resume API-only replicas and verify data/readiness/sign-in. Never roll back to a migration-capable legacy definition or reactivate its credentials. This module does not certify mixed-version schema compatibility or automatic schema rollback.

Fresh installs have no legacy migrators, but still need one coordinator per physical schema. API digest, database identifier or sensitive connection-URL hash changes replace the native start action; a receipt for a previous database is never reused just because its display identifier stayed the same. `migration_deployment_id` permits a deliberate same-image attempt after operator inspection; never set it to a timestamp. Scaling app replicas does not create another migration execution.

**Additional prototype hardening:** `extra_environment` now accepts only the reviewed plaintext tuning allowlist documented on that input; credential-bearing or unreviewed names must use `extra_secrets` or a dedicated input. Registry pulls need an identity separate from `key_vault_identity_id`. The migration Job attaches only that registry identity, never the apps' Key Vault identity, even if duplicated in `user_assigned_identity_ids`. Recovery uses the Job's persisted application/dedicated-URL provenance: a prior dedicated DDL URL (or unknown provenance) is never reused as the app URL. Changing the credential role requires an explicit `migration_database_url_version` bump.

**Adopting an older unmerged prototype is not a direct apply.** This module was not released; app/Job resource ownership changes from AzureRM to AzAPI to avoid AzureRM's readable secret fields. Before adopting an existing installation, preserve its current cloud secret values, freeze/fence legacy migration owners as above, forget the old app state bindings without destroying cloud resources and import those exact resources into the AzAPI addresses. Supply the unchanged values through the ephemeral `better_auth_secret`, `db_encryption_key`, `database_admin_password` and `initial_admin_bootstrap_code` inputs for the adoption apply. Do not let generated defaults replace an existing encryption key. Keep a protected recovery copy outside Terraform and verify an unchanged-secret plan before proceeding. New installations use state-free defaults automatically. Existing database URLs must start their query with a single `?sslaccept=strict`; duplicate/conflicting or unverified TLS settings are rejected, including an encoded unverified parameter placed before the strict one. Put any other query parameters afterwards.

## State guidance

Use encrypted, access-controlled remote state and restrict state/plan/log access. Azure Blob state supports backend locking; configure the backend in the root, never inside this reusable module. If using an S3 backend, use `use_lockfile = true`, not DynamoDB locking.

**State-free secrets are the default, not an opt-in.** Ephemeral random values feed AzAPI `sensitive_body` and AzureRM's MySQL `administrator_password_wo`. Persistent app/Job bodies hold only secret names/references and non-secret deployment hashes. Existing values are recovered through ephemeral cloud reads. Independent `secret_versions.*_version` counters select deliberate rotations; full-resource PUTs resend the existing values through a write-only collection gate because Azure rejects name-only secret collections. No generated password resource or bootstrap-code value is persisted. Readable secret export operations are not Terraform data sources. Extra Key Vault references keep their values outside Terraform too; grant the supplied user-assigned identity vault access yourself. Optional custom-domain PFX material still uses the AzureRM certificate resource's sensitive arguments; that non-default provider path can retain certificate material in state and needs protected state or separately managed certificates.

## Secrets and later runs

- Later applies and image upgrades **do not rotate secrets or sign anyone out**. When rotation counters are unchanged, ephemeral reads recover the existing cloud values, including for a partially created app, rather than distributing newly generated credentials.
- Rotation happens only through an explicit `secret_versions.*_version` bump or a forced replacement of the corresponding resource. Keep counters positive and monotonic. **Never rotate the database encryption key without a reviewed re-encryption procedure.** Database-password rotation updates its URL copies too; perform rotations in maintenance and verify all consumers before reopening traffic. Forced app/Job/database replacement is not routine maintenance.
- The **Container Apps managed secret store is the only durable copy** of generated values (or Key Vault for supplied references). Protect it and keep secure recovery backups, including the database encryption key; state is not a secret backup. Restrict cloud secret-read/start access to trusted operators. Never log backup values.
- Manual edits to cloud secret values are not detected or reconciled by write-only fields. Changing an input value alone is not a rotation request; bump the intended version deliberately.
- Losing state, deleting the cloud secret store or forcing replacement can regenerate values and make existing encrypted data unreadable. Protect and back up state metadata as well as the secret store; recover existing values before any re-creation.
- Both **Terraform and OpenTofu require >= 1.11, < 2.0** for ephemeral/write-only support.

The default app stores contain four core secrets; optional email/registry secrets are added only when configured. The migration container receives only its database/encryption bindings and optional registry credentials, never app auth or email secrets. If a database survived a failed first apply before any cloud credential copy existed, the module fails closed. Preserve its password through the ephemeral input or deliberately reset it with a version bump, then use `database_password_recovery_acknowledged` for that recovery only. Do not acknowledge blindly. Changing an existing database URL also requires its explicit secret-version bump.

The reusable module has no lock file; the executable `examples/complete` root **does commit provider selections and signed-release checksums**. Its `.terraform.lock.hcl` is for Terraform. For OpenTofu, first copy `opentofu.lock.hcl` to `.terraform.lock.hcl` in that example root, then run `tofu init -lockfile=readonly`. The separate registry-specific locks pin AzAPI 2.13.0, AzureRM 5.10.0, external 2.4.2 and random 3.9.1. Do not combine the two registry namespaces: each CLI removes the other's unused entries. Choose one tool per deployment root and commit its selected lock; update it deliberately, never publish provider caches or state.

## Inputs and defaults

| Input | Default | Meaning |
| --- | --- | --- |
| `resource_group_name`, `owner_emails` | Required | Existing group; nonempty first-administrator email allowlist |
| `openwork_version` | `0.18.58` | Release label; non-default requires both explicit pins |
| `name`, `location`, `tags` | `openwork`, group region, `{}` | Resource prefix, region, Azure labels |
| `den_api_image`, `den_web_image` | `""` | Full image@digest overrides, including mirrors |
| `den_api_image_digest` | `sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e` | 0.18.58 API / migration pin |
| `den_web_image_digest` | `sha256:b1543b2bb36df0a7c75d7dc18cdd773eb2e87df268169dcb1e284439299ada3f` | 0.18.58 web pin |
| `registry`, `registry_password` | `null`, sensitive `""` | Existing private registry identity or username/password |
| `container_app_environment_id`, `infrastructure_subnet_id` | `""`, `""` | Existing environment or subnet for new environment; apps/Job inherit an existing environment's actual region |
| `internal_load_balancer_enabled`, `workload_profile_name` | `false`, `Consumption` | Internal-only ingress; workload profile |
| `create_log_analytics_workspace`, `log_analytics_workspace_id`, `log_retention_days` | `true`, `""`, `30` | New/existing log sink and retention |
| `app_name_prefix`, `user_assigned_identity_ids` | `""`, `[]` | App name namespace; preauthorized identities |
| `domain_name`, `api_domain_name`, `custom_domain_certificate` | `""`, `""`, `null` | Default HTTPS hosts or custom hostnames and sensitive PFX |
| `allowed_ingress_cidrs` | `[]` only | No app-level IP filtering; non-empty lists fail validation until restricted inter-app routing is verified |
| `org_name`, `org_slug` | `OpenWork`, `default` | Organization display name and slug |
| `initial_admin_bootstrap_code` | Ephemeral generation, preserved in cloud | Ephemeral optional one-time setup code |
| `better_auth_secret`, `db_encryption_key`, `database_admin_password` | Ephemeral generation, preserved in cloud | Ephemeral preservation inputs for adoption; never state outputs |
| `secret_versions` | All `*_version` counters `1` | Explicit independent database/auth/encryption/bootstrap/SMTP/Resend/registry/migration-URL rotation gates |
| `database_password_recovery_acknowledged` | `false` | Recovery-only acknowledgement after explicitly preserving/resetting a surviving database's credential; never a routine-apply option |
| `allow_public_signup`, `require_email_verification` | `false`, `false` | Public enrollment and email requirement |
| `automations_enabled`, `dashboards_enabled`, `openwork_web_url` | `false`, `false`, `""` | Preserved legacy product inputs |
| `extra_environment`, `extra_secrets`, `key_vault_identity_id` | `{}`, `{}`, `""` | Non-secret env; env-to-Key-Vault-ID map; preauthorized identity |
| `email_from`, `smtp`, `resend_api_key` | `""`, `{}`, sensitive `""` | Email optional; SMTP defaults port 587, secure false, other fields empty |
| `create_database`, `database_url`, `database_network` | `true`, sensitive `""`, `null` | Managed or existing verified-TLS database; private network object |
| `migration_database_url` | Sensitive `""` | Optional separately provisioned DDL principal for the same database; Job-only |
| `database` | Schema `openwork_den`, B1ms, MySQL 8.4, 20 GiB, 7-day backups, zone unset, HA off, `sslaccept=strict` | Managed database settings; preserve `database.name` on upgrade because changing it replaces the schema |
| `database_network` members | subnet required; VNet `""`; create DNS `true`; DNS ID `""` | Existing subnet/VNet, or an existing linked private DNS zone |
| `deletion_protection` | `true` | Out-of-band database deletion lock; Terraform destroy caveat above |
| `den_api`, `den_web` | 1 vCPU / 2 GiB / 1 replica; 0.5 vCPU / 1 GiB / 1 replica | App reservations and fixed min/max replicas |
| `migration_timeout_seconds`, `migration_deployment_id` | `1800`, `""` | Bounded Job deadline (120–3600); deliberate release identity |
| `existing_database_identifier` | `external` | Non-secret stable ID; change with existing database to rerun migration |

## Outputs

| Output | Meaning |
| --- | --- |
| `web_url`, `api_url` | Public HTTPS origins |
| `database_identifier`, `migration_step_identifier`, `migration_job_id`, `migration_execution_id` | Shared contract database and exact migration identities |
| `setup_url`, `bootstrap_secret_name`, `bootstrap_code` | Setup page, cloud secret name and deprecated null code output (no secret value in state) |
| `default_hostnames`, `custom_domain_dns_records` | App CNAME targets and Azure DNS verification records |
| `container_app_environment_id`, `app_names`, `outbound_ip_addresses` | Runtime infrastructure and outbound allowlist |
| `database_fqdn`, `database_server_name`, `log_analytics_workspace_id` | Preserved existing monitoring outputs |

## Tests

```bash
# Validate through the supported root, which binds the secret-read alias.
terraform -chdir=examples/complete init -backend=false -lockfile=readonly
terraform -chdir=examples/complete validate
terraform init -backend=false && terraform test
# Select the committed OpenTofu lock before switching tools in this example:
cp examples/complete/opentofu.lock.hcl examples/complete/.terraform.lock.hcl
tofu -chdir=examples/complete init -backend=false -lockfile=readonly
tofu -chdir=examples/complete validate
tofu init -backend=false && tofu test
```

Mocks never contact Azure. `python3 scripts/test-wait-for-migration.py` runs five credential-free success/failure/timeout controls for the read-only observer, without requiring Azure CLI or an account. Run the HCL suite with both tools as above. Native testkit driver evidence is retained with the conformance report; local-only legacy/live drivers are not added to the retired CI spec path or made to require a live deployment in application CI.

## Cost notes

Regional capacity may reject new environments with `ManagedEnvironmentCapacityHeavyUsageError`. The conformance run's first eastus attempt failed this way; after full failed-stack cleanup, one fresh eastus retry succeeded. No existing environment was reused and no region switch was needed. An alternate authorized region may be necessary for another deployment; clean up the failed attempt before switching.

The earlier one-replica test measured under USD 1 estimated for a short session, not a settled bill. Rough always-on East US defaults were estimated at USD 2–4/day before logs/traffic; these are not production quotes. Two API replicas increase consumption. The migration Job is short-lived; Azure may retain execution history. Use Azure pricing and your plan's actual reservations before committing spend.

`examples/complete` explicitly supports disabling deletion protection for disposable runs. Run long applies/destroys detached and poll completion. Environment deletion previously took 25–28 minutes; Log Analytics must be permanently purged, not merely soft deleted. After destroy verify the resource inventory and deleted-workspace inventory, then remove local state and generated secrets.
