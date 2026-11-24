# Dedicated-project root: bootstrap owns identities, APIs and retained state.
# It names no identity. Whoever runs it supplies the credentials: the
# deployment's runner service account inside Cloud Build, or the customer after
# taking the deployment over.
terraform {
  required_version = "= 1.16.5"
  # Bucket and prefix come from the runner, or from applied/backend.tf.json
  # saved in this directory as backend_override.tf.json.
  backend "gcs" {}
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.7" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}

variable "managed_maintenance" {
  type    = bool
  default = false
}
variable "deployment_id" { type = string }
variable "domain_name" { type = string }
variable "owner_email" { type = string }
variable "openwork_version" { type = string }
variable "control_plane_origin" { type = string }
variable "size" {
  type    = string
  default = "small"
}
variable "project_id" { type = string }
variable "project_number" { type = string }
variable "region" { type = string }
variable "dns_zone_name" { type = string }
# Removal only (see "Remove" in ../README.md). The installer never sets it and
# it is not an override: a managed run always keeps deletion protection on.
variable "allow_destroy" {
  type    = bool
  default = false
}
variable "images" {
  type = object({ den_api = string, den_web = string, health = string })
  validation {
    condition     = alltrue([for image in values(var.images) : can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9_]+@sha256:[a-f0-9]{64}$", image))])
    error_message = "Cloud Run images must be customer Artifact Registry images pinned by digest."
  }
}

module "contract" {
  source               = "../../contract"
  deployment_id        = var.deployment_id
  domain_name          = var.domain_name
  owner_email          = var.owner_email
  openwork_version     = var.openwork_version
  control_plane_origin = var.control_plane_origin
  size                 = var.size
}

locals {
  # Capacity profiles map the neutral size to Google Cloud choices: CPU in
  # units of 1024 per vCPU and memory in MiB, as in overrides.json.
  profiles = {
    small = {
      database = { tier = local.database.tier, disk_size_gb = local.database.disk_size_gb, high_availability = false }
      den_api  = { cpu = 2048, memory = 2048, min_instances = 1, max_instances = 10 }
      den_web  = { cpu = 1024, memory = 1024, min_instances = 1, max_instances = 10 }
    }
  }
  profile = local.profiles[var.size]

  name          = module.contract.name
  labels        = module.contract.labels
  runtime_sa    = "${local.name}-runtime@${var.project_id}.iam.gserviceaccount.com"
  web_sa        = "${local.name}-web@${var.project_id}.iam.gserviceaccount.com"
  health_sa     = "${local.name}-health@${var.project_id}.iam.gserviceaccount.com"
  scheduler_sa  = "${local.name}-scheduler@${var.project_id}.iam.gserviceaccount.com"
  web_url       = module.contract.web_url
  api_url       = module.contract.api_url
  service_names = { den_api = "${local.name}-api", den_web = "${local.name}-web" }
}
provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}

data "google_project" "target" { project_id = var.project_id }
data "google_dns_managed_zone" "target" { name = var.dns_zone_name }
resource "terraform_data" "target" {
  lifecycle {
    precondition {
      condition     = tostring(data.google_project.target.number) == var.project_number
      error_message = "Wrong GCP project number."
    }
    precondition {
      condition     = data.google_dns_managed_zone.target.visibility == "public" && ("${var.domain_name}." == data.google_dns_managed_zone.target.dns_name || endswith("${var.domain_name}.", ".${data.google_dns_managed_zone.target.dns_name}"))
      error_message = "The domain must belong to the selected public DNS zone."
    }
    precondition {
      condition     = alltrue([for image in values(var.images) : startswith(image, "${var.region}-docker.pkg.dev/${var.project_id}/${local.name}/")])
      error_message = "Images must belong to this deployment's customer repository."
    }
  }
}

module "platform" {
  source                            = "../../../terraform/modules/openwork-gcp-cloud-run"
  project_id                        = var.project_id
  region                            = var.region
  name                              = local.name
  labels                            = local.labels
  openwork_version                  = var.openwork_version
  owner_emails                      = [var.owner_email]
  org_slug                          = "openwork"
  domain_name                       = var.domain_name
  den_api_image                     = var.images.den_api
  den_web_image                     = var.images.den_web
  create_image_mirror               = false
  service_account_email             = local.runtime_sa
  web_service_account_email         = local.web_sa
  grant_iam_roles                   = true # Secret-scoped access only; bootstrap owns Cloud SQL IAM.
  managed_legacy                    = true
  managed_maintenance               = var.managed_maintenance
  write_only_secrets                = false
  deletion_protection               = !var.allow_destroy
  restrict_ingress_to_load_balancer = true
  # Retain existing allUsers bindings in the managed root.
  public_access = false
  # Fixed settings and the small size's database, with the tuned tier, disk and
  # availability on top. Nothing else about the database can be tuned.
  database          = merge(local.database, local.tuned.database)
  den_api           = local.tuned.den_api
  den_web           = local.tuned.den_web
  extra_environment = var.overrides.extra_environment
  depends_on        = [terraform_data.target]
}

locals {
  # No automatic major-version upgrade, including on adoption of existing state.
  # Moving managed customers to 8.4 is a separate owner-approved operation.
  database = {
    database_version = "MYSQL_8_0"
    tier             = "db-custom-1-3840"
    disk_size_gb     = 20
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each   = local.service_names
  name       = each.value
  location   = var.region
  role       = "roles/run.invoker"
  member     = "allUsers"
  depends_on = [module.platform]
}
resource "google_dns_record_set" "services" {
  for_each     = toset([var.domain_name, "api.${var.domain_name}"])
  managed_zone = var.dns_zone_name
  name         = "${each.value}."
  type         = "A"
  ttl          = 300
  rrdatas      = [module.platform.load_balancer_ip]
}

resource "google_cloud_run_v2_job" "health" {
  name     = "${local.name}-health"
  location = var.region
  template {
    template {
      service_account = local.health_sa
      max_retries     = 0
      timeout         = "240s"
      containers {
        image   = var.images.health
        command = ["python3", "-c"]
        args    = [file("${path.module}/../health/health_agent.py")]
        resources { limits = { cpu = "1", memory = "512Mi" } }
        dynamic "env" {
          for_each = {
            DEPLOYMENT_ID    = var.deployment_id, CONTROL_PLANE_ORIGIN = var.control_plane_origin
            PROJECT_ID       = var.project_id, REGION = var.region, API_URL = local.api_url, WEB_URL = local.web_url
            SERVICE_NAMES    = jsonencode(local.service_names), DATABASE_INSTANCE = module.platform.database_instance_name
            CERTIFICATE_NAME = "${local.name}-tls", OPENWORK_VERSION = var.openwork_version
            EXPECTED_IMAGES  = jsonencode({ den_api = var.images.den_api, den_web = var.images.den_web })
          }
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }
}
resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  name     = google_cloud_run_v2_job.health.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.scheduler_sa}"
}
resource "google_cloud_scheduler_job" "health" {
  name             = "${local.name}-health"
  region           = var.region
  schedule         = "*/${module.contract.health_interval_minutes} * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "30s"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.health.name}:run"
    http_method = "POST"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oauth_token {
      service_account_email = local.scheduler_sa
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler]
}

output "web_url" { value = local.web_url }
output "api_url" { value = local.api_url }
output "setup_url" { value = "${local.web_url}/setup" }
output "health_agent" { value = google_cloud_run_v2_job.health.name }
output "service_names" { value = local.service_names }
