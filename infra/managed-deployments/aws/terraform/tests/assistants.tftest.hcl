# Managed-root opt-in contract; mocked plans are not a cloud qualification run.
mock_provider "aws" {
  mock_data "aws_availability_zones" { defaults = { names = ["us-east-1a", "us-east-1b"] } }
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_region" { defaults = { name = "us-east-1", region = "us-east-1" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/test"
      domain_validation_options = [
        { domain_name = "openwork.example.com", resource_record_name = "_a.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
        { domain_name = "api.openwork.example.com", resource_record_name = "_b.api.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
        { domain_name = "chat.openwork.example.com", resource_record_name = "_c.chat.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_c.acm-validations.aws." },
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
  mock_data "http" { defaults = { status_code = 200, response_body = "-----BEGIN CERTIFICATE-----test" } }
}

variables {
  deployment_id        = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.58"
  control_plane_origin = "https://control.example.test"
  region               = "us-east-1"
  account_id           = "123456789012"
  route53_zone_id      = "ZTEST123"
}

run "assistants_off_keeps_core_only_profile" {
  command = plan
  assert {
    condition     = !var.headless_runner.enabled && !var.workbot.enabled && !var.slack_assistant_enabled && var.headless_computer.provider == "off"
    error_message = "All assistant services and computers must remain off by default."
  }
  assert {
    condition     = output.workbot_url == null && output.efs_file_system_id == null && output.runner_backup_vault_name == null && toset(keys(output.service_names)) == toset(["den_api", "den_web"]) && toset(keys(output.task_definition_arns)) == toset(["den_api", "den_web"])
    error_message = "The disabled managed profile has only its existing core services and no assistant storage/backup references."
  }
}

run "direct_model_and_computer_references_reach_shared_module" {
  command = plan
  variables {
    headless_runner              = { enabled = true, model_protocol = "openai-responses", model_base_url = "https://models.example.test/v1", model = "test-model" }
    headless_runner_image        = "example.test/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    headless_model_secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:model-key-abcdef"
    headless_computer            = { provider = "freestyle" }
    headless_computer_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-key-abcdef"
    workbot                      = { enabled = true }
    workbot_image                = "example.test/workbot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    slack_assistant_enabled      = true
  }
  assert {
    condition     = output.workbot_url == "https://chat.openwork.example.com" && output.runner_backup_vault_name == "ow-0cf7aa5c4c1a-runner" && toset(keys(output.service_names)) == toset(["den_api", "den_web", "headless_runner", "workbot"]) && toset(keys(output.task_definition_arns)) == toset(["den_api", "den_web", "headless_runner", "workbot"])
    error_message = "The managed root reuses shared runner, Workbot and backup resources and exports their verification references."
  }
}

run "runner_installs_without_computer_provider" {
  command = plan
  variables {
    headless_runner           = { enabled = true, model = "test-model" }
    headless_runner_image     = "example.test/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    headless_model_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:model-key-abcdef"
  }
  assert {
    condition     = var.headless_computer.provider == "off" && var.headless_computer_secret_arn == "" && toset(keys(output.service_names)) == toset(["den_api", "den_web", "headless_runner"])
    error_message = "The runner must install without a computer provider, computer secret or sandbox provisioning."
  }
}

run "daytona_computer_is_optional_and_uses_external_reference" {
  command = plan
  variables {
    headless_runner              = { enabled = true, model = "test-model" }
    headless_runner_image        = "example.test/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    headless_model_secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:model-key-abcdef"
    headless_computer            = { provider = "daytona", snapshot = "computer-image" }
    headless_computer_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-key-abcdef"
    daytona                      = { api_url = "https://daytona.example.test/api", target = "test-target" }
  }
  assert {
    condition     = var.headless_computer.provider == "daytona" && var.headless_computer.snapshot == "computer-image" && toset(keys(output.service_names)) == toset(["den_api", "den_web", "headless_runner"])
    error_message = "Daytona configures optional runner tools without requiring OpenWork Web or a separate sandbox service."
  }
}

run "external_runner_is_not_an_installer_option" {
  command = plan
  variables { headless_runner = { external_url = "https://fleet.example.test" } }
  expect_failures = [var.headless_runner]
}

run "model_reference_must_belong_to_selected_account" {
  command = plan
  variables { headless_model_secret_arn = "arn:aws:secretsmanager:us-east-1:999999999999:secret:model-key-abcdef" }
  expect_failures = [var.headless_model_secret_arn]
}

run "computer_reference_cannot_select_json_field" {
  command = plan
  variables { headless_computer_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-key-abcdef:key::" }
  expect_failures = [var.headless_computer_secret_arn]
}
