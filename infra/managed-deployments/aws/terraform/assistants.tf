# Optional services use the same shared-module contract as direct deployments.
# Customer credentials stay in pre-created Secrets Manager plain-string secrets;
# Terraform records references only and never reads their values.
variable "headless_runner" {
  type = object({
    enabled        = optional(bool, false)
    external_url   = optional(string, "")
    model_protocol = optional(string, "anthropic")
    model_base_url = optional(string, "https://api.anthropic.com/v1")
    model          = optional(string, "")
    cpu            = optional(number, 512)
    memory         = optional(number, 1024)
  })
  default = {}
  validation {
    condition     = var.headless_runner.external_url == ""
    error_message = "The managed installer supports only its managed runner; external fleets require a separately approved token boundary."
  }
  validation {
    condition     = contains(["anthropic", "openai", "openai-responses"], var.headless_runner.model_protocol)
    error_message = "Use the direct anthropic, openai or openai-responses model protocol."
  }
  validation {
    condition     = !var.headless_runner.enabled || (trimspace(var.headless_runner.model) != "" && var.headless_model_secret_arn != "")
    error_message = "An enabled runner needs a model and a customer-created model credential secret ARN."
  }
  validation {
    condition     = can(regex("^https://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$", var.headless_runner.model_base_url))
    error_message = "The direct model endpoint must be HTTPS, without credentials, a query or a fragment."
  }
}

variable "headless_runner_image" {
  type    = string
  default = ""
}

variable "workbot" {
  type = object({
    enabled       = optional(bool, false)
    domain_name   = optional(string, "")
    cpu           = optional(number, 256)
    memory        = optional(number, 512)
    desired_count = optional(number, 1)
  })
  default = {}
  validation {
    condition     = !var.workbot.enabled || var.headless_runner.enabled
    error_message = "Workbot needs the managed headless runner."
  }
}

variable "workbot_image" {
  type    = string
  default = ""
}

variable "slack_assistant_enabled" {
  type    = bool
  default = false
  validation {
    condition     = !var.slack_assistant_enabled || var.headless_runner.enabled
    error_message = "Slack replies need the managed headless runner."
  }
}

variable "headless_computer" {
  type = object({
    provider      = optional(string, "off")
    snapshot      = optional(string, "")
    pause_seconds = optional(number, 300)
    keep_days     = optional(number, 14)
  })
  default = {}
  validation {
    condition     = contains(["off", "daytona", "freestyle"], var.headless_computer.provider)
    error_message = "Computer provider must be off, daytona or freestyle."
  }
  validation {
    condition     = var.headless_computer.provider == "off" || (var.headless_runner.enabled && var.headless_computer_secret_arn != "")
    error_message = "Computers need the managed runner and a customer-created computer credential secret ARN."
  }
}

variable "daytona" {
  description = "Optional Daytona computer endpoint/target. The computer snapshot belongs in headless_computer.snapshot; configuring these values does not provision a sandbox."
  type = object({
    api_url = optional(string, "https://app.daytona.io/api")
    target  = optional(string, "")
  })
  default = {}
  validation {
    condition     = can(regex("^https://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$", var.daytona.api_url))
    error_message = "The Daytona API endpoint must be HTTPS, without credentials, a query or a fragment."
  }
}

variable "headless_model_secret_arn" {
  description = "Full ARN of a customer-created plain-string model API key secret, encrypted with the AWS-managed Secrets Manager key. Never the key itself."
  type        = string
  default     = ""
  validation {
    condition     = var.headless_model_secret_arn == "" || can(regex("^arn:(aws|aws-us-gov|aws-cn):secretsmanager:${var.region}:${var.account_id}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$", var.headless_model_secret_arn))
    error_message = "Use a full plain-string Secrets Manager ARN in the deployment account and region, without a JSON-key or version suffix."
  }
}

variable "headless_computer_secret_arn" {
  description = "Full ARN of a customer-created plain-string computer API key secret, encrypted with the AWS-managed Secrets Manager key. Never the key itself."
  type        = string
  default     = ""
  validation {
    condition     = var.headless_computer_secret_arn == "" || can(regex("^arn:(aws|aws-us-gov|aws-cn):secretsmanager:${var.region}:${var.account_id}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$", var.headless_computer_secret_arn))
    error_message = "Use a full plain-string Secrets Manager ARN in the deployment account and region, without a JSON-key or version suffix."
  }
}

output "workbot_url" { value = module.platform.workbot_url }
output "efs_file_system_id" { value = module.platform.efs_file_system_id }
output "runner_backup_vault_name" { value = module.platform.runner_backup_vault_name }
