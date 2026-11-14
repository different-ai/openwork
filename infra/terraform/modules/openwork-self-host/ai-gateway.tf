# Thin interface to the chart's existing gateway.enabled behavior. The chart
# remains the runtime/deployment authority; only a separate HTTPS ingress is new.
variable "ai_gateway_enabled" {
  description = "Enable the chart's existing AI Gateway with first-class URL/ingress wiring. Off by default. Existing extra_helm_values installs remain supported when false."
  type        = bool
  default     = false
}
variable "ai_gateway_domain_name" {
  description = "Dedicated desktop-reachable HTTPS hostname for the AI Gateway; required with ai_gateway_enabled."
  type        = string
  default     = ""
  validation {
    condition = var.ai_gateway_domain_name == "" || (
      length(var.ai_gateway_domain_name) <= 253 &&
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.ai_gateway_domain_name)) &&
      !can(regex("(^localhost\\.|\\.(localhost|local|internal|svc)$|\\.[0-9]+$)", var.ai_gateway_domain_name))
    )
    error_message = "ai_gateway_domain_name must be empty or a qualified non-local DNS hostname, without scheme, port or path."
  }
}
locals {
  # Keep the wrapper's existing Terraform >= 1.5 floor: cross-input checks go
  # on helm_release preconditions, not post-1.9 cross-variable validation.
  ai_gateway_overrides_valid = (
    !can(var.extra_helm_values.gateway.enabled) && !can(var.extra_helm_values.inference.enabled) &&
    !can(var.extra_helm_values.config.internal.gatewayProxyBaseUrl) && !can(var.extra_helm_values.config.internal.inferenceProxyBaseUrl) &&
    !can(var.extra_helm_values.config.public.gatewayPublicBaseUrl) &&
    !can(var.extra_helm_values.fullnameOverride) && !can(var.extra_helm_values.nameOverride) &&
    !can(var.extra_helm_values.gateway.containerPort) && !can(var.extra_helm_values.inference.containerPort) &&
    !can(var.extra_helm_values.gateway.service.port) && !can(var.extra_helm_values.inference.service.port)
  )
  ai_gateway_url = "https://${var.ai_gateway_domain_name}"
  # Same service name as the chart's inferenceServiceName helper.
  ai_gateway_service_name = "${trimsuffix(substr(local.chart_fullname, 0, 63), "-")}-inference"
  ai_gateway_values = yamldecode(var.ai_gateway_enabled ? yamlencode({
    gateway = { enabled = true }
    config = {
      internal = { gatewayProxyBaseUrl = "http://${local.ai_gateway_service_name}:8791", inferenceProxyBaseUrl = local.ai_gateway_url }
      public   = { gatewayPublicBaseUrl = local.ai_gateway_url }
    }
  }) : "{}")
}
resource "kubernetes_ingress_v1" "ai_gateway" {
  count = var.ai_gateway_enabled && var.ingress.enabled ? 1 : 0
  metadata {
    name        = "${var.release_name}-ai-gateway"
    namespace   = var.namespace
    labels      = var.labels
    annotations = var.ingress.annotations
  }
  spec {
    ingress_class_name = var.ingress.class_name != "" ? var.ingress.class_name : null
    tls {
      secret_name = var.ingress.tls_secret_name
      hosts       = [var.ai_gateway_domain_name]
    }
    rule {
      host = var.ai_gateway_domain_name
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = local.ai_gateway_service_name
              port { number = 8791 }
            }
          }
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = var.ingress.tls_secret_name != ""
      error_message = "AI Gateway ingress needs ingress.tls_secret_name covering ai_gateway_domain_name; otherwise disable ingress and supply external HTTPS routing."
    }
  }
  depends_on = [helm_release.openwork]
}
output "ai_gateway_url" {
  description = "First-class AI Gateway HTTPS origin, or null when disabled. Advanced extra_helm_values URLs remain owned by the operator."
  value       = var.ai_gateway_enabled ? local.ai_gateway_url : null
}
