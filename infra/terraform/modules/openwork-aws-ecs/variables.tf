# ---------------------------------------------------------------------------
# Required
# ---------------------------------------------------------------------------

variable "openwork_version" {
  description = "Published OpenWork release, for example \"0.18.54\". Used as the tag for both images unless den_api_image / den_web_image are set."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into."
  type        = string
}

variable "alb_subnet_ids" {
  description = "Subnets for the load balancer (public subnets for an internet-facing ALB). At least two AZs."
  type        = list(string)
}

variable "service_subnet_ids" {
  description = "Subnets for the Fargate tasks. Private subnets need a NAT gateway or VPC endpoints to pull images from ghcr.io; public subnets need assign_public_ip = true."
  type        = list(string)
}

variable "database_subnet_ids" {
  description = "Subnets for RDS and ElastiCache. At least two AZs. Ignored when create_database = false and create_redis = false."
  type        = list(string)
  default     = []
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
# Naming and images
# ---------------------------------------------------------------------------

variable "name" {
  description = "Prefix for every resource name. Keep it short: ALB and target group names are capped at 32 characters."
  type        = string
  default     = "openwork"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name))
    error_message = "name must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "den_api_image" {
  description = "Full den-api image reference. Empty uses ghcr.io/different-ai/openwork-den-api:<openwork_version>. Set this to an ECR mirror if tasks cannot reach ghcr.io."
  type        = string
  default     = ""
}

variable "den_web_image" {
  description = "Full den-web image reference. Empty uses ghcr.io/different-ai/openwork-den-web:<openwork_version>."
  type        = string
  default     = ""
}

variable "ecs_cluster_arn" {
  description = "ARN of an existing ECS cluster (same region) to run the services in. Empty creates <name>-den. The services use the FARGATE launch type, so the cluster needs no capacity providers of its own."
  type        = string
  default     = ""

  validation {
    condition     = var.ecs_cluster_arn == "" || can(regex("^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/.+$", var.ecs_cluster_arn))
    error_message = "ecs_cluster_arn must be a full ECS cluster ARN (arn:aws:ecs:<region>:<account>:cluster/<name>) or empty."
  }
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64 (Graviton). The published images support both."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

# ---------------------------------------------------------------------------
# Public endpoint
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Public hostname for Den web, for example openwork.example.com. Den requires HTTPS outside dev mode, so a domain and certificate are mandatory."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+([.][a-z0-9-]+)+$", var.domain_name))
    error_message = "domain_name must be a bare hostname such as openwork.example.com."
  }
}

variable "api_domain_name" {
  description = "Public hostname for Den API. Empty uses api.<domain_name>, which is what Den derives by default."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ACM certificate (same region) covering domain_name and api_domain_name. Empty creates and DNS-validates one in route53_zone_id."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for both hostnames. When set, the module creates alias records and, if certificate_arn is empty, the ACM certificate. Leave empty when DNS is elsewhere; point both names at the alb_dns_name output."
  type        = string
  default     = ""
}

variable "internal_alb" {
  description = "Create an internal ALB, reachable only inside the VPC (VPN/private network deployments)."
  type        = bool
  default     = false
}

variable "allowed_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "assign_public_ip" {
  description = "Give tasks public IPs. Needed when service_subnet_ids are public subnets without a NAT gateway."
  type        = bool
  default     = false
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
  description = "One-time /setup code. Empty generates one (see the bootstrap_code output)."
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

variable "openwork_web_enabled" {
  description = "Enable OpenWork Web (cloud chat sessions). Needs a sandbox provider: set provisioner_mode = \"daytona\" and pass DAYTONA_API_KEY through extra_secrets."
  type        = bool
  default     = false
}

variable "openwork_web_url" {
  description = "URL the dashboard's OpenWork Web button opens (DEN_WEB_OPENWORK_WEB_URL). Empty keeps den-web's default, which is the hosted https://web.openworklabs.com, not your deployment."
  type        = string
  default     = ""
}

variable "provisioner_mode" {
  description = "Sandbox provider for OpenWork Web: stub (none), daytona or render."
  type        = string
  default     = "stub"
}

variable "extra_environment" {
  description = "Additional plain env vars for both den-api and den-web, for example DAYTONA_API_URL or DEN_TRUSTED_PROXIES. See ee/apps/den-api/.env.example."
  type        = map(string)
  default     = {}
}

variable "extra_secrets" {
  description = "Additional secret env vars for both services: env var name => Secrets Manager or SSM parameter ARN (append :json-key:: for a JSON key). The execution role is granted read access."
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
  description = "SMTP relay (for example Amazon SES SMTP). Leave host empty to disable."
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
# Database and cache
# ---------------------------------------------------------------------------

variable "create_database" {
  description = "Create an RDS MySQL 8.4 instance. Set false and pass database_url to use an existing database."
  type        = bool
  default     = true
}

variable "database_url" {
  description = "mysql:// URL of an existing database. Used only when create_database = false."
  type        = string
  default     = ""
  sensitive   = true
}

variable "database" {
  description = "RDS settings."
  type = object({
    instance_class        = optional(string, "db.t4g.micro")
    engine_version        = optional(string, "8.4")
    allocated_storage_gb  = optional(number, 20)
    max_allocated_storage = optional(number, 100)
    multi_az              = optional(bool, false)
    backup_retention_days = optional(number, 7)
    deletion_protection   = optional(bool, true)
    skip_final_snapshot   = optional(bool, false)
    apply_immediately     = optional(bool, false)
    tls_query             = optional(string, "sslaccept=accept")
  })
  default = {}
}

variable "create_redis" {
  description = "Create a single-node ElastiCache Redis (TLS) for session and query caching. Optional; Den runs without it."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

variable "den_api" {
  description = "den-api task size and count. Keep desired_count = 1 until you have confirmed migrations: each task runs them on start."
  type = object({
    cpu           = optional(number, 1024)
    memory        = optional(number, 2048)
    desired_count = optional(number, 1)
  })
  default = {}
}

variable "den_web" {
  description = "den-web task size and count."
  type = object({
    cpu           = optional(number, 512)
    memory        = optional(number, 1024)
    desired_count = optional(number, 1)
  })
  default = {}
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager recovery window on destroy. 0 deletes immediately."
  type        = number
  default     = 7
}
