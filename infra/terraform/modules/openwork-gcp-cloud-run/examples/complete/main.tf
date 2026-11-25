# Disposable end-to-end stack: Cloud SQL, secrets, the migration job and both
# services on their default run.app HTTPS URLs. No domain or certificate is
# needed. Optional switches exercise the other paths:
# - create_network: a new VPC + subnet, passed to the module as an "existing"
#   network for Direct VPC egress;
# - domain_name: the HTTPS load balancer with a Google-managed certificate;
# - sslip_domain: the load balancer on <ip>.sslip.io, for a test without a
#   domain of your own. The hostname depends on the reserved address, so
#   create it first: terraform apply -target=google_compute_global_address.sslip
# For production, pass your own network, domain and deletion protection.

terraform {
  required_version = ">= 1.11, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.7"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_compute_network" "this" {
  count = var.create_network ? 1 : 0

  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "this" {
  count = var.create_network ? 1 : 0

  name          = "${var.name}-run"
  region        = var.region
  network       = google_compute_network.this[0].id
  ip_cidr_range = "10.42.0.0/24"
}

# sslip.io resolves <a-b-c-d>.sslip.io and api.<a-b-c-d>.sslip.io to a.b.c.d,
# so a reserved address gives two hostnames for a managed certificate.
resource "google_compute_global_address" "sslip" {
  count = var.sslip_domain ? 1 : 0

  name = "${var.name}-den-lb"
}

locals {
  domain_name = var.sslip_domain ? "${replace(google_compute_global_address.sslip[0].address, ".", "-")}.sslip.io" : var.domain_name
}

module "openwork" {
  source = "../.."

  project_id       = var.project_id
  region           = var.region
  name             = var.name
  openwork_version = var.openwork_version
  image_digests    = var.image_digests
  owner_emails     = var.owner_emails
  org_name         = var.org_name
  labels           = { stack = var.name }

  service_account_email = var.service_account_email
  grant_iam_roles       = var.grant_iam_roles
  public_access         = var.public_access

  network    = one(google_compute_network.this[*].id)
  subnetwork = one(google_compute_subnetwork.this[*].id)

  domain_name              = local.domain_name
  load_balancer_ip_address = one(google_compute_global_address.sslip[*].address)

  # Disposable test stack: allow a clean destroy.
  deletion_protection = false
  database = {
    deletion_protection = false
    backup_enabled      = false
  }
  den_api = { min_instances = 0, max_instances = 1 }
  den_web = { min_instances = 0, max_instances = 1 }
}

output "web_url" { value = module.openwork.web_url }
output "api_url" { value = module.openwork.api_url }
output "setup_url" { value = module.openwork.setup_url }
output "bootstrap_code" {
  value     = module.openwork.bootstrap_code
  sensitive = true
}
output "load_balancer_ip" { value = module.openwork.load_balancer_ip }
output "service_names" { value = module.openwork.service_names }
output "migration_job_name" { value = module.openwork.migration_job_name }
output "images" { value = module.openwork.images }
