# Existing records retain their installed topology until an explicitly approved
# update selects gateway. The native module owns Gateway routing and runtime env.
variable "managed_runtime_profile" {
  type    = string
  default = "legacy"
  validation {
    condition     = contains(["legacy", "gateway"], var.managed_runtime_profile)
    error_message = "managed_runtime_profile must be legacy or gateway."
  }
}

variable "ai_gateway_image" {
  description = "Reviewed openwork-inference image from the same release as Den, pinned by digest. Required for the gateway profile."
  type        = string
  default     = ""
  validation {
    condition     = var.managed_runtime_profile != "gateway" || can(regex("@sha256:[0-9a-f]{64}$", var.ai_gateway_image))
    error_message = "The gateway profile needs ai_gateway_image pinned by @sha256 digest."
  }
}

variable "ai_gateway_domain_name" {
  description = "AI Gateway HTTPS hostname. Empty uses models.<domain_name> in the gateway profile."
  type        = string
  default     = ""
}

locals {
  gateway_profile      = var.managed_runtime_profile == "gateway"
  managed_gateway_host = var.ai_gateway_domain_name != "" ? var.ai_gateway_domain_name : "models.${var.domain_name}"
  managed_gateway_url  = "https://${local.managed_gateway_host}"
  managed_headless_runner = local.gateway_profile ? merge(var.headless_runner, {
    enabled        = true
    external_url   = ""
    model_protocol = "openai"
    model_base_url = local.managed_gateway_url
    # Den supplies member-scoped Gateway model access on each turn. No shared
    # upstream credential or provider endpoint is a runner fallback.
    model = "openai/gpt-6-luna"
  }) : var.headless_runner
  managed_workbot = local.gateway_profile ? merge(var.workbot, {
    enabled       = true
    desired_count = 1
  }) : var.workbot
  managed_slack_assistant_enabled = local.gateway_profile || var.slack_assistant_enabled
  managed_model_secret_arn        = local.gateway_profile ? "" : var.headless_model_secret_arn
}

output "ai_gateway_url" { value = module.platform.ai_gateway_url }
