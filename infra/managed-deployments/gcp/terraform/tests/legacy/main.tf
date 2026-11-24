# Minimal historical managed data-bearing shape. Synthetic values only; no cloud.
terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.7" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}
locals {
  name        = "ow-123456781234"
  labels      = { managed_by = "openwork" }
  secret_keys = toset(["database-url", "auth", "encryption", "bootstrap"])
  secret_values = {
    database-url = "mysql://openwork:${urlencode(random_password.values["database"].result)}@localhost/openwork_den?socket=${urlencode("/cloudsql/${google_sql_database_instance.main.connection_name}")}"
    auth         = random_password.values["auth"].result
    encryption   = random_password.values["encryption"].result
    bootstrap    = random_password.values["bootstrap"].result
  }
}
resource "random_password" "values" {
  for_each = toset(["database", "auth", "encryption", "bootstrap"])
  length   = 48
  special  = false
  lifecycle { prevent_destroy = true }
}
resource "google_sql_database_instance" "main" {
  project             = "test-project"
  name                = "${local.name}-mysql"
  region              = "us-central1"
  database_version    = "MYSQL_8_0"
  deletion_protection = true
  settings {
    tier                        = "db-custom-1-3840"
    availability_type           = "ZONAL"
    disk_size                   = 20
    disk_autoresize             = true
    deletion_protection_enabled = true
    user_labels                 = local.labels
    ip_configuration { ipv4_enabled = true }
    backup_configuration {
      enabled            = true
      binary_log_enabled = true
      start_time         = "03:00"
      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "google_sql_database" "main" {
  project  = "test-project"
  name     = "openwork_den"
  instance = google_sql_database_instance.main.name
  lifecycle { prevent_destroy = true }
}
resource "google_sql_user" "main" {
  project  = "test-project"
  name     = "openwork"
  host     = "" # Observed legacy identity when the managed root omits host.
  instance = google_sql_database_instance.main.name
  password = random_password.values["database"].result
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret" "values" {
  for_each  = local.secret_keys
  project   = "test-project"
  secret_id = "${local.name}-${each.key}"
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret_version" "values" {
  for_each    = local.secret_keys
  secret      = google_secret_manager_secret.values[each.key].id
  secret_data = local.secret_values[each.key]
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_keys
  project   = "test-project"
  secret_id = google_secret_manager_secret.values[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.name}-runtime@test-project.iam.gserviceaccount.com"
}
