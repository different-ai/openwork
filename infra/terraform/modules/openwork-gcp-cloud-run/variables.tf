# ---------------------------------------------------------------------------
# Required
# ---------------------------------------------------------------------------

variable "project_id" {
  description = "Google Cloud project to deploy into."
  type        = string
}

variable "openwork_version" {
  description = "Published OpenWork release, for example \"0.18.58\". Selects the release; the images themselves are pinned with image_digests. Needs 0.18.57 or later (Cloud SQL socket support in DATABASE_URL)."
  type        = string
}

variable "owner_emails" {
  description = "Emails allowed to claim the organization at /setup. They are also Den platform administrators (DEN_BOOTSTRAP_ADMIN_EMAILS), as in docs/gcp-cloud-run.md."
  type        = list(string)

  validation {
    condition     = length(var.owner_emails) > 0
    error_message = "Set at least one owner email so the first administrator can be created."
  }
}

# ---------------------------------------------------------------------------
# Naming, location and images
# ---------------------------------------------------------------------------

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and Artifact Registry."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Prefix for every resource name. Keep it short: service account IDs are capped at 30 characters."
  type        = string
  default     = "openwork"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "labels" {
  description = "Labels applied to every resource that supports them."
  type        = map(string)
  default     = {}
}

variable "create_image_mirror" {
  description = "Create an Artifact Registry remote repository (<name>-ghcr) that proxies ghcr.io, so Cloud Run can pull the published images (Cloud Run cannot pull from ghcr.io directly). Ignored for an image you set in den_api_image / den_web_image."
  type        = bool
  default     = true
}

variable "den_api_image" {
  description = "Full den-api image reference in Artifact Registry (or another registry Cloud Run can pull from), pinned as <image>@sha256:<digest>. Empty uses the ghcr.io mirror: <region>-docker.pkg.dev/<project>/<name>-ghcr/different-ai/openwork-den-api@<image_digests.den_api>."
  type        = string
  default     = ""
  nullable    = false
}

variable "image_digests" {
  description = "Digests (sha256:...) of the published den-api and den-web images for openwork_version, so Cloud Run runs exactly that build even if a tag is moved upstream. Required unless allow_mutable_image_tags is set. The README shows how to read them."
  type = object({
    den_api = optional(string, "")
    den_web = optional(string, "")
  })
  default  = {}
  nullable = false

  validation {
    condition     = alltrue([for d in [var.image_digests.den_api, var.image_digests.den_web] : d == "" || can(regex("^sha256:[a-f0-9]{64}$", d))])
    error_message = "image_digests values must be sha256:<64 hex characters>."
  }
}

variable "allow_mutable_image_tags" {
  description = "Allow images referenced by tag: the published images without image_digests, or a den_api_image / den_web_image without @sha256:. Not recommended: whoever can move the tag upstream decides what code runs with this deployment's secrets."
  type        = bool
  default     = false
}

variable "den_web_image" {
  description = "Full den-web image reference, pinned as <image>@sha256:<digest>. Empty uses the ghcr.io mirror, like den_api_image."
  type        = string
  default     = ""
  nullable    = false
}

variable "service_account_email" {
  description = "Existing service account for the Cloud Run services and migration job. Empty creates <name>-den-run. The module grants it roles/cloudsql.client on the project and read access to each secret it uses."
  type        = string
  default     = ""
  nullable    = false
}

variable "grant_iam_roles" {
  description = "Grant the service account roles/cloudsql.client on the project and roles/secretmanager.secretAccessor on each secret. Set false when your platform team grants these (the apply then needs no IAM permissions); the service account must have them before apply."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protect Cloud SQL, Cloud Run services and the migration job from destroy. Set false for disposable stacks. The deprecated database.deletion_protection override takes precedence when set."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Public endpoint
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Public hostname for Den web, for example openwork.example.com. Empty uses the services' default https://<service>-<project number>.<region>.run.app URLs, which are HTTPS already. When set, the module creates a global external HTTPS load balancer for domain_name and api_domain_name."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9-]+([.][a-z0-9-]+)+$", var.domain_name))
    error_message = "domain_name must be empty or a bare hostname such as openwork.example.com."
  }
}

variable "api_domain_name" {
  description = "Public hostname for Den API when domain_name is set. Empty uses api.<domain_name>."
  type        = string
  default     = ""
  nullable    = false
}

variable "ssl_certificate_ids" {
  description = "Existing global SSL certificates (self links or IDs) covering both hostnames. Empty creates a Google-managed certificate, which becomes active once both hostnames resolve to the load_balancer_ip output."
  type        = list(string)
  default     = []
}

variable "load_balancer_ip_address" {
  description = "Existing global static external IPv4 address (the address itself, for example 34.120.0.1) for the load balancer. Empty reserves one (<name>-den-lb)."
  type        = string
  default     = ""
  nullable    = false
}

variable "restrict_ingress_to_load_balancer" {
  description = "With domain_name, accept traffic only through the load balancer: services use INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER and the default run.app URLs are disabled."
  type        = bool
  default     = false
}

variable "public_access" {
  description = "Let anyone reach the services without Google IAM (invoker_iam_disabled). Den does its own sign-in, so this is required for browsers and the desktop app; it also works where an organization policy forbids allUsers bindings."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "network" {
  description = "Existing VPC network (name or self link) for Direct VPC egress from the services and migration job. Empty sends egress straight to the internet. Required for a Cloud SQL instance with only a private IP."
  type        = string
  default     = ""
  nullable    = false
}

variable "subnetwork" {
  description = "Subnetwork in region for Direct VPC egress. Required with network."
  type        = string
  default     = ""
  nullable    = false
}

variable "vpc_egress" {
  description = "Which egress goes through the VPC with network set: PRIVATE_RANGES_ONLY (internet traffic, such as ghcr.io and model providers, leaves directly) or ALL_TRAFFIC (needs Cloud NAT on the VPC)."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"

  validation {
    condition     = contains(["PRIVATE_RANGES_ONLY", "ALL_TRAFFIC"], var.vpc_egress)
    error_message = "vpc_egress must be PRIVATE_RANGES_ONLY or ALL_TRAFFIC."
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
  description = "One-time /setup code. Empty generates one in Secret Manager. bootstrap_code returns a value only in the explicit legacy mode."
  type        = string
  default     = ""
  sensitive   = true
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
  description = "Enable Automations."
  type        = bool
  default     = false
}

variable "dashboards_enabled" {
  description = "Enable Dashboards."
  type        = bool
  default     = false
}

variable "write_only_secrets" {
  description = "Use ephemeral random passwords and provider write-only arguments so generated secrets never enter state (default). False is a not-recommended legacy compatibility mode. For an experimental deployment already using legacy mode, preserve its exact values before switching; see Secrets and later runs."
  type        = bool
  default     = true
}

variable "database_password_wo_version" {
  description = "Write-only database password version. Keep unchanged on ordinary applies/upgrades. Increasing it rotates the password; coordinate DATABASE_URL's secret_data_wo_version in the same apply."
  type        = number
  default     = 1
  validation {
    condition     = var.database_password_wo_version >= 1 && floor(var.database_password_wo_version) == var.database_password_wo_version
    error_message = "database_password_wo_version must be a positive integer."
  }
}

variable "secret_data_wo_version" {
  description = "Write-only version per secret env name; omitted names use 1. Increase only for deliberate rotation. Auth rotation signs everyone out. Never rotate DEN_DB_ENCRYPTION_KEY without a re-encryption procedure."
  type        = map(number)
  default     = {}
  validation {
    condition     = alltrue([for version in values(var.secret_data_wo_version) : version >= 1 && floor(version) == version])
    error_message = "secret_data_wo_version values must be positive integers."
  }
}

variable "preserved_secrets_wo" {
  description = "Ephemeral overrides when adopting write_only_secrets: DATABASE_PASSWORD, BETTER_AUTH_SECRET, DEN_DB_ENCRYPTION_KEY and DEN_INITIAL_ADMIN_BOOTSTRAP_CODE (and DATABASE_URL for an existing database). Supply the current values from your secret manager, never literals in committed tfvars. Ignored in legacy mode."
  type        = map(string)
  default     = {}
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = alltrue([for k, v in var.preserved_secrets_wo : k != "DATABASE_URL" || (!can(regex("(?i)(sslaccept=(accept|accept_invalid_certs)|sslmode=disable)", v)) && (strcontains(v, "socket=") || strcontains(v, "sslaccept=strict")))])
    error_message = "Preserved DATABASE_URL must use the authenticated connector socket or verified TLS."
  }
}

variable "extra_environment" {
  description = "Additional non-secret env vars for den-api, den-web and the migration job. Put credentials in extra_secrets, never here."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k in keys(var.extra_environment) : !can(regex("(?i)(SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY|BOOTSTRAP_CODE|DATABASE_URL|SMTP_PASS)", k)) && !contains(keys(var.extra_secrets), k)])
    error_message = "Credentials and extra_secrets keys must not be passed as plain extra_environment values. Use Secret Manager references."
  }
}

variable "extra_secrets" {
  description = "Additional secret env vars for den-api, den-web and the migration job: env var name => Secret Manager secret ID (projects/<project>/secrets/<name>, or a name in project_id). The latest version is used; the service account is granted read access."
  type        = map(string)
  default     = {}
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
  description = "SMTP relay. Leave host empty to disable."
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
  description = "Create a Cloud SQL for MySQL 8.4 instance. Set false and pass database_url (and cloud_sql_connection_name for an existing Cloud SQL instance) to use an existing database."
  type        = bool
  default     = true
}

variable "database_url" {
  description = "mysql:// URL of an existing database. Must use the authenticated Cloud SQL socket connector or sslaccept=strict verified TLS. In write-only mode prefer preserved_secrets_wo.DATABASE_URL to keep it out of state."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.database_url == "" || (!can(regex("(?i)(sslaccept=(accept|accept_invalid_certs)|sslmode=disable)", var.database_url)) && (strcontains(var.database_url, "socket=") || strcontains(var.database_url, "sslaccept=strict")))
    error_message = "Existing database URLs must use the authenticated connector socket or verified sslaccept=strict TLS."
  }
}

variable "cloud_sql_connection_name" {
  description = "PROJECT:REGION:INSTANCE of an existing Cloud SQL instance to mount at /cloudsql in every container, for a database_url that uses ?socket=. Used only when create_database = false."
  type        = string
  default     = ""
  nullable    = false
}

variable "database" {
  description = "Cloud SQL settings. den-api reaches the instance through Cloud Run's Cloud SQL connector (IAM-authorized, verified TLS). For a private-IP instance or another database, set create_database = false and pass database_url."
  type = object({
    tier                = optional(string, "db-g1-small")
    edition             = optional(string, "ENTERPRISE")
    database_version    = optional(string, "MYSQL_8_4")
    disk_size_gb        = optional(number, 20)
    availability_type   = optional(string, "ZONAL")
    backup_enabled      = optional(bool, true)
    deletion_protection = optional(bool) # Deprecated alias; null uses deletion_protection.
  })
  default = {}
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

variable "den_api" {
  description = "den-api Cloud Run sizing."
  type = object({
    cpu           = optional(string, "1")
    memory        = optional(string, "2Gi")
    min_instances = optional(number, 1)
    max_instances = optional(number, 3)
  })
  default = {}
}

variable "den_web" {
  description = "den-web Cloud Run sizing."
  type = object({
    cpu           = optional(string, "1")
    memory        = optional(string, "1Gi")
    min_instances = optional(number, 1)
    max_instances = optional(number, 3)
  })
  default = {}
}

variable "migration_run_id" {
  description = "Change this value to run the migration job again on the next apply. It also runs whenever the den-api image changes."
  type        = string
  default     = "1"
}
