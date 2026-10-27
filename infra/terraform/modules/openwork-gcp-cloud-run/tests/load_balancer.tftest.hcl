# Offline checks (mocked Google provider): terraform init && terraform test

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { connection_name = "test-project:us-central1:openwork-den", private_ip_address = "10.10.0.5" }
  }
  mock_resource "google_secret_manager_secret_version" {
    defaults = { version = "1" }
  }
  mock_resource "google_service_account" {
    defaults = { email = "openwork-den-run@test-project.iam.gserviceaccount.com" }
  }
  mock_resource "google_compute_global_address" {
    defaults = { address = "34.120.0.10" }
  }
  mock_resource "google_compute_backend_service" {
    defaults = { id = "projects/test-project/global/backendServices/openwork" }
  }
  mock_resource "google_compute_managed_ssl_certificate" {
    defaults = { id = "projects/test-project/global/sslCertificates/openwork-den" }
  }
}

provider "random" {} # Local-only; mock providers do not support ephemeral resources.

variables {
  project_id       = "test-project"
  openwork_version = "0.0.0-test"
  owner_emails     = ["admin@example.com"]
  image_digests    = { den_api = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", den_web = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
}

run "custom_domain_creates_https_load_balancer" {
  command = apply

  variables {
    domain_name = "openwork.example.com"
  }

  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com"
    error_message = "With domain_name, Den must use the custom hostnames."
  }
  assert {
    condition     = google_compute_managed_ssl_certificate.this[0].managed[0].domains == tolist(["openwork.example.com", "api.openwork.example.com"])
    error_message = "The managed certificate must cover both hostnames."
  }
  assert {
    condition     = anytrue([for h in google_compute_url_map.https[0].host_rule : contains(h.hosts, "api.openwork.example.com") && h.path_matcher == "api"])
    error_message = "The API host must route to den-api."
  }
  assert {
    condition     = google_compute_region_network_endpoint_group.run["api"].cloud_run[0].service == "openwork-den-api"
    error_message = "The API backend must point at den-api."
  }
  assert {
    condition     = google_compute_global_forwarding_rule.https[0].port_range == "443" && google_compute_url_map.http_redirect[0].default_url_redirect[0].https_redirect
    error_message = "HTTPS on 443 and HTTP redirected."
  }
  assert {
    condition     = output.dns_records["openwork.example.com"] == "34.120.0.10" && output.dns_records["api.openwork.example.com"] == "34.120.0.10" && length(output.dns_records) == 2
    error_message = "dns_records must list both hostnames at the load balancer IP."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "DEN_API_BASE=https://api.openwork.example.com")
    error_message = "den-web must reach den-api through the load balancer host."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "Ingress stays open unless restrict_ingress_to_load_balancer."
  }
}

run "existing_certificate_and_address" {
  command = apply

  variables {
    domain_name              = "openwork.example.com"
    api_domain_name          = "den-api.example.com"
    ssl_certificate_ids      = ["projects/test-project/global/sslCertificates/wildcard"]
    load_balancer_ip_address = "34.1.2.3"
  }

  assert {
    condition     = length(google_compute_managed_ssl_certificate.this) == 0 && length(google_compute_global_address.lb) == 0
    error_message = "No certificate or address is created when both are provided."
  }
  assert {
    condition     = google_compute_target_https_proxy.this[0].ssl_certificates == tolist(var.ssl_certificate_ids)
    error_message = "The proxy must use the given certificate."
  }
  assert {
    condition     = google_compute_global_forwarding_rule.https[0].ip_address == "34.1.2.3" && output.api_url == "https://den-api.example.com"
    error_message = "The given address and API hostname must be used."
  }
}

run "restrict_ingress_to_load_balancer" {
  command = apply

  variables {
    domain_name                       = "openwork.example.com"
    restrict_ingress_to_load_balancer = true
  }

  assert {
    condition = alltrue([
      for r in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.web] :
      r.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && r.default_uri_disabled
    ])
    error_message = "Both services must accept only load balancer traffic."
  }
}
