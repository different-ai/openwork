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

variable "service_subnet_ids" {
  description = "Subnets for the Fargate tasks. Private subnets need a NAT gateway or VPC endpoints to pull images from ghcr.io; public subnets need assign_public_ip = true."
  type        = list(string)
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
# Load Balancer
# ---------------------------------------------------------------------------

variable "load_balancer_arn" {
  description = "ARN of an existing Application Load Balancer. The module adds its HTTPS (443) and HTTP (80) listeners to it, so the ALB must not already listen on those ports; for a shared ALB, use alb_listener_arn instead. Requires alb_security_group_id. Empty creates an ALB (<name>-den) in alb_subnet_ids."
  type        = string
  default     = ""

  validation {
    condition     = var.load_balancer_arn == "" || can(regex("^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:loadbalancer/app/.+$", var.load_balancer_arn))
    error_message = "load_balancer_arn must be a full Application Load Balancer ARN (arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>) or empty."
  }
}

variable "alb_subnet_ids" {
  description = "Subnets for the load balancer (public subnets for an internet-facing ALB). At least two AZs. Required when creating an ALB (load_balancer_arn is empty)."
  type        = list(string)
  default     = []
}

variable "internal_alb" {
  description = "Create an internal ALB, reachable only inside the VPC (VPN/private network deployments). Used when creating an ALB."
  type        = bool
  default     = false
}

variable "alb_listener_arn" {
  description = "ARN of an existing ALB HTTPS listener (for example on a shared ALB). The module adds host-header rules for domain_name and the API host to it instead of creating listeners, and creates no DNS records. Takes precedence over load_balancer_arn. Requires alb_security_group_id."
  type        = string
  default     = ""

  validation {
    condition     = var.alb_listener_arn == "" || can(regex("^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:listener/app/.+$", var.alb_listener_arn))
    error_message = "alb_listener_arn must be a full ALB listener ARN (arn:aws:elasticloadbalancing:<region>:<account>:listener/app/<name>/<id>/<id>) or empty."
  }
}

variable "alb_security_group_id" {
  description = "Security group of the load balancer. Required with load_balancer_arn or alb_listener_arn so the tasks accept traffic from it. When the module creates the ALB, empty creates a security group allowing 80/443 from allowed_ingress_cidrs; set it to attach your own instead."
  type        = string
  default     = ""
}

variable "api_listener_rule_priority" {
  description = "Priority of the den-api host rule on the HTTPS listener. Must be unique on that listener; change it when using alb_listener_arn on a listener that already has rules."
  type        = number
  default     = 10
}

variable "web_listener_rule_priority" {
  description = "Priority of the den-web host rule, created only with alb_listener_arn. Must be unique on that listener."
  type        = number
  default     = 20
}

variable "attach_listener_certificate" {
  description = "With alb_listener_arn, also add the certificate (certificate_arn, or the one the module creates) to that listener. Leave false when the listener's certificates already cover both hostnames."
  type        = bool
  default     = false
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

variable "den_gateway_image" {
  description = "Full den-gateway image reference. Empty uses ghcr.io/different-ai/openwork-den-gateway:<openwork_version>."
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
  description = "ACM certificate (same region) covering domain_name, api_domain_name, and openwork_web_domain_name when openwork_web_enabled. Empty creates and DNS-validates one in route53_zone_id."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for both hostnames. When set, the module creates alias records and, if certificate_arn is empty, the ACM certificate. Leave empty when DNS is elsewhere; point both names at the alb_dns_name output."
  type        = string
  default     = ""
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
  description = "Run OpenWork Web (chat in the browser, one Daytona sandbox per member) on this deployment: adds the den-gateway service at openwork_web_domain_name and points the dashboard's OpenWork Web button at it. Requires daytona_api_key and daytona.snapshot."
  type        = bool
  default     = false
}

variable "openwork_web_domain_name" {
  description = "Public hostname for OpenWork Web (den-gateway). Empty uses web.<domain_name>. Must be covered by certificate_arn; a module-created certificate includes it."
  type        = string
  default     = ""
}

variable "openwork_web_url" {
  description = "URL the dashboard's OpenWork Web button opens (DEN_WEB_OPENWORK_WEB_URL). Empty uses this deployment's gateway when openwork_web_enabled, otherwise den-web's default (the hosted https://web.openworklabs.com)."
  type        = string
  default     = ""
}

variable "openwork_web_listener_rule_priority" {
  description = "Priority of the den-gateway host rule on the HTTPS listener (created with openwork_web_enabled). Must be unique on that listener."
  type        = number
  default     = 30
}

variable "provisioner_mode" {
  description = "Sandbox provider (PROVISIONER_MODE): stub (none) or daytona. Empty picks daytona when openwork_web_enabled, otherwise stub."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "stub", "daytona"], var.provisioner_mode)
    error_message = "provisioner_mode must be empty, stub or daytona."
  }
}

variable "daytona_api_key" {
  description = "Daytona API key for OpenWork Web sandboxes. Required with openwork_web_enabled; stored in Secrets Manager."
  type        = string
  default     = ""
  sensitive   = true
}

variable "daytona" {
  description = <<-EOT
    Daytona settings for OpenWork Web sandboxes (daytona.io or a self-hosted Daytona).
    snapshot: required with openwork_web_enabled; a snapshot in the API key's Daytona
    organization built from the OpenWork sandbox image for openwork_version (see the
    README). name_prefix: prefix for sandbox and volume names; empty uses <name>, so
    deployments sharing one Daytona organization stay apart.
  EOT
  type = object({
    api_url     = optional(string, "https://app.daytona.io/api")
    snapshot    = optional(string, "")
    target      = optional(string, "")
    name_prefix = optional(string, "")
  })
  default = {}
}

variable "headless_runner" {
  description = <<-EOT
    The headless runner: Den's private agent service for Slack replies, headless
    Automations and Workbot. It calls the model directly (any Anthropic- or
    OpenAI-compatible endpoint; key in headless_model_api_key) and reaches tools
    through Den's /mcp/agent. Runs as one task with its SQLite database on EFS
    (one mount target per service subnet, so service_subnet_ids must be in
    different availability zones).
  EOT
  type = object({
    enabled        = optional(bool, false)
    model_protocol = optional(string, "anthropic")
    model_base_url = optional(string, "https://api.anthropic.com/v1")
    model          = optional(string, "")
    cpu            = optional(number, 512)
    memory         = optional(number, 1024)
  })
  default = {}

  validation {
    condition     = contains(["anthropic", "openai"], var.headless_runner.model_protocol)
    error_message = "headless_runner.model_protocol must be anthropic or openai."
  }
}

variable "headless_model_api_key" {
  description = "API key for headless_runner's model endpoint. Stored in Secrets Manager; only the runner receives it."
  type        = string
  default     = ""
  sensitive   = true
}

variable "headless_runner_image" {
  description = "Full headless runner image reference. Empty uses ghcr.io/different-ai/openwork-headless-runner:<openwork_version>."
  type        = string
  default     = ""
}

variable "workbot" {
  description = "Workbot: a chat app at domain_name (default chat.<domain_name>) whose turns run on the headless runner. Requires headless_runner.enabled."
  type = object({
    enabled     = optional(bool, false)
    domain_name = optional(string, "")
    cpu         = optional(number, 256)
    memory      = optional(number, 512)
  })
  default = {}
}

variable "workbot_image" {
  description = "Full Workbot image reference. Empty uses ghcr.io/different-ai/openwork-workbot:<openwork_version>."
  type        = string
  default     = ""
}

variable "workbot_listener_rule_priority" {
  description = "Priority of the Workbot host rule on the HTTPS listener (created with workbot.enabled). Must be unique on that listener."
  type        = number
  default     = 40
}

variable "slack_assistant_enabled" {
  description = "Turn on the Slack assistant (members mention OpenWork in Slack and get replies in the thread). Replies run on the headless runner when it is enabled, otherwise on OpenWork Web. You still create the Slack app in Den's connector settings."
  type        = bool
  default     = false
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

variable "database_subnet_ids" {
  description = "Subnets for RDS and ElastiCache. At least two AZs. Ignored when create_database = false and create_redis = false."
  type        = list(string)
  default     = []
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

variable "den_gateway" {
  description = "den-gateway (OpenWork Web) task size and count. Created only with openwork_web_enabled."
  type = object({
    cpu           = optional(number, 256)
    memory        = optional(number, 512)
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

variable "wait_for_steady_state" {
  description = "Whether to wait for the ECS services to reach a steady state before completing terraform apply. When true, terraform blocks until tasks pass health checks and old tasks drain."
  type        = bool
  default     = false
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
