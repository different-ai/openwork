# AI Gateway (ee/apps/gateway / openwork-inference), not OpenWork Web's den-gateway.
variable "ai_gateway_enabled" {
  description = "Deploy the AI Gateway for administrator-managed inference. Off by default; installation configuration, not a product flag."
  type        = bool
  default     = false
  validation {
    condition = !var.ai_gateway_enabled || alltrue([for name in concat(keys(var.extra_environment), keys(var.extra_secrets)) :
      !startswith(name, "GATEWAY_") && !startswith(name, "INFERENCE_") && !contains(["DB_MODE", "DATABASE_URL", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD", "DEN_DB_ENCRYPTION_KEY", "NODE_ENV", "OPENWORK_DEV_MODE", "PORT"], name)
    ])
    error_message = "With ai_gateway_enabled, remove Gateway/Inference and shared runtime/database overrides from extra_environment and extra_secrets; use the module inputs and existing app secrets."
  }
}
variable "ai_gateway_domain_name" {
  description = "Dedicated desktop-reachable HTTPS hostname for the AI Gateway. Required when enabled; preconfigure CNAME/TXT records and a covering custom_domain_certificate."
  type        = string
  default     = ""
  validation {
    condition = !var.ai_gateway_enabled || (
      length(var.ai_gateway_domain_name) <= 253 &&
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.ai_gateway_domain_name)) &&
      !can(regex("(^localhost\\.|\\.(localhost|local|internal|svc)$|\\.[0-9]+$)", var.ai_gateway_domain_name))
    )
    error_message = "ai_gateway_enabled requires ai_gateway_domain_name: a qualified non-local DNS hostname, without scheme, port or path."
  }
}
variable "ai_gateway_image" {
  description = "AI Gateway image pinned by digest, normally ghcr.io/different-ai/openwork-inference@sha256:<digest> from the same release as Den. Required when enabled."
  type        = string
  default     = ""
  validation {
    condition     = !var.ai_gateway_enabled || can(regex("@sha256:[a-f0-9]{64}$", var.ai_gateway_image))
    error_message = "ai_gateway_enabled requires ai_gateway_image pinned by @sha256 digest; mutable tags are not supported."
  }
}
locals {
  ai_gateway_app_name     = "${var.app_name_prefix}${var.name}-ai-gateway"
  ai_gateway_default_host = "${local.ai_gateway_app_name}.${local.environment_default_domain}"
  ai_gateway_url          = "https://${var.ai_gateway_domain_name}"
  # Same-environment HTTPS FQDN is internally routed by Container Apps.
  ai_gateway_environment = var.ai_gateway_enabled ? {
    GATEWAY_ENABLED          = "true"
    GATEWAY_PROXY_BASE_URL   = "https://${local.ai_gateway_default_host}"
    GATEWAY_PUBLIC_BASE_URL  = local.ai_gateway_url
    INFERENCE_PROXY_BASE_URL = local.ai_gateway_url
  } : {}
  ai_gateway_secret_names    = concat(["database-url", "den-db-encryption-key"], local.registry_password ? ["registry-password"] : [])
  ai_gateway_secret_metadata = [for secret in local.secret_metadata : secret if contains(local.ai_gateway_secret_names, secret.name)]
  ai_gateway_secret_payload = [for name in concat(["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"], local.registry_password ? ["REGISTRY_PASSWORD"] : []) : {
    name = lower(replace(name, "_", "-")), value = local.secret_values[name]
  }]
}
resource "azapi_resource" "ai_gateway" {
  count                  = var.ai_gateway_enabled ? 1 : 0
  type                   = "Microsoft.App/containerApps@2025-01-01"
  name                   = local.ai_gateway_app_name
  parent_id              = data.azurerm_resource_group.this.id
  location               = local.app_location
  tags                   = var.tags
  ignore_null_property   = true
  response_export_values = []
  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }
  body                   = local.app_bodies.ai_gateway
  sensitive_body         = { properties = { configuration = { secrets = local.ai_gateway_secret_payload } } }
  sensitive_body_version = local.app_write_versions.ai_gateway
  depends_on             = [data.external.migration_completion]
  lifecycle {
    precondition {
      condition     = var.custom_domain_certificate != null
      error_message = "The AI Gateway needs custom_domain_certificate covering ai_gateway_domain_name and preconfigured DNS."
    }
    precondition {
      condition     = !contains([local.web_host, local.api_host], var.ai_gateway_domain_name)
      error_message = "The AI Gateway hostname must differ from Den web and API hostnames."
    }
  }
}
resource "azurerm_container_app_custom_domain" "ai_gateway" {
  count                                    = var.ai_gateway_enabled && nonsensitive(var.custom_domain_certificate != null) ? 1 : 0
  name                                     = var.ai_gateway_domain_name
  container_app_id                         = azapi_resource.ai_gateway[0].id
  container_app_environment_certificate_id = azurerm_container_app_environment_certificate.this[0].id
  certificate_binding_type                 = "SniEnabled"
}
output "ai_gateway_url" {
  description = "AI Gateway HTTPS origin for desktops, or null when disabled. Not the OpenWork Web den-gateway URL."
  value       = var.ai_gateway_enabled ? local.ai_gateway_url : null
}
output "ai_gateway_dns_records" {
  description = "Preconfigure CNAME and asuid TXT before enabling the AI Gateway (environment must exist); null when disabled."
  value = var.ai_gateway_enabled ? {
    host  = var.ai_gateway_domain_name
    cname = local.ai_gateway_default_host
    txt   = { name = "asuid.${var.ai_gateway_domain_name}", value = local.environment_verification }
  } : null
}
