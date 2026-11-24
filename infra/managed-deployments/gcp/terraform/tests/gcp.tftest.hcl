mock_provider "google" {}
provider "random" {} # Local-only; ephemeral mocks are unsupported.

override_data {
  target = data.google_project.target
  values = { number = "123456789012" }
}
override_data {
  target = data.google_dns_managed_zone.target
  values = { dns_name = "example.com.", visibility = "public" }
}
variables {
  deployment_id        = "12345678-1234-1234-1234-123456789012"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.0"
  control_plane_origin = "https://api.example.com"
  size                 = "small"
  project_id           = "test-project"
  project_number       = "123456789012"
  region               = "us-central1"
  dns_zone_name        = "public-zone"
  images = {
    den_api = "us-central1-docker.pkg.dev/test-project/ow-123456781234/den_api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    den_web = "us-central1-docker.pkg.dev/test-project/ow-123456781234/den_web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    health  = "us-central1-docker.pkg.dev/test-project/ow-123456781234/health@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}
run "contract_and_security" {
  command = plan
  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com" && output.setup_url == "https://openwork.example.com/setup"
    error_message = "GCP must implement the same provider-neutral URL contract."
  }
  assert {
    condition     = module.platform.database_instance_name == "ow-123456781234-mysql" && module.platform.migration_job_name == "ow-123456781234-migrate"
    error_message = "Shared adoption must preserve the database and migration job identities."
  }
  assert {
    condition     = google_cloud_run_v2_job.health.template[0].template[0].service_account == "ow-123456781234-health@test-project.iam.gserviceaccount.com"
    error_message = "Health must use the dedicated identity."
  }
  assert {
    condition     = google_cloud_scheduler_job.health.http_target[0].oauth_token[0].service_account_email != google_cloud_run_v2_job.health.template[0].template[0].service_account
    error_message = "Scheduler invocation and health report identities must be separate."
  }
  assert {
    condition     = output.service_names == { den_api = "ow-123456781234-api", den_web = "ow-123456781234-web" }
    error_message = "Existing managed service names must be preserved."
  }
}
run "wrong_project_is_blocked" {
  command = plan
  variables { project_number = "999999999999" }
  expect_failures = [terraform_data.target]
}
run "unrelated_dns_is_blocked" {
  command = plan
  variables { domain_name = "openwork.unrelated.test" }
  expect_failures = [terraform_data.target]
}
run "foreign_image_is_blocked" {
  command = plan
  variables {
    images = {
      den_api = "us-central1-docker.pkg.dev/foreign-project/ow-123456781234/den_api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      den_web = "us-central1-docker.pkg.dev/test-project/ow-123456781234/den_web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      health  = "us-central1-docker.pkg.dev/test-project/ow-123456781234/health@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
  expect_failures = [terraform_data.target]
}
