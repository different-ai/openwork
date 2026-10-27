# ---------------------------------------------------------------------------
# Required
# ---------------------------------------------------------------------------

variable "openwork_version" {
  description = "Release label. Defaults pins are 0.18.58; other releases require both explicit digest overrides. Never resolves a mutable tag."
  type        = string
  default     = "0.18.58"

  validation {
    condition = var.openwork_version == "0.18.58" || (
      (var.den_api_image != "" || var.den_api_image_digest != "sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e") &&
      (var.den_web_image != "" || var.den_web_image_digest != "sha256:b1543b2bb36df0a7c75d7dc18cdd773eb2e87df268169dcb1e284439299ada3f")
    )
    error_message = "For a release other than 0.18.58, supply both image references pinned by digest or both image digests."
  }
}

variable "resource_group_name" {
  description = "Existing resource group to deploy into. The module creates no resource group and no role assignments."
  type        = string
}

variable "owner_emails" {
  description = "Emails allowed to claim the organization at /setup."
  type        = list(string)

  validation {
    condition     = length(var.owner_emails) > 0
    error_message = "Set at least one owner email so the first administrator can be created."
  }
}

# ---------------------------------------------------------------------------
# Naming, location and images
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every resource name. Keep it short: Container App names are capped at 32 characters."
  type        = string
  default     = "openwork"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "location" {
  description = "Azure region. Empty uses the resource group's region."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "den_api_image" {
  description = "Full den-api image@sha256:digest reference (including private mirrors). Empty uses den_api_image_digest. Mutable tags are rejected."
  type        = string
  default     = ""
  validation {
    condition     = var.den_api_image == "" || can(regex("^.+@sha256:[a-f0-9]{64}$", var.den_api_image))
    error_message = "den_api_image must be empty or pinned with @sha256:<64 lowercase hex characters>."
  }
}

variable "den_web_image" {
  description = "Full den-web image@sha256:digest reference. Empty uses den_web_image_digest. Mutable tags are rejected."
  type        = string
  default     = ""
  validation {
    condition     = var.den_web_image == "" || can(regex("^.+@sha256:[a-f0-9]{64}$", var.den_web_image))
    error_message = "den_web_image must be empty or pinned with @sha256:<64 lowercase hex characters>."
  }
}

variable "den_api_image_digest" {
  description = "Immutable den-api digest; default is release 0.18.58."
  type        = string
  default     = "sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e"
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.den_api_image_digest))
    error_message = "den_api_image_digest must be sha256:<64 lowercase hex characters>."
  }
}

variable "den_web_image_digest" {
  description = "Immutable den-web digest; default is release 0.18.58."
  type        = string
  default     = "sha256:b1543b2bb36df0a7c75d7dc18cdd773eb2e87df268169dcb1e284439299ada3f"
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.den_web_image_digest))
    error_message = "den_web_image_digest must be sha256:<64 lowercase hex characters>."
  }
}

variable "registry" {
  description = "Private registry for mirrored images. server: for example myregistry.azurecr.io. Authenticate with identity (a user-assigned identity ID from user_assigned_identity_ids that already has AcrPull) or with username and registry_password. Null pulls the public ghcr.io images."
  type = object({
    server   = string
    identity = optional(string, "")
    username = optional(string, "")
  })
  default = null
  validation {
    condition     = var.registry == null ? true : (var.registry.identity == "" || var.registry.identity != var.key_vault_identity_id)
    error_message = "Use a registry-pull identity separate from key_vault_identity_id; the migration Job must not receive Key Vault access."
  }
}

variable "registry_password" {
  description = "Password for registry.username. Stored as a Container Apps secret."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Container Apps environment and network
# ---------------------------------------------------------------------------

variable "container_app_environment_id" {
  description = "ID of an existing Container Apps environment (same subscription) to run the apps in. Empty creates <name>-den. The apps are named <app_name_prefix>den-api and <app_name_prefix>den-web."
  type        = string
  default     = ""

  validation {
    condition     = var.container_app_environment_id == "" || can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.App/managedEnvironments/[^/]+$", var.container_app_environment_id))
    error_message = "container_app_environment_id must be a full resource ID (/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.App/managedEnvironments/<name>) or empty."
  }
}

variable "infrastructure_subnet_id" {
  description = "Existing subnet for a new Container Apps environment (/27 or larger, delegated to Microsoft.App/environments). Empty lets Azure manage the network; the apps then cannot reach a private database in your VNet. Ignored with container_app_environment_id."
  type        = string
  default     = ""
}

variable "internal_load_balancer_enabled" {
  description = "Create the environment with an internal load balancer only (VNet-only access; needs infrastructure_subnet_id and your own private DNS for the app hostnames). Used when creating the environment."
  type        = bool
  default     = false
}

variable "workload_profile_name" {
  description = "Workload profile the apps run on. The default Consumption profile exists in every environment the module creates. Set \"\" for an existing consumption-only (v1) environment."
  type        = string
  default     = "Consumption"
}

variable "create_log_analytics_workspace" {
  description = "Create <name>-den-logs for a new environment's logs. Set false and pass log_analytics_workspace_id to use your own, or leave that empty for no log destination."
  type        = bool
  default     = true
}

variable "log_analytics_workspace_id" {
  description = "Existing Log Analytics workspace for a new environment's logs. Used only with create_log_analytics_workspace = false."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retention of the created Log Analytics workspace (30-730)."
  type        = number
  default     = 30
}

variable "app_name_prefix" {
  description = "Prefix for the Container App names (den-api, den-web). Names must be unique in a resource group, so set it (for example \"openwork-\") when sharing a resource group or environment with another deployment. Changing it replaces the apps and their default hostnames."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([a-z][a-z0-9-]{0,22})?$", var.app_name_prefix))
    error_message = "app_name_prefix must be empty or up to 23 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "user_assigned_identity_ids" {
  description = "Existing user-assigned identities attached to both apps, for Key Vault references in extra_secrets or registry pulls. The module creates no role assignments: grant them access yourself (for example Key Vault Secrets User)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Public endpoint
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Custom hostname for Den web, for example openwork.example.com. Empty uses the app's default https://<app>.<environment domain> hostname, which already has a trusted certificate."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9-]+([.][a-z0-9-]+)+$", var.domain_name))
    error_message = "domain_name must be empty or a bare hostname such as openwork.example.com."
  }
}

variable "api_domain_name" {
  description = "Custom hostname for Den API. Empty uses api.<domain_name> when domain_name is set, otherwise the API app's default hostname."
  type        = string
  default     = ""
}

variable "custom_domain_certificate" {
  description = "PFX certificate (base64) covering domain_name and the API host, uploaded to the environment and bound to both apps. Required with domain_name. Create the DNS records from the custom_domain_dns_records output before you set domain_name."
  type = object({
    pfx_base64 = string
    password   = optional(string, "")
  })
  default   = null
  sensitive = true
}

variable "allowed_ingress_cidrs" {
  description = "Reserved for CIDR-restricted ingress; currently only [] is supported (no app-level IP filtering). Non-empty lists fail validation until den-web to den-api traffic under these restrictions is verified."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = length(var.allowed_ingress_cidrs) == 0
    error_message = "Non-empty allowed_ingress_cidrs is not supported: den-web to den-api calls under app-level IP restrictions have not been verified. Do not clear a required allow-list just to deploy; use a separately verified network boundary or defer deployment."
  }
}

# ---------------------------------------------------------------------------
# Organization and product flags
# ---------------------------------------------------------------------------

variable "org_name" {
  description = "Display name of the single organization."
  type        = string
  default     = "OpenWork"
}

variable "org_slug" {
  description = "URL slug of the single organization."
  type        = string
  default     = "default"
}

variable "initial_admin_bootstrap_code" {
  description = "One-time /setup code. Empty generates an ephemeral value written only to the cloud secret store. Read it locally from the app; it is not an output value."
  type        = string
  default     = ""
  sensitive   = true
  ephemeral   = true
}

variable "better_auth_secret" {
  description = "Optional preserved auth secret for adopting an existing prototype. Empty generates on creation; later applies do not overwrite without a version bump."
  type        = string
  default     = ""
  sensitive   = true
  ephemeral   = true
}

variable "db_encryption_key" {
  description = "Optional preserved encryption key for adoption. Never change/rotate without a reviewed re-encryption procedure."
  type        = string
  default     = ""
  sensitive   = true
  ephemeral   = true
}

variable "database_admin_password" {
  description = "Optional preserved managed-database password for adoption. Written only through write-only fields."
  type        = string
  default     = ""
  sensitive   = true
  ephemeral   = true
}

variable "allow_public_signup" {
  description = "Let anyone who can reach the site create an account."
  type        = bool
  default     = false
}

variable "require_email_verification" {
  description = "Require email verification at signup. Needs smtp or resend_api_key."
  type        = bool
  default     = false
}

variable "automations_enabled" {
  description = "Automations for the whole install (on by default; organization admins can turn Desktop or Cloud Automations off in Settings)."
  type        = bool
  default     = true
}

variable "dashboards_enabled" {
  description = "Enable Dashboards."
  type        = bool
  default     = false
}

variable "openwork_web_url" {
  description = "URL the dashboard's OpenWork Web button opens (DEN_WEB_OPENWORK_WEB_URL). Empty uses den-web's default (the hosted https://web.openworklabs.com)."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "Reviewed plaintext tuning only: LOG_LEVEL, SENTRY_LOG_LEVEL, DEN_OBSERVABILITY_BACKEND, OTEL_LOGS_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_TRACES_EXPORTER, LIFECYCLE_EMAILS_INTERVAL_MS, WORKER_PROVISIONING_RECONCILE_INTERVAL_MS, NODE_USE_ENV_PROXY, NODE_EXTRA_CA_CERTS, NO_PROXY and TZ. All other names must use extra_secrets or a dedicated input."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for name in keys(var.extra_environment) :
      contains(["LOG_LEVEL", "SENTRY_LOG_LEVEL", "DEN_OBSERVABILITY_BACKEND", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_TRACES_EXPORTER", "LIFECYCLE_EMAILS_INTERVAL_MS", "WORKER_PROVISIONING_RECONCILE_INTERVAL_MS", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "TZ"], name) &&
      !contains(keys(var.extra_secrets), name)
    ])
    error_message = "extra_environment accepts only the documented plaintext allowlist; credentials and unreviewed names must use extra_secrets or a dedicated input."
  }
}

variable "extra_secrets" {
  description = "Additional secret env vars for both apps: env var name => versionless Key Vault secret ID (https://<vault>.vault.azure.net/secrets/<name>). Read with key_vault_identity_id, which must already have access to the vault."
  type        = map(string)
  default     = {}
  validation {
    condition     = length(var.extra_secrets) == 0 || var.key_vault_identity_id != ""
    error_message = "extra_secrets requires key_vault_identity_id."
  }
  validation {
    condition     = alltrue([for name in keys(var.extra_secrets) : !contains(["DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE", "SMTP_PASS", "RESEND_API_KEY", "REGISTRY_PASSWORD"], name)])
    error_message = "extra_secrets adds distinct names; use the dedicated inputs/version counters for managed core secrets."
  }
}

variable "key_vault_identity_id" {
  description = "User-assigned identity (also listed in user_assigned_identity_ids) the apps use to read extra_secrets from Key Vault. Required when extra_secrets is set."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

variable "email_from" {
  description = "From address for transactional email."
  type        = string
  default     = ""
}

variable "smtp" {
  description = "SMTP relay (for example Azure Communication Services SMTP). Leave host empty to disable."
  type = object({
    host     = optional(string, "")
    port     = optional(number, 587)
    username = optional(string, "")
    password = optional(string, "")
    secure   = optional(bool, false)
  })
  default   = {}
  sensitive = true
}

variable "resend_api_key" {
  description = "Resend API key, an alternative to SMTP."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "create_database" {
  description = "Create an Azure Database for MySQL Flexible Server. Set false and pass database_url to use an existing database."
  type        = bool
  default     = true
}

variable "database_url" {
  description = "Existing mysql:// URL with verified TLS (?sslaccept=strict). Used only when create_database = false; stored as a Container Apps secret."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.database_url == "" || (can(regex("^mysql://[^?#]+[?]sslaccept=strict(&|$)", var.database_url)) && length(regexall("[?&]sslaccept=", var.database_url)) == 1 && !can(regex("[?&](sslmode|ssl-mode)=", var.database_url)))
    error_message = "database_url must start its query with one sslaccept=strict parameter and contain no conflicting SSL modes."
  }
}

variable "migration_database_url" {
  description = "Optional verified-TLS URL for a separately provisioned DDL principal on the same database as database_url. Empty preserves the shared managed principal. Only the migration Job receives it."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.migration_database_url == "" || (can(regex("^mysql://[^?#]+[?]sslaccept=strict(&|$)", var.migration_database_url)) && length(regexall("[?&]sslaccept=", var.migration_database_url)) == 1 && !can(regex("[?&](sslmode|ssl-mode)=", var.migration_database_url)))
    error_message = "migration_database_url must start its query with one sslaccept=strict parameter and contain no conflicting SSL modes."
  }
}

variable "database_network" {
  description = <<-EOT
    Private access for the MySQL server the module creates. Null creates it with public
    access reachable only from Azure services (test stacks). Private access cannot be
    changed after creation.
    subnet_id: existing subnet delegated to Microsoft.DBforMySQL/flexibleServers.
    create_private_dns_zone: create <name>-den.private.mysql.database.azure.com and link
    it to virtual_network_id (the VNet of both subnets). Set false and pass
    private_dns_zone_id (a zone ending in .mysql.database.azure.com, linked to that VNet)
    to use your own.
  EOT
  type = object({
    subnet_id               = string
    virtual_network_id      = optional(string, "")
    create_private_dns_zone = optional(bool, true)
    private_dns_zone_id     = optional(string, "")
  })
  default = null
}

variable "database" {
  description = "MySQL Flexible Server settings."
  type = object({
    name                  = optional(string, "openwork_den")
    sku_name              = optional(string, "B_Standard_B1ms")
    version               = optional(string, "8.4")
    storage_gb            = optional(number, 20)
    backup_retention_days = optional(number, 7)
    zone                  = optional(string)
    high_availability     = optional(string, "") # SameZone or ZoneRedundant; needs a General Purpose SKU
    tls_query             = optional(string, "sslaccept=strict")
  })
  default = {}

  validation {
    condition     = contains(["", "SameZone", "ZoneRedundant"], var.database.high_availability)
    error_message = "database.high_availability must be empty, SameZone or ZoneRedundant."
  }
  validation {
    condition     = var.database.tls_query == "sslaccept=strict"
    error_message = "database.tls_query must be sslaccept=strict (verified TLS); insecure legacy settings are no longer accepted."
  }
}

variable "database_password_recovery_acknowledged" {
  description = "Recovery-only acknowledgement for a surviving managed database with no recoverable cloud credential copy. Preserve its password through database_admin_password, or deliberately reset it with an explicit version bump. Never enable for routine applies."
  type        = bool
  default     = false
}

variable "secret_versions" {
  description = "Explicit write-only rotation gates. Later applies/upgrades do not rotate values. Bump only the intended counter; never bump db_encryption_key_version without a reviewed re-encryption procedure."
  type = object({
    database_password_version      = optional(number, 1)
    better_auth_secret_version     = optional(number, 1)
    db_encryption_key_version      = optional(number, 1)
    bootstrap_code_version         = optional(number, 1)
    smtp_password_version          = optional(number, 1)
    resend_api_key_version         = optional(number, 1)
    registry_password_version      = optional(number, 1)
    migration_database_url_version = optional(number, 1)
  })
  default = {}
  validation {
    condition     = alltrue([for version in values(var.secret_versions) : version >= 1 && version == floor(version)])
    error_message = "Secret version counters must be positive integers."
  }
}

variable "deletion_protection" {
  description = "Protect the managed database from out-of-band deletion with an Azure CanNotDelete lock. Terraform can remove its own lock during destroy; this is not a Terraform prevent_destroy guarantee."
  type        = bool
  default     = true
}

variable "migration_timeout_seconds" {
  description = "Migration Job deadline, with zero automatic retries. Observer allows another 120 seconds for ARM status propagation."
  type        = number
  default     = 1800
  validation {
    condition     = var.migration_timeout_seconds >= 120 && var.migration_timeout_seconds <= 3600
    error_message = "migration_timeout_seconds must be between 120 and 3600."
  }
}

variable "migration_deployment_id" {
  description = "Optional release identity to deliberately run a new migration with the same image. Inspect prior execution before changing; never use a timestamp."
  type        = string
  default     = ""
}

variable "existing_database_identifier" {
  description = "Stable non-secret identifier for an existing database. Change with database_url to trigger its migration; never put credentials here."
  type        = string
  default     = "external"
}

# ---------------------------------------------------------------------------
# Apps
# ---------------------------------------------------------------------------

variable "den_api" {
  description = "den-api size and replica count. Default 1 vCPU / 2 GiB / 1 replica. Replicas are API-only; migration is a separate singleton Job."
  type = object({
    cpu      = optional(number, 1)
    memory   = optional(string, "2Gi")
    replicas = optional(number, 1)
  })
  default = {}
}

variable "den_web" {
  description = "den-web size and replica count."
  type = object({
    cpu      = optional(number, 0.5)
    memory   = optional(string, "1Gi")
    replicas = optional(number, 1)
  })
  default = {}
}
