# OFFLINE: all Google APIs mocked; random is local-only (ephemeral schema).
# Mock applies establish synthetic off/on state; enable/invalid checks use plans.
mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
  mock_resource "google_sql_database_instance" { defaults = { connection_name = "test-project:us-central1:openwork-den" } }
  mock_resource "google_secret_manager_secret_version" { defaults = { version = "1" } }
  mock_resource "google_service_account" { defaults = { email = "runtime@test-project.iam.gserviceaccount.com" } }
  mock_resource "google_compute_backend_service" { defaults = { id = "projects/test-project/global/backendServices/openwork" } }
}
override_resource {
  target = google_compute_backend_service.ai_gateway
  values = { id = "projects/test-project/global/backendServices/ai-gateway-distinct" }
}
provider "random" {}
variables {
  project_id         = "test-project"
  openwork_version   = "0.0.0-test"
  owner_emails       = ["admin@example.com"]
  write_only_secrets = false
  image_digests      = { den_api = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", den_web = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ai_gateway_image   = "us-central1-docker.pkg.dev/test-project/mirror/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
run "off_by_default" {
  command = apply # Synthetic state only; no provisioning or migration execution.
  assert {
    condition     = length(google_cloud_run_v2_service.ai_gateway) == 0 && length(google_compute_backend_service.ai_gateway) == 0 && length(google_compute_region_network_endpoint_group.ai_gateway) == 0 && length(google_compute_backend_service.run) == 0 && output.ai_gateway_url == null && length([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name if startswith(e.name, "GATEWAY_") || startswith(e.name, "INFERENCE_")]) == 0
    error_message = "Default: 0 AI Gateway services/backends, URL null, no new Den env; no load balancer."
  }
}
run "enable_plan" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    network                = "projects/test-project/global/networks/shared"
    subnetwork             = "projects/test-project/regions/us-central1/subnetworks/run"
  }
  assert {
    condition     = length(google_cloud_run_v2_service.ai_gateway) == 1 && google_cloud_run_v2_service.ai_gateway[0].template[0].containers[0].image == var.ai_gateway_image && google_cloud_run_v2_service.ai_gateway[0].template[0].containers[0].ports[0].container_port == 8791 && google_cloud_run_v2_service.ai_gateway[0].template[0].containers[0].startup_probe[0].http_get[0].path == "/health" && output.ai_gateway_url == "https://models.example.com"
    error_message = "Enabled: 0 -> 1 inference service on 8791 with /health; public models URL."
  }
  assert {
    condition     = google_cloud_run_v2_service.ai_gateway[0].default_uri_disabled && google_cloud_run_v2_service.ai_gateway[0].ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && google_cloud_run_v2_service.ai_gateway[0].invoker_iam_disabled && !google_cloud_run_v2_service.ai_gateway[0].deletion_protection && contains(google_compute_managed_ssl_certificate.this[0].managed[0].domains, "models.example.com") && anytrue([for r in google_compute_url_map.https[0].host_rule : contains(r.hosts, "models.example.com") && r.path_matcher == "ai-gateway"])
    error_message = "HTTPS LB routes the dedicated host and certificate; no direct run.app bypass or Cloud Run ID-token requirement; stateless service can be disabled."
  }
  assert {
    condition = alltrue([for c in [google_cloud_run_v2_service.api.template[0].containers[0], google_cloud_run_v2_service.ai_gateway[0].template[0].containers[0]] : alltrue([for k, v in {
      GATEWAY_ENABLED = "true", GATEWAY_PROXY_BASE_URL = "https://models.example.com", GATEWAY_PUBLIC_BASE_URL = "https://models.example.com", INFERENCE_PROXY_BASE_URL = "https://models.example.com", DB_MODE = "mysql", NODE_ENV = "production"
    } : contains([for e in c.env : "${e.name}=${e.value == null ? "" : e.value}"], "${k}=${v}")]) && alltrue([for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : anytrue([for e in c.env : e.name == name && try(e.value_source[0].secret_key_ref[0].secret == google_secret_manager_secret.app[name].secret_id && e.value_source[0].secret_key_ref[0].version == "1", false)])])])
    error_message = "Both serving apps get matching enabled/public/proxy env and exactly the existing database/encryption secret versions."
  }
  assert {
    condition     = google_cloud_run_v2_service.ai_gateway[0].template[0].vpc_access[0].network_interfaces[0].subnetwork == var.subnetwork && contains(google_cloud_run_v2_service.ai_gateway[0].template[0].volumes[0].cloud_sql_instance[0].instances, "test-project:us-central1:openwork-den") && strcontains(google_cloud_run_v2_service.api.template[0].containers[0].args[2], "url.hostname = \"cloudsql\"") && strcontains(google_cloud_run_v2_service.ai_gateway[0].template[0].containers[0].args[4], "url.hostname = \"cloudsql\"") && strcontains(google_secret_manager_secret_version.app["DATABASE_URL"].secret_data, "@localhost/")
    error_message = "Gateway retains VPC and Cloud SQL socket wiring; only serving-process hostname is adapted, stored localhost URL unchanged."
  }
  assert {
    condition     = toset(values(output.secret_ids)) == toset(["openwork-den-database-url", "openwork-den-better-auth-secret", "openwork-den-den-db-encryption-key", "openwork-den-den-initial-admin-bootstrap-code"]) && length(google_secret_manager_secret.app) == 4 && google_secret_manager_secret_version.app["DEN_DB_ENCRYPTION_KEY"].secret_data == random_password.db_encryption[0].result && length(var.secret_data_wo_version) == 0
    error_message = "Same four app secrets and encryption value, no new version counters."
  }
}
run "with_den_custom_domains" {
  command = plan
  variables {
    domain_name            = "openwork.example.com"
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(google_compute_region_network_endpoint_group.run) + length(google_compute_region_network_endpoint_group.ai_gateway) == 3 && length(google_compute_url_map.https[0].host_rule) == 3 && toset(google_compute_managed_ssl_certificate.this[0].managed[0].domains) == toset(["openwork.example.com", "api.openwork.example.com", "models.example.com"])
    error_message = "Den and AI Gateway coexist as three separate backends/hosts on one HTTPS LB; this does not create den-gateway."
  }
}
run "missing_domain" {
  command = plan
  variables { ai_gateway_enabled = true }
  expect_failures = [var.ai_gateway_domain_name]
}
run "invalid_public_hostname" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.internal"
  }
  expect_failures = [var.ai_gateway_domain_name]
}
run "conflicting_environment" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    extra_environment      = { GATEWAY_PUBLIC_BASE_URL = "https://other.example.com" }
  }
  expect_failures = [var.ai_gateway_enabled]
}
run "conflicting_secret" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    extra_secrets          = { DEN_DB_ENCRYPTION_KEY = "other-secret" }
  }
  expect_failures = [var.ai_gateway_enabled]
}
run "conflicting_host" {
  command = plan
  variables {
    domain_name            = "openwork.example.com"
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "openwork.example.com"
  }
  expect_failures = [google_cloud_run_v2_service.ai_gateway]
}
run "mutable_image" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    ai_gateway_image       = "example.test/openwork-inference:latest"
  }
  expect_failures = [var.ai_gateway_image]
}
run "enabled_mock_state" {
  command = apply # Mock-only state, no Cloud Run/SQL calls.
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(google_cloud_run_v2_service.ai_gateway) == 1 && length(google_secret_manager_secret.app) == 4 && anytrue([for matcher in google_compute_url_map.https[0].path_matcher : matcher.name == "ai-gateway" && matcher.default_service == google_compute_backend_service.ai_gateway[0].id])
    error_message = "Synthetic state routes the Gateway matcher to its distinct backend, not Den, and keeps the original four secrets."
  }
}
run "unchanged_enabled_plan" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(google_cloud_run_v2_service.ai_gateway) == 1 && toset(values(output.secret_ids)) == toset(["openwork-den-database-url", "openwork-den-better-auth-secret", "openwork-den-den-db-encryption-key", "openwork-den-den-initial-admin-bootstrap-code"]) && length(var.secret_data_wo_version) == 0
    error_message = "Unchanged enabled plan retains original secret identities and version counters."
  }
}
run "disable_plan_keeps_data" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_service.ai_gateway) == 0 && output.ai_gateway_url == null && length(google_sql_database_instance.this) == 1 && toset(values(output.secret_ids)) == toset(["openwork-den-database-url", "openwork-den-better-auth-secret", "openwork-den-den-db-encryption-key", "openwork-den-den-initial-admin-bootstrap-code"]) && !contains(keys(local.environment), "GATEWAY_ENABLED")
    error_message = "Disable: Gateway 1 -> 0, runtime defaults false, database and four original secrets kept."
  }
}
