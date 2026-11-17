# Mocked lifecycle and secret-reference coverage, not live AWS proof.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:openwork" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/openwork/abc" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/openwork/abc" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/openwork/abc/def" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/openwork" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_efs_file_system" {
    defaults = {
      arn        = "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-test"
      kms_key_id = "arn:aws:kms:us-east-1:123456789012:key/source"
    }
  }
  mock_resource "aws_backup_vault" {
    defaults = {
      arn         = "arn:aws:backup:us-east-1:123456789012:backup-vault:openwork-den-runner"
      kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/vault"
    }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc" }
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
}
mock_provider "random" {}

override_resource {
  target = aws_lambda_invocation.migrate
  values = { result = "{\"exitCode\":0,\"image\":\"ghcr.io/different-ai/openwork-den-api@sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e\"}" }
}

variables {
  openwork_version             = "0.18.58"
  write_only_secrets           = false
  managed_legacy_secrets       = true
  database_ca_bundle           = "-----BEGIN CERTIFICATE-----test"
  headless_runner_image        = "example.test/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  workbot_image                = "example.test/workbot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  vpc_id                       = "vpc-test"
  alb_subnet_ids               = ["subnet-a", "subnet-b"]
  service_subnet_ids           = ["subnet-a", "subnet-b"]
  database_subnet_ids          = ["subnet-c", "subnet-d"]
  owner_emails                 = ["admin@example.com"]
  domain_name                  = "openwork.example.com"
  route53_zone_id              = "Z123"
  headless_runner              = { enabled = true, model = "test-model", model_protocol = "openai-responses", model_base_url = "https://models.example.test/v1" }
  headless_model_secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:model-key-abcdef"
  headless_computer            = { provider = "daytona", snapshot = "computer-image" }
  headless_computer_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:computer-key-abcdef"
  daytona                      = { api_url = "https://daytona.example.test/api", target = "test-target" }
}

run "runner_without_workbot" {
  command = apply
  assert {
    condition     = !contains(keys(local.runner_secret_values), "WORKBOT_SESSION_SECRET") && !contains(keys(local.runner_secret_values), "HEADLESS_MODEL_API_KEY") && !contains(keys(local.runner_secret_values), "DAYTONA_API_KEY")
    error_message = "Managed runner versions contain no external credential values or optional Workbot session key."
  }
  assert {
    condition = alltrue([
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets, { name = "HEADLESS_MODEL_API_KEY", valueFrom = var.headless_model_secret_arn }),
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets, { name = "DAYTONA_API_KEY", valueFrom = var.headless_computer_secret_arn }),
      !strcontains(aws_ecs_task_definition.api_v1.container_definitions, var.headless_model_secret_arn),
      !strcontains(aws_ecs_task_definition.web_v1.container_definitions, var.headless_computer_secret_arn),
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment, { name = "DAYTONA_API_URL", value = var.daytona.api_url }),
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment, { name = "DAYTONA_TARGET", value = var.daytona.target }),
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment, { name = "HEADLESS_COMPUTER_SNAPSHOT", value = var.headless_computer.snapshot }),
    ])
    error_message = "Only the runner receives direct external secret references."
  }
  assert {
    condition     = length(aws_backup_vault.runner) == 1 && aws_backup_vault.runner[0].name == "${var.name}-runner" && one(aws_backup_plan.runner[0].rule).lifecycle[0].delete_after == 7 && one(aws_backup_plan.runner[0].rule).schedule == "cron(0 5 * * ? *)"
    error_message = "Managed runner storage gets encrypted daily seven-day backups."
  }
  assert {
    condition     = aws_backup_selection.runner[0].resources == toset([aws_efs_file_system.agents[0].arn]) && aws_iam_role.runner_backup[0].name == "${var.name}-runner-backup" && !aws_backup_vault.runner[0].force_destroy
    error_message = "Select only the runner filesystem and never force-delete recovery points."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.runner_backup[0].policy).Statement[0].Resource == aws_efs_file_system.agents[0].arn && !strcontains(aws_iam_role_policy.runner_backup[0].policy, "Restore") && !strcontains(aws_iam_role_policy.runner_backup[0].policy, "Delete")
    error_message = "The inline backup role is filesystem-scoped and has no restore/deletion access."
  }
}

run "enable_workbot_preserves_runner_and_core" {
  command = apply
  plan_options { replace = [aws_acm_certificate.this[0]] }
  variables {
    workbot = { enabled = true }
    tags = {
      expected_runner_version = run.runner_without_workbot.runner_secret_version_id
      expected_filesystem     = run.runner_without_workbot.efs_file_system_id
      expected_core_secret    = run.runner_without_workbot.secret_arn
      expected_database       = run.runner_without_workbot.database_identifier
    }
  }
  assert {
    condition     = output.runner_secret_version_id == var.tags.expected_runner_version && output.efs_file_system_id == var.tags.expected_filesystem && output.secret_arn == var.tags.expected_core_secret && output.database_identifier == var.tags.expected_database
    error_message = "Enabling Workbot preserves the runner credential version, filesystem and core identities."
  }
  assert {
    condition     = length(aws_secretsmanager_secret.workbot) == 1 && !contains(keys(local.runner_secret_values), "WORKBOT_SESSION_SECRET") && local.workbot_session_secret_ref == "${aws_secretsmanager_secret.workbot[0].arn}:WORKBOT_SESSION_SECRET::"
    error_message = "The new Workbot session key lives in its own secret rather than replacing the runner version."
  }
  assert {
    condition     = contains(keys(output.task_definition_arns), "headless_runner") && contains(keys(output.task_definition_arns), "workbot") && contains(keys(output.target_group_arns), "workbot")
    error_message = "Verification outputs include intended optional service revisions and the Workbot target group."
  }
}

run "workbot_certificate_replacement_has_valid_dependency_graph" {
  command = plan
  variables {
    workbot = { enabled = true }
    tags = {
      expected_runner_version = run.enable_workbot_preserves_runner_and_core.runner_secret_version_id
      expected_filesystem     = run.enable_workbot_preserves_runner_and_core.efs_file_system_id
      expected_core_secret    = run.enable_workbot_preserves_runner_and_core.secret_arn
      expected_database       = run.enable_workbot_preserves_runner_and_core.database_identifier
    }
  }
  plan_options { replace = [aws_acm_certificate.this[0]] }
  assert {
    condition     = contains(aws_acm_certificate.this[0].subject_alternative_names, "chat.openwork.example.com") && output.runner_secret_version_id == var.tags.expected_runner_version
    error_message = "Replacing the certificate retains the runner version and covers Workbot."
  }
}

run "external_references_unused_while_disabled" {
  command = apply
  variables {
    headless_runner   = {}
    headless_computer = {}
  }
  assert {
    condition     = length(local.runner_external_secrets) == 0 && length(aws_backup_vault.runner) == 0 && length(aws_backup_plan.runner) == 0 && length(aws_backup_selection.runner) == 0 && length(aws_iam_role.runner_backup) == 0 && output.efs_file_system_id == null && output.runner_backup_vault_name == null
    error_message = "Disabled assistants add no backup resources, filesystem or external-secret permissions."
  }
}

run "reject_conflicting_model_credentials" {
  command = plan
  variables { headless_model_api_key = "test-key" }
  expect_failures = [var.headless_model_secret_arn]
}

run "reject_secret_json_key_suffix" {
  command = plan
  variables { headless_model_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:model-key-abcdef:api_key::" }
  expect_failures = [var.headless_model_secret_arn]
}
