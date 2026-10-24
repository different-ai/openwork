mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
  mock_resource "google_sql_database_instance" { defaults = { connection_name = "test-project:us-central1:ow-example-mysql" } }
}
provider "random" {}
variables {
  project_id                        = "test-project"
  name                              = "ow-example"
  owner_emails                      = ["admin@example.com"]
  openwork_version                  = "0.18.58"
  managed_legacy                    = true
  write_only_secrets                = false
  service_account_email             = "runtime@test-project.iam.gserviceaccount.com"
  web_service_account_email         = "web@test-project.iam.gserviceaccount.com"
  domain_name                       = "openwork.example.com"
  den_api_image                     = "us-central1-docker.pkg.dev/test-project/ow-example/den_api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  den_web_image                     = "us-central1-docker.pkg.dev/test-project/ow-example/den_web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  create_image_mirror               = false
  public_access                     = false
  restrict_ingress_to_load_balancer = true
  database                          = { database_version = "MYSQL_8_0", tier = "db-custom-1-3840", disk_size_gb = 20 }
}
run "managed_maintenance_prepares_disabled_revisions" {
  command = plan
  variables { managed_maintenance = true }
  assert {
    condition     = alltrue([for service in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.web] : service.scaling[0].scaling_mode == "MANUAL" && service.scaling[0].manual_instance_count == 0])
    error_message = "Migration and revision preparation must not resume any legacy service."
  }
}
run "managed_compatibility" {
  command = apply
  assert {
    condition     = google_sql_user.openwork[0].host == ""
    error_message = "Managed SQL user must retain its observed empty legacy host identity."
  }
  assert {
    condition     = google_sql_database_instance.this[0].name == "ow-example-mysql" && google_sql_database_instance.this[0].database_version == "MYSQL_8_0" && google_sql_database_instance.this[0].deletion_protection && google_sql_database_instance.this[0].settings[0].deletion_protection_enabled
    error_message = "Adoption must retain protected MySQL 8.0 and the old physical name."
  }
  assert {
    condition     = alltrue([for password in [random_password.db[0], random_password.better_auth[0], random_password.db_encryption[0], random_password.bootstrap_code[0]] : password.length == 48 && !password.special])
    error_message = "Legacy generators must not rotate due to changed lengths."
  }
  assert {
    condition     = output.secret_ids == { DATABASE_URL = "ow-example-database-url", BETTER_AUTH_SECRET = "ow-example-auth", DEN_DB_ENCRYPTION_KEY = "ow-example-encryption", DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = "ow-example-bootstrap" }
    error_message = "Existing managed secret IDs must be retained."
  }
  assert {
    condition     = google_cloud_run_v2_service.web.template[0].service_account == var.web_service_account_email && length(google_cloud_run_v2_service.web.template[0].volumes) == 0 && alltrue([for env in google_cloud_run_v2_service.web.template[0].containers[0].env : length(env.value_source) == 0]) && length(google_project_iam_member.cloudsql_client) == 0
    error_message = "Web must retain its unprivileged identity; bootstrap remains project-IAM owner."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].command == tolist(["node"]) && google_cloud_run_v2_service.api.template[0].containers[0].args == tolist(["/app/ee/apps/den-api/dist/main.js"]) && google_cloud_run_v2_job.migrate.template[0].template[0].max_retries == 0 && google_cloud_run_v2_job.migrate.run_execution_token != ""
    error_message = "One native migration, never a per-replica migration command."
  }
  assert {
    condition     = google_compute_global_address.lb[0].name == "ow-example-ip" && google_compute_managed_ssl_certificate.this[0].name == "ow-example-tls" && google_compute_target_https_proxy.this[0].name == "ow-example-https" && google_compute_url_map.https[0].name == "ow-example-routes" && google_compute_region_network_endpoint_group.run["api"].name == "ow-example-api-neg" && google_compute_backend_service.run["web"].name == "ow-example-web-backend" && google_compute_backend_service.run["api"].protocol == "HTTP"
    error_message = "The managed LB and connector identities/protocol must not be replaced."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.scaling[0].scaling_mode == "AUTOMATIC" && google_cloud_run_v2_service.web.scaling[0].scaling_mode == "AUTOMATIC" && google_cloud_run_v2_service.api.traffic[0].percent == 100 && google_cloud_run_v2_service.api.traffic[0].type == "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    error_message = "Migration-gated rollout must explicitly restore autoscaling and latest-only traffic."
  }
}
