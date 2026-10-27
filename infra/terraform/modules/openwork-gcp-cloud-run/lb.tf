# Optional global external HTTPS load balancer for custom hostnames ------------
#
# Created only with domain_name: domain_name -> den-web, the API host -> den-api,
# HTTP redirects to HTTPS. Without it, the services' run.app URLs serve HTTPS.

locals {
  create_lb         = local.custom_domain
  create_lb_address = local.create_lb && var.load_balancer_ip_address == ""
  create_lb_cert    = local.create_lb && length(var.ssl_certificate_ids) == 0
  lb_ip             = local.create_lb ? (local.create_lb_address ? google_compute_global_address.lb[0].address : var.load_balancer_ip_address) : null
  lb_services       = local.create_lb ? { api = google_cloud_run_v2_service.api.name, web = google_cloud_run_v2_service.web.name } : {}
}

resource "google_compute_global_address" "lb" {
  count = local.create_lb_address ? 1 : 0

  project = var.project_id
  name    = "${var.name}-den-lb"
  labels  = var.labels
}

resource "google_compute_region_network_endpoint_group" "run" {
  for_each = local.lb_services

  project               = var.project_id
  name                  = "${var.name}-den-${each.key}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = each.value
  }
}

resource "google_compute_backend_service" "run" {
  for_each = local.lb_services

  project               = var.project_id
  name                  = "${var.name}-den-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.run[each.key].id
  }
}

resource "google_compute_url_map" "https" {
  count = local.create_lb ? 1 : 0

  project         = var.project_id
  name            = "${var.name}-den"
  default_service = google_compute_backend_service.run["web"].id

  host_rule {
    hosts        = [local.api_host]
    path_matcher = "api"
  }

  host_rule {
    hosts        = [var.domain_name]
    path_matcher = "web"
  }

  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.run["api"].id
  }

  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.run["web"].id
  }
}

resource "google_compute_managed_ssl_certificate" "this" {
  count = local.create_lb_cert ? 1 : 0

  project = var.project_id
  name    = "${var.name}-den"

  managed {
    domains = [var.domain_name, local.api_host]
  }
}

resource "google_compute_target_https_proxy" "this" {
  count = local.create_lb ? 1 : 0

  project          = var.project_id
  name             = "${var.name}-den"
  url_map          = google_compute_url_map.https[0].id
  ssl_certificates = local.create_lb_cert ? [google_compute_managed_ssl_certificate.this[0].id] : var.ssl_certificate_ids
}

resource "google_compute_global_forwarding_rule" "https" {
  count = local.create_lb ? 1 : 0

  project               = var.project_id
  name                  = "${var.name}-den-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = local.lb_ip
  port_range            = "443"
  target                = google_compute_target_https_proxy.this[0].id
  labels                = var.labels
}

resource "google_compute_url_map" "http_redirect" {
  count = local.create_lb ? 1 : 0

  project = var.project_id
  name    = "${var.name}-den-http"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count = local.create_lb ? 1 : 0

  project = var.project_id
  name    = "${var.name}-den-http"
  url_map = google_compute_url_map.http_redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count = local.create_lb ? 1 : 0

  project               = var.project_id
  name                  = "${var.name}-den-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = local.lb_ip
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect[0].id
  labels                = var.labels
}
