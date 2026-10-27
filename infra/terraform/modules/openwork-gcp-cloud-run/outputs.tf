output "web_url" {
  description = "Den web URL (the run.app URL, or https://<domain_name>)."
  value       = local.web_url
}

output "api_url" {
  description = "Den API public URL (DEN_API_PUBLIC_URL)."
  value       = local.api_url
}

output "setup_url" {
  description = "One-time first-administrator page. Works only while the database has no users."
  value       = "${local.web_url}/setup"
}

output "bootstrap_code" {
  description = "Code to enter at /setup in legacy mode. Null in write-only mode: retrieve the setup-code secret directly from Secret Manager."
  value       = var.write_only_secrets ? null : local.bootstrap_code
  sensitive   = true
}

output "load_balancer_ip" {
  description = "Load balancer IPv4 address: point domain_name and the API host (A records) at it. Null without domain_name."
  value       = local.lb_ip
}

output "dns_records" {
  description = "A records to create for the custom hostnames. Empty without domain_name."
  value       = local.create_lb ? { (var.domain_name) = local.lb_ip, (local.api_host) = local.lb_ip } : {}
}

output "service_names" {
  description = "Cloud Run service names."
  value       = { api = google_cloud_run_v2_service.api.name, web = google_cloud_run_v2_service.web.name }
}

output "migration_job_name" {
  description = "Cloud Run job that runs database migrations. Execute it again with: gcloud run jobs execute <name> --region <region> --wait."
  value       = google_cloud_run_v2_job.migrate.name
}

output "database_instance_name" {
  description = "Cloud SQL instance name. Null with an existing database."
  value       = one(google_sql_database_instance.this[*].name)
}

output "database_identifier" {
  description = "Common database identifier: managed Cloud SQL instance ID; existing Cloud SQL connection name when supplied; empty for an external non-Cloud-SQL database. Existing database_instance_name/cloud_sql_connection_name outputs remain available."
  value       = var.create_database ? google_sql_database_instance.this[0].id : local.cloud_sql_connection_name
}

output "migration_step_identifier" {
  description = "Common migration step identifier: the full Cloud Run job resource ID. migration_job_name remains available."
  value       = google_cloud_run_v2_job.migrate.id
}

output "cloud_sql_connection_name" {
  description = "PROJECT:REGION:INSTANCE mounted at /cloudsql. Empty for a private-IP or external database."
  value       = local.cloud_sql_connection_name
}

output "service_account_email" {
  description = "Service account the services and migration job run as."
  value       = local.service_account_email
}

output "secret_ids" {
  description = "Secret Manager secret IDs the module created, by env var name."
  value       = { for k, s in google_secret_manager_secret.app : k => s.secret_id }
}

output "images" {
  description = "Images the services run."
  value       = { den_api = local.den_api_image, den_web = local.den_web_image }
}
