# Tuning from deployments/<id>/overrides.json. test_gcp_tune_eject.py reads the
# planned values of the first three runs.
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
run "profile_without_overrides" {
  command = plan
}
run "overrides_within_allowlist_are_applied" {
  command = plan
  variables {
    overrides = {
      api               = { cpu = 4096, memory = 8192, min_instances = 2, max_instances = 20 }
      web               = { memory = 2048 }
      database          = { tier = "db-custom-2-7680", disk_size_gb = 50, high_availability = true }
      extra_environment = { OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com", OTEL_SERVICE_NAME = "openwork" }
    }
  }
}
run "unlisted_settings_never_reach_the_platform" {
  command = plan
  # Terraform discards attributes the typed variable does not declare, so even
  # a hand-edited input file cannot tune the database version or protection.
  variables {
    overrides = {
      database           = { database_version = "MYSQL_8_4", deletion_protection = false, backup_enabled = false }
      log_retention_days = 90
    }
  }
}
run "memory_outside_the_cpu_range_is_blocked" {
  command = plan
  variables { overrides = { api = { memory = 16384 } } }
  expect_failures = [var.overrides]
}
run "memory_that_is_not_whole_gibibytes_is_blocked" {
  command = plan
  variables { overrides = { api = { memory = 3000 } } }
  expect_failures = [var.overrides]
}
run "unsupported_cpu_is_blocked" {
  command = plan
  variables { overrides = { api = { cpu = 3072 } } }
  expect_failures = [var.overrides]
}
run "cpu_below_the_profile_is_blocked" {
  command = plan
  variables { overrides = { api = { cpu = 1024 } } }
  expect_failures = [var.overrides]
}
run "memory_below_the_profile_is_blocked" {
  command = plan
  variables { overrides = { api = { cpu = 2048, memory = 1024 } } }
  expect_failures = [var.overrides]
}
run "scale_to_zero_is_blocked" {
  command = plan
  variables { overrides = { api = { min_instances = 0 } } }
  expect_failures = [var.overrides]
}
run "minimum_above_maximum_is_blocked" {
  command = plan
  variables { overrides = { web = { min_instances = 5, max_instances = 2 } } }
  expect_failures = [var.overrides]
}
run "maximum_of_zero_is_blocked" {
  command = plan
  variables { overrides = { web = { max_instances = 0 } } }
  expect_failures = [var.overrides]
}
run "shared_core_database_tier_is_blocked" {
  command = plan
  variables { overrides = { database = { tier = "db-f1-micro" } } }
  expect_failures = [var.overrides]
}
run "disk_below_the_profile_is_blocked" {
  command = plan
  variables { overrides = { database = { disk_size_gb = 10 } } }
  expect_failures = [var.overrides]
}
run "credential_bearing_environment_is_blocked" {
  command = plan
  variables { overrides = { extra_environment = { OTEL_EXPORTER_OTLP_HEADERS = "authorization=fixture" } } }
  expect_failures = [var.overrides]
}
run "credentials_in_a_url_are_blocked" {
  command = plan
  variables { overrides = { extra_environment = { OTEL_EXPORTER_OTLP_ENDPOINT = "https://user:fixture@otel.example.com" } } }
  expect_failures = [var.overrides]
}
run "environment_outside_the_prefix_is_blocked" {
  command = plan
  variables { overrides = { extra_environment = { DEN_BETTER_AUTH_URL = "https://evil.example.com" } } }
  expect_failures = [var.overrides]
}
