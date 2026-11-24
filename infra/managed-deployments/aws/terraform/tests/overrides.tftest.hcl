# Offline checks of customer tuning (overrides.json). Mocked providers: no AWS
# credentials and no network. `terraform test`.

mock_provider "aws" {
  override_during = plan
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1", region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/test"
      domain_validation_options = [
        { domain_name = "openwork.example.com", resource_record_name = "_a.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
        { domain_name = "api.openwork.example.com", resource_record_name = "_b.api.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
      ]
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/test" }
  }
}
mock_provider "random" {}
mock_provider "archive" {}
mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200, response_body = "-----BEGIN CERTIFICATE-----test" }
  }
}

variables {
  deployment_id        = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.57"
  control_plane_origin = "https://api.openworklabs.com"
  region               = "us-east-1"
  account_id           = "123456789012"
  route53_zone_id      = "ZTEST123"
}

run "no_overrides_keeps_every_platform_input" {
  command = plan
  assert {
    condition     = local.tuned.den_api == { cpu = 1024, memory = 2048, desired_count = 1 } && local.tuned.den_web == { cpu = 512, memory = 1024, desired_count = 1 }
    error_message = "Without overrides the services keep the small profile."
  }
  assert {
    condition = local.platform_database == {
      instance_class        = "db.t4g.micro", allocated_storage_gb = 20, max_allocated_storage = 100, multi_az = false,
      backup_retention_days = 7, deletion_protection = true, skip_final_snapshot = false, apply_immediately = true
    }
    error_message = "Without overrides the database keeps the small profile and its fixed protections."
  }
  assert {
    condition     = local.platform_extra_environment == { OPENWORK_MANAGED_TASK_REVISION = "" } && local.tuned.log_retention_days == 30
    error_message = "Without overrides no environment variable is added and logs keep 30 days."
  }
}

run "trust_roots_must_be_certificates" {
  command = plan
  variables { database_ca_bundle = "-----BEGIN PRIVATE KEY-----" }
  expect_failures = [var.database_ca_bundle]
}

run "allowlisted_overrides_are_applied" {
  command = plan
  variables {
    overrides = {
      api                = { cpu = 2048, memory = 4096, min_instances = 2, max_instances = 2 }
      web                = { min_instances = 3 }
      database           = { tier = "db.m7g.large", disk_size_gb = 200, high_availability = true }
      extra_environment  = { OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example.com:4318", OTEL_SERVICE_NAME = "openwork" }
      log_retention_days = 90
    }
  }
  assert {
    condition     = local.tuned.den_api == { cpu = 2048, memory = 4096, desired_count = 2 } && local.tuned.den_web == { cpu = 512, memory = 1024, desired_count = 3 }
    error_message = "Task size and count follow the overrides; unset values keep the profile."
  }
  assert {
    condition = local.platform_database == {
      instance_class        = "db.m7g.large", allocated_storage_gb = 200, max_allocated_storage = 400, multi_az = true,
      backup_retention_days = 7, deletion_protection = true, skip_final_snapshot = false, apply_immediately = true
    }
    error_message = "Database tier, disk and high availability follow the overrides; protections stay fixed."
  }
  assert {
    condition = local.platform_extra_environment == {
      OPENWORK_MANAGED_TASK_REVISION = "", OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example.com:4318", OTEL_SERVICE_NAME = "openwork"
    } && local.tuned.log_retention_days == 90
    error_message = "OTEL_ variables are added and log retention follows the override."
  }
}

run "an_override_cannot_carry_other_settings" {
  command = plan
  variables {
    # Attributes outside the type are dropped by Terraform; the installer refuses them earlier.
    overrides = { database = { tier = "db.t4g.small", engine_version = "5.7", deletion_protection = false, skip_final_snapshot = true, backup_retention_days = 0 } }
  }
  assert {
    condition = local.platform_database == {
      instance_class        = "db.t4g.small", allocated_storage_gb = 20, max_allocated_storage = 100, multi_az = false,
      backup_retention_days = 7, deletion_protection = true, skip_final_snapshot = false, apply_immediately = true
    }
    error_message = "Engine version, deletion protection, final snapshot and backups are never overridable."
  }
}

run "reject_environment_outside_the_otel_prefix" {
  command = plan
  variables { overrides = { extra_environment = { DATABASE_URL = "mysql://elsewhere" } } }
  expect_failures = [var.overrides]
}

run "reject_credential_carrying_otel_variables" {
  command = plan
  variables { overrides = { extra_environment = { OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer abc" } } }
  expect_failures = [var.overrides]
}

run "reject_credentials_inside_an_otel_url" {
  command = plan
  variables { overrides = { extra_environment = { OTEL_EXPORTER_OTLP_ENDPOINT = "https://user:pass@collector.example.com" } } }
  expect_failures = [var.overrides]
}

run "reject_sizes_fargate_does_not_offer" {
  command = plan
  variables { overrides = { api = { cpu = 2048 } } }
  expect_failures = [var.overrides]
}

run "reject_sizes_below_the_profile" {
  command = plan
  variables { overrides = { web = { cpu = 256, memory = 512 } } }
  expect_failures = [var.overrides]
}

run "reject_a_count_range" {
  command = plan
  variables { overrides = { api = { min_instances = 1, max_instances = 4 } } }
  expect_failures = [var.overrides]
}

run "reject_zero_instances" {
  command = plan
  variables { overrides = { web = { min_instances = 0 } } }
  expect_failures = [var.overrides]
}

run "reject_unknown_database_tier" {
  command = plan
  variables { overrides = { database = { tier = "db.x2g.16xlarge" } } }
  expect_failures = [var.overrides]
}

run "reject_a_disk_below_the_profile" {
  command = plan
  variables { overrides = { database = { disk_size_gb = 10 } } }
  expect_failures = [var.overrides]
}

run "reject_unsupported_log_retention" {
  command = plan
  variables { overrides = { log_retention_days = 1 } }
  expect_failures = [var.overrides]
}
