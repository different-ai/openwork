variable "den_api_image" {
  type    = string
  default = ""
}
variable "den_web_image" {
  type    = string
  default = ""
}
variable "write_only_secrets" {
  type    = bool
  default = true
}
variable "secret_values_wo" {
  type = object({
    database_password  = string
    better_auth_secret = string
    db_encryption_key  = string
    bootstrap_code     = string
    database_url       = optional(string, "")
  })
  sensitive = true
  ephemeral = true
  default   = { database_password = "", better_auth_secret = "", db_encryption_key = "", bootstrap_code = "" }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "openwork-test"
}

variable "openwork_version" {
  type    = string
  default = "0.18.58"
}

variable "owner_emails" {
  type = list(string)
}

variable "org_name" {
  type    = string
  default = "OpenWork"
}

variable "create_redis" {
  type    = bool
  default = false
}

variable "domain_name" {
  description = "Hostname for Den web; api.<domain_name> is used for the API."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate in var.region for both hostnames. Empty needs route53_zone_id."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "ecs_cluster_arn" {
  description = "Existing ECS cluster to deploy into. Empty creates one."
  type        = string
  default     = ""
}

variable "wait_for_steady_state" {
  description = "Whether to wait for the ECS services to reach a steady state before completing terraform apply. When true, terraform blocks until tasks pass health checks and old tasks drain."
  type        = bool
  default     = false
}

variable "private_subnets" {
  description = "Run the tasks in private subnets behind a NAT gateway (about $1/day more) instead of public subnets with public IPs."
  type        = bool
  default     = false
}

variable "den_api_desired_count" {
  description = "Number of den-api tasks."
  type        = number
  default     = 1
}

variable "email_from" {
  description = "From address for invites and password resets, for example \"OpenWork <no-reply@example.com>\"."
  type        = string
  default     = ""
}

variable "smtp" {
  description = "SMTP relay such as Amazon SES (host, port, username, password). Empty host disables email."
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
