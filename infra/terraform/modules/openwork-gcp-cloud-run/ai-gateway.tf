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
  description = "Dedicated desktop-reachable HTTPS hostname for the AI Gateway. Required when enabled; point DNS to load_balancer_ip and include it in supplied certificates."
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
  description = "AI Gateway image in Artifact Registry/Docker Hub, pinned by digest and matching the Den release. Mirror ghcr.io/different-ai/openwork-inference; required when enabled."
  type        = string
  default     = ""
  validation {
    condition     = !var.ai_gateway_enabled || can(regex("@sha256:[a-f0-9]{64}$", var.ai_gateway_image))
    error_message = "ai_gateway_enabled requires ai_gateway_image pinned by @sha256 digest; mutable tags are not supported."
  }
}
locals {
  ai_gateway_url = "https://${var.ai_gateway_domain_name}"
  # Like den-web -> den-api, Cloud Run uses the HTTPS load balancer, NOT a
  # private DNS name. Its default run.app URI stays disabled behind the LB.
  ai_gateway_environment = var.ai_gateway_enabled ? {
    GATEWAY_ENABLED          = "true"
    GATEWAY_PROXY_BASE_URL   = local.ai_gateway_url
    GATEWAY_PUBLIC_BASE_URL  = local.ai_gateway_url
    INFERENCE_PROXY_BASE_URL = local.ai_gateway_url
  } : {}
  ai_gateway_secret_refs = { for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : name => local.secret_refs[name] }
  # Preserve the stored URL and all version counters. Only the unused hostname
  # of an authenticated Unix-socket URL is normalized in the serving process.
  # Inline like the AWS TLS entrypoint, so managed installer payloads (which
  # include operational .tf files only) need no new file-allowlist exceptions.
  ai_gateway_entrypoint = <<-JS
    // Cloud SQL uses socketPath; only its unused localhost URL hostname changes.
    // Never change stored secrets, credentials, socket paths or TLS settings.
    import { pathToFileURL } from "node:url";
    const url = new URL(process.env.DATABASE_URL);
    if (url.protocol === "mysql:" && url.hostname === "localhost" && url.searchParams.get("socket")?.startsWith("/cloudsql/")) {
      url.hostname = "cloudsql";
      process.env.DATABASE_URL = url.href;
    }
    await import(pathToFileURL(process.argv[1]).href);
  JS
}
resource "google_cloud_run_v2_service" "ai_gateway" {
  count                = var.ai_gateway_enabled ? 1 : 0
  project              = var.project_id
  name                 = "${var.name}-ai-gateway"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  default_uri_disabled = true
  invoker_iam_disabled = true  # Gateway authenticates member keys; no Cloud Run ID token in desktops.
  deletion_protection  = false # Optional stateless service; disabling must not delete data.
  labels               = var.labels
  template {
    service_account = local.service_account_email
    timeout         = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }
    containers {
      image   = var.ai_gateway_image
      command = ["node"]
      args    = ["--import", "/app/ee/apps/gateway/dist/instrumentation.js", "--input-type=module", "-e", local.ai_gateway_entrypoint, "/app/ee/apps/gateway/dist/server.js"]
      ports { container_port = 8791 }
      resources { limits = { cpu = "1", memory = "2Gi" } }
      startup_probe {
        http_get { path = "/health" }
        period_seconds    = 5
        failure_threshold = 24
      }
      liveness_probe {
        http_get { path = "/health" }
      }
      dynamic "env" {
        for_each = merge(local.ai_gateway_environment, { NODE_ENV = "production", OPENWORK_DEV_MODE = "0", DB_MODE = "mysql" })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.ai_gateway_secret_refs
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
      dynamic "volume_mounts" {
        for_each = local.cloud_sql
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
    dynamic "volumes" {
      for_each = local.cloud_sql
      content {
        name = "cloudsql"
        cloud_sql_instance { instances = [volumes.value] }
      }
    }
    dynamic "vpc_access" {
      for_each = local.vpc_access
      content {
        egress = var.vpc_egress
        network_interfaces {
          network    = vpc_access.value.network
          subnetwork = vpc_access.value.subnetwork
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = !contains([var.domain_name, local.api_host, local.web_host], var.ai_gateway_domain_name)
      error_message = "The AI Gateway hostname must differ from Den web and API hostnames."
    }
  }
  depends_on = [google_cloud_run_v2_job.migrate]
}
resource "google_compute_region_network_endpoint_group" "ai_gateway" {
  count                 = var.ai_gateway_enabled ? 1 : 0
  project               = var.project_id
  name                  = "${var.name}-ai-gateway"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.ai_gateway[0].name }
}
resource "google_compute_backend_service" "ai_gateway" {
  count                 = var.ai_gateway_enabled ? 1 : 0
  project               = var.project_id
  name                  = "${var.name}-ai-gateway"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = var.managed_legacy ? "HTTP" : "HTTPS"
  backend { group = google_compute_region_network_endpoint_group.ai_gateway[0].id }
}
output "ai_gateway_url" {
  description = "AI Gateway HTTPS origin for desktops, or null when disabled. Not the OpenWork Web den-gateway URL."
  value       = var.ai_gateway_enabled ? local.ai_gateway_url : null
}
