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

run "defaults_use_run_app_urls" {
  command = apply

  assert {
    condition     = output.web_url == "https://openwork-den-web-123456789012.us-central1.run.app"
    error_message = "web_url should be den-web's deterministic run.app URL."
  }
  assert {
    condition     = output.api_url == "https://openwork-den-api-123456789012.us-central1.run.app"
    error_message = "api_url should be den-api's deterministic run.app URL."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.name == "openwork-den-api" && google_cloud_run_v2_service.web.name == "openwork-den-web"
    error_message = "The service names must match the run.app URLs the env points at."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.invoker_iam_disabled && google_cloud_run_v2_service.web.invoker_iam_disabled
    error_message = "Services must be publicly reachable by default (Den does its own sign-in)."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.ingress == "INGRESS_TRAFFIC_ALL" && !google_cloud_run_v2_service.api.default_uri_disabled
    error_message = "Without domain_name the run.app URL must stay reachable."
  }
  assert {
    condition     = length(google_compute_url_map.https) == 0 && output.load_balancer_ip == null
    error_message = "No load balancer without domain_name."
  }
}

run "env_matches_cloud_run_runbook" {
  command = apply

  assert {
    condition = alltrue([
      for k, v in {
        DEN_BASE_URL                    = "https://openwork-den-web-123456789012.us-central1.run.app"
        BETTER_AUTH_URL                 = "https://openwork-den-web-123456789012.us-central1.run.app"
        DEN_API_PUBLIC_URL              = "https://openwork-den-api-123456789012.us-central1.run.app"
        DEN_MCP_RESOURCE_URL            = "https://openwork-den-api-123456789012.us-central1.run.app/mcp"
        DEN_BETTER_AUTH_TRUSTED_ORIGINS = "https://openwork-den-web-123456789012.us-central1.run.app"
        DEN_WEB_APP_HOSTS               = "openwork-den-web-123456789012.us-central1.run.app"
        DEN_API_BASE                    = "https://openwork-den-api-123456789012.us-central1.run.app"
        DEN_ORG_MODE                    = "single_org"
        DEN_SINGLE_ORG_OWNER_EMAILS     = "admin@example.com"
        DEN_BOOTSTRAP_ADMIN_EMAILS      = "admin@example.com"
        OPENWORK_DEV_MODE               = "0"
        DB_MODE                         = "mysql"
        PROVISIONER_MODE                = "stub"
      } : contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "${k}=${v}")
    ])
    error_message = "den-api must get the same env as packaging/cloud-run/openwork-den-api.yaml."
  }
  assert {
    condition     = !contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name], "PORT")
    error_message = "PORT is reserved by Cloud Run and must not be set."
  }
  assert {
    condition = toset([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : e.name if length(e.value_source) > 0]) == toset([
      "DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE",
    ])
    error_message = "den-api must read exactly the four generated secrets from Secret Manager."
  }
  assert {
    condition = alltrue([
      for c in [google_cloud_run_v2_service.api.template[0].containers[0], google_cloud_run_v2_service.web.template[0].containers[0], google_cloud_run_v2_job.migrate.template[0].template[0].containers[0]] :
      length([for e in c.env : e.name if contains(["DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"], e.name) && length(e.value_source) == 0]) == 0
    ])
    error_message = "No secret may be passed as a plain environment variable."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].ports[0].container_port == 8788 && google_cloud_run_v2_service.web.template[0].containers[0].ports[0].container_port == 3005
    error_message = "Container ports must match the images (8788 den-api, 3005 den-web)."
  }
}

run "migration_job_runs_bootstrap" {
  command = apply

  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].args == tolist(["/app/ee/packages/den-db/dist/scripts/bootstrap.js"])
    error_message = "The migration job must run the den-db bootstrap script, like the Helm pre-upgrade Job."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].max_retries == 0
    error_message = "A failed migration must not be retried silently."
  }
  assert {
    condition     = length(google_cloud_run_v2_job.migrate.run_execution_token) == 12
    error_message = "The job must run during apply (run_execution_token)."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].containers[0].image == google_cloud_run_v2_service.api.template[0].containers[0].image
    error_message = "Migrations must use the den-api image."
  }
}

run "two_api_replicas_do_not_add_migrators" {
  command = apply
  variables { den_api = { min_instances = 2, max_instances = 2 } }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].scaling[0].min_instance_count == 2 && length(google_cloud_run_v2_service.api.template[0].containers) == 1 && google_cloud_run_v2_service.api.template[0].containers[0].command == null && google_cloud_run_v2_service.api.template[0].containers[0].args == null
    error_message = "API scale must not add a migration/init container or override the API image command."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].task_count == 1 && google_cloud_run_v2_job.migrate.template[0].template[0].max_retries == 0
    error_message = "Exactly one migration task and no hidden retry per deployment."
  }
  assert {
    condition     = google_cloud_run_v2_service.api.template[0].containers[0].resources[0].limits["cpu"] == "1" && google_cloud_run_v2_service.api.template[0].containers[0].resources[0].limits["memory"] == "2Gi" && google_cloud_run_v2_service.web.template[0].containers[0].resources[0].limits["memory"] == "1Gi"
    error_message = "Measured baseline sizing must remain 1 CPU/2 GiB API and 1 CPU/1 GiB web."
  }
}

run "migration_reruns_on_new_version" {
  command = plan

  variables {
    image_digests = { den_api = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", den_web = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }

  assert {
    condition     = google_cloud_run_v2_job.migrate.run_execution_token != substr(sha256("us-central1-docker.pkg.dev/test-project/openwork-ghcr/different-ai/openwork-den-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|1"), 0, 12)
    error_message = "A new den-api image digest must change the migration token."
  }
}

run "images_default_to_ghcr_mirror" {
  command = apply

  assert {
    condition     = length(google_artifact_registry_repository.ghcr) == 1 && google_artifact_registry_repository.ghcr[0].remote_repository_config[0].docker_repository[0].custom_repository[0].uri == "https://ghcr.io"
    error_message = "A ghcr.io remote repository must be created by default."
  }
  assert {
    condition     = output.images.den_api == "us-central1-docker.pkg.dev/test-project/openwork-ghcr/different-ai/openwork-den-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    error_message = "den-api must be pulled through the mirror, pinned by digest."
  }
}

run "custom_images_skip_mirror" {
  command = apply

  variables {
    den_api_image = "us-docker.pkg.dev/acme/openwork/openwork-den-api@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    den_web_image = "us-docker.pkg.dev/acme/openwork/openwork-den-web@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  }

  assert {
    condition     = length(google_artifact_registry_repository.ghcr) == 0
    error_message = "No mirror is needed when both images are set."
  }
  assert {
    condition     = google_cloud_run_v2_service.web.template[0].containers[0].image == var.den_web_image
    error_message = "den-web must use den_web_image."
  }
}

run "existing_network_uses_direct_vpc_egress" {
  command = apply

  variables {
    network    = "projects/test-project/global/networks/shared"
    subnetwork = "projects/test-project/regions/us-central1/subnetworks/run"
  }

  assert {
    condition = alltrue([
      for r in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.web] :
      r.template[0].vpc_access[0].network_interfaces[0].subnetwork == var.subnetwork && r.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    ])
    error_message = "Both services must egress through the given subnetwork."
  }
  assert {
    condition     = google_cloud_run_v2_job.migrate.template[0].template[0].vpc_access[0].network_interfaces[0].network == var.network
    error_message = "The migration job must use the same network."
  }
}

run "network_needs_subnetwork" {
  command = plan

  variables {
    network = "projects/test-project/global/networks/shared"
  }

  expect_failures = [google_cloud_run_v2_job.migrate]
}

run "existing_service_account" {
  command = apply

  variables {
    service_account_email = "platform@test-project.iam.gserviceaccount.com"
  }

  assert {
    condition     = length(google_service_account.run) == 0 && google_cloud_run_v2_service.api.template[0].service_account == var.service_account_email
    error_message = "An existing service account must be used as is."
  }
  assert {
    condition     = google_project_iam_member.cloudsql_client[0].member == "serviceAccount:${var.service_account_email}"
    error_message = "The existing service account still needs Cloud SQL client."
  }
}

run "smtp_password_becomes_a_secret" {
  command = apply

  variables {
    smtp = { host = "smtp.example.com", username = "u", password = "p" }
  }

  assert {
    condition     = contains(keys(google_secret_manager_secret.app), "SMTP_PASS") && google_secret_manager_secret.app["SMTP_PASS"].secret_id == "openwork-den-smtp-pass"
    error_message = "SMTP_PASS must be stored in Secret Manager."
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.api.template[0].containers[0].env : "${e.name}=${e.value == null ? "" : e.value}"], "SMTP_HOST=smtp.example.com")
    error_message = "SMTP_HOST must be set."
  }
}

run "iam_granted_elsewhere" {
  command = apply

  variables {
    service_account_email = "platform@test-project.iam.gserviceaccount.com"
    grant_iam_roles       = false
  }

  assert {
    condition     = length(google_project_iam_member.cloudsql_client) == 0 && length(google_secret_manager_secret_iam_member.app) == 0
    error_message = "No IAM bindings when grant_iam_roles = false."
  }
  assert {
    condition     = length(google_secret_manager_secret.app) == 4
    error_message = "Secrets are still created in Secret Manager."
  }
}

run "null_optional_inputs_mean_unset" {
  command = apply

  # A root module often passes one(resource[*].id), which is null when the
  # resource is not created; that must behave like "not set".
  variables {
    network                  = null
    subnetwork               = null
    load_balancer_ip_address = null
  }

  assert {
    condition     = length(google_cloud_run_v2_job.migrate.template[0].template[0].vpc_access) == 0 && length(google_cloud_run_v2_service.api.template[0].vpc_access) == 0
    error_message = "A null network must not add Direct VPC egress."
  }
}

run "unpinned_published_images_are_refused" {
  command = plan

  variables {
    image_digests = {}
  }

  expect_failures = [google_cloud_run_v2_job.migrate]
}

run "plain_secret_override_is_refused" {
  command = plan
  variables { extra_environment = { BETTER_AUTH_SECRET = "not-a-real-secret" } }
  expect_failures = [var.extra_environment]
}

run "custom_secret_plain_duplicate_is_refused" {
  command = plan
  variables {
    extra_secrets     = { CUSTOM_CREDENTIAL = "existing-secret" }
    extra_environment = { CUSTOM_CREDENTIAL = "not-a-real-secret" }
  }
  expect_failures = [var.extra_environment]
}

run "mutable_tags_need_explicit_opt_in" {
  command = apply

  variables {
    image_digests            = {}
    allow_mutable_image_tags = true
  }

  assert {
    condition     = output.images.den_web == "us-central1-docker.pkg.dev/test-project/openwork-ghcr/different-ai/openwork-den-web:0.0.0-test"
    error_message = "With the opt-in, the tag is used."
  }
}

run "invalid_digest_is_rejected" {
  command = plan

  variables {
    image_digests = { den_api = "latest" }
  }

  expect_failures = [var.image_digests]
}

run "custom_image_tags_are_refused" {
  command = plan

  variables {
    den_api_image = "us-docker.pkg.dev/acme/openwork/openwork-den-api:1"
    den_web_image = "us-docker.pkg.dev/acme/openwork/openwork-den-web:1"
  }

  expect_failures = [google_cloud_run_v2_job.migrate]
}
