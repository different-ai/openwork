# ---------------------------------------------------------------------------
# Required
# ---------------------------------------------------------------------------

variable "openwork_version" {
  description = "Published OpenWork release to deploy, for example \"0.18.54\". Pins the chart and, through the chart appVersion, every image."
  type        = string
}

variable "web_origin" {
  description = "Public HTTPS origin of Den web, for example https://openwork.example.com. Den derives auth, CORS and MCP defaults from it."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+/?$", var.web_origin))
    error_message = "web_origin must be an https:// origin with no path."
  }
}

variable "database_url" {
  description = "MySQL 8 connection URL for den-api and migrations. Prefer ?sslmode=verify-full with custom_ca for a private CA."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.database_url, "mysql://")
    error_message = "database_url must be a mysql:// URL."
  }
}

variable "owner_emails" {
  description = "Emails allowed to claim the organization through the one-time /setup flow."
  type        = list(string)

  validation {
    condition     = length(var.owner_emails) > 0
    error_message = "Set at least one owner email so the first administrator can be created."
  }
}

variable "initial_admin_bootstrap_code" {
  description = "One-time code entered at /setup with an owner email. Works only while the database has no users."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.initial_admin_bootstrap_code) >= 16
    error_message = "Use at least 16 random characters, for example: openssl rand -hex 16."
  }
}

# ---------------------------------------------------------------------------
# Release
# ---------------------------------------------------------------------------

variable "namespace" {
  description = "Kubernetes namespace for the release."
  type        = string
  default     = "openwork-ee"
}

variable "create_namespace" {
  description = "Create the namespace. Set false when it already exists or is managed elsewhere."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name. Service names are derived from it."
  type        = string
  default     = "openwork-ee"
}

variable "chart_repository" {
  description = "OCI registry that hosts the openwork-ee chart. Change only when mirroring."
  type        = string
  default     = "oci://ghcr.io/different-ai/charts"
}

variable "chart_version" {
  description = "Chart version override. Empty uses openwork_version."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag override for mirrored images. Empty uses the chart appVersion."
  type        = string
  default     = ""
}

variable "image_pull_secret_names" {
  description = "Existing image pull Secrets, for a private mirror."
  type        = list(string)
  default     = []
}

variable "helm_timeout_seconds" {
  description = "Helm install/upgrade timeout. Must cover the migration Job, including a cold den-api image pull."
  type        = number
  default     = 1800
}

variable "atomic" {
  description = "Roll back a failed install or upgrade."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Labels for the namespace and Secret this module creates."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Organization and sign-in
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

variable "allow_public_signup" {
  description = "Let anyone who can reach the site create an account. Keep false for private deployments."
  type        = bool
  default     = false
}

variable "require_email_verification" {
  description = "Require email verification at signup. Needs smtp."
  type        = bool
  default     = false
}

variable "api_origin" {
  description = "Separate public Den API origin, for split-host ingress. Empty keeps the API under web_origin."
  type        = string
  default     = ""
}

variable "mcp_claim_namespace" {
  description = "Stable namespace for MCP token claims. Set before issuing tokens if the host may move."
  type        = string
  default     = ""
}

variable "allow_private_mcp_urls" {
  description = "Allow MCP servers on private addresses. Enable only inside a trusted private network."
  type        = bool
  default     = false
}

variable "automations_enabled" {
  description = "Enable Automations (opt-in for self-hosted)."
  type        = bool
  default     = false
}

variable "dashboards_enabled" {
  description = "Enable Dashboards (opt-in for self-hosted)."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Secrets and data stores
# ---------------------------------------------------------------------------

variable "existing_secret_name" {
  description = "Use an operator-managed Secret instead of creating one. It must hold env var keys: DATABASE_URL, BETTER_AUTH_SECRET, DEN_DB_ENCRYPTION_KEY, DEN_INITIAL_ADMIN_BOOTSTRAP_CODE and any SMTP_* or DATABASE_REDIS_URL values."
  type        = string
  default     = ""
}

variable "manage_secret_with_terraform" {
  description = "When existing_secret_name is empty: true writes the Secret with Terraform, false lets the chart render it from values."
  type        = bool
  default     = true
}

variable "better_auth_secret" {
  description = "Better Auth signing secret (32+ chars). Empty generates one and keeps it in Terraform state."
  type        = string
  default     = ""
  sensitive   = true
}

variable "den_db_encryption_key" {
  description = "Key for encrypted database columns (32+ chars). Empty generates one. Losing it makes encrypted values unreadable, so back up state."
  type        = string
  default     = ""
  sensitive   = true
}

variable "redis_url" {
  description = "Optional Redis URL for session and query caching. Prefer rediss://."
  type        = string
  default     = ""
  sensitive   = true
}

variable "redis_allow_insecure_internal" {
  description = "Accept a plain redis:// URL. Only for a private, non-public Redis endpoint."
  type        = bool
  default     = false
}

variable "email_from" {
  description = "From address for transactional email."
  type        = string
  default     = ""
}

variable "smtp" {
  description = "SMTP relay for transactional email. Leave host empty to disable email."
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

variable "custom_ca" {
  description = "Private CA bundle already in the namespace, trusted by all OpenWork Node processes (MySQL TLS, proxies). Set one of existing_secret or existing_config_map."
  type = object({
    existing_secret     = optional(string, "")
    existing_config_map = optional(string, "")
    key                 = optional(string, "ca.crt")
  })
  default = {}

  validation {
    condition     = !(var.custom_ca.existing_secret != "" && var.custom_ca.existing_config_map != "")
    error_message = "Set only one of custom_ca.existing_secret or custom_ca.existing_config_map."
  }
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "ingress" {
  description = "Ingress for Den web (and optionally a separate API host). Disable to expose Services through your own load balancer or mesh."
  type = object({
    enabled         = optional(bool, true)
    class_name      = optional(string, "")
    annotations     = optional(map(string), {})
    web_host        = optional(string, "")
    api_host        = optional(string, "")
    tls_secret_name = optional(string, "")
  })
  default = {}

  validation {
    condition     = !var.ingress.enabled || var.ingress.web_host != ""
    error_message = "ingress.web_host is required when ingress is enabled."
  }
}

# ---------------------------------------------------------------------------
# Workloads and observability
# ---------------------------------------------------------------------------

variable "den_api" {
  description = "den-api replicas, resources and extra env."
  type = object({
    replicas  = optional(number, 1)
    resources = optional(any, {})
    env       = optional(map(string), {})
  })
  default = {}
}

variable "den_web" {
  description = "den-web replicas, resources and extra env."
  type = object({
    replicas  = optional(number, 1)
    resources = optional(any, {})
    env       = optional(map(string), {})
  })
  default = {}
}

variable "observability" {
  description = "Runtime telemetry for den-api and den-web. backend is none, otel or sentry."
  type = object({
    backend             = optional(string, "none")
    otel_endpoint       = optional(string, "")
    otel_headers_secret = optional(string, "")
    sentry_dsn_secret   = optional(string, "")
    sentry_environment  = optional(string, "")
  })
  default = {}

  validation {
    condition     = contains(["none", "otel", "sentry"], var.observability.backend)
    error_message = "observability.backend must be none, otel or sentry."
  }
}

variable "extra_helm_values" {
  description = "Any other openwork-ee chart values (Gateway, provisioner, installer artifacts, probes). Deep-merged over the module's values by Helm."
  type        = any
  default     = {}
}
