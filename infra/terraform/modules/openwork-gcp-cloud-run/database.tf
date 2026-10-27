# Cloud SQL for MySQL ---------------------------------------------------------

locals {
  # Cloud Run mounts the Cloud SQL connector socket at /cloudsql/<connection name>.
  cloud_sql_connection_name = var.create_database ? google_sql_database_instance.this[0].connection_name : var.cloud_sql_connection_name

  # The connector authorizes each connection with the service account's IAM
  # role and encrypts it with a certificate it verifies, so no TLS query.
  database_url = var.write_only_secrets ? null : (!var.create_database ? var.database_url : format(
    "mysql://%s:%s@localhost/%s?socket=%s",
    google_sql_user.openwork[0].name,
    random_password.db[0].result,
    google_sql_database.den[0].name,
    urlencode("/cloudsql/${google_sql_database_instance.this[0].connection_name}"),
  ))
  database_password_wo = var.write_only_secrets ? lookup(var.preserved_secrets_wo, "DATABASE_PASSWORD", ephemeral.random_password.app["DATABASE_PASSWORD"].result) : null
  database_url_wo = !var.write_only_secrets ? null : (!var.create_database ? lookup(var.preserved_secrets_wo, "DATABASE_URL", var.database_url) : format(
    "mysql://%s:%s@localhost/%s?socket=%s",
    google_sql_user.openwork[0].name,
    local.database_password_wo,
    google_sql_database.den[0].name,
    urlencode("/cloudsql/${google_sql_database_instance.this[0].connection_name}"),
  ))
}

resource "random_password" "db" {
  count = var.create_database && !var.write_only_secrets ? 1 : 0

  length  = 32
  special = false # embedded in DATABASE_URL
}

resource "google_sql_database_instance" "this" {
  count = var.create_database ? 1 : 0

  project             = var.project_id
  name                = "${var.name}-den"
  region              = var.region
  database_version    = var.database.database_version
  deletion_protection = var.database.deletion_protection != null ? var.database.deletion_protection : var.deletion_protection

  settings {
    tier                        = var.database.tier
    edition                     = var.database.edition
    availability_type           = var.database.availability_type
    disk_size                   = var.database.disk_size_gb
    disk_autoresize             = true
    user_labels                 = var.labels
    deletion_protection_enabled = var.database.deletion_protection != null ? var.database.deletion_protection : var.deletion_protection

    ip_configuration {
      # Public IP is used only by the Cloud Run connector (IAM-authorized,
      # verified TLS); no authorized networks are added.
      ipv4_enabled = true
    }

    backup_configuration {
      enabled            = var.database.backup_enabled
      binary_log_enabled = var.database.backup_enabled
    }
  }

}

resource "google_sql_database" "den" {
  count = var.create_database ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.this[0].name
  name     = "openwork_den"
}

resource "google_sql_user" "openwork" {
  count = var.create_database ? 1 : 0

  project             = var.project_id
  instance            = google_sql_database_instance.this[0].name
  name                = "openwork"
  host                = "%"
  password            = var.write_only_secrets ? null : random_password.db[0].result
  password_wo         = var.write_only_secrets ? lookup(var.preserved_secrets_wo, "DATABASE_PASSWORD", ephemeral.random_password.app["DATABASE_PASSWORD"].result) : null
  password_wo_version = var.write_only_secrets ? var.database_password_wo_version : null
}
