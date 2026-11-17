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
        { domain_name = "models.openwork.example.com", resource_record_name = "_d.models.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_d.acm-validations.aws." },
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

run "gateway_runtime_uses_five_native_services_without_global_model_key" {
  command = apply
  plan_options { replace = [aws_acm_certificate.this[0]] }
  variables {
    ai_gateway_enabled           = true
    ai_gateway_domain_name       = "models.openwork.example.com"
    ai_gateway_image             = "ghcr.io/different-ai/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    headless_runner              = { enabled = true, model_protocol = "openai", model_base_url = "https://models.openwork.example.com", model = "openai/gpt-6-luna" }
    headless_model_secret_arn    = ""
    headless_computer            = {}
    headless_computer_secret_arn = ""
    workbot                      = { enabled = true }
    slack_assistant_enabled      = true
    automations_enabled          = true
    tags = {
      expected_runner_version = run.enable_workbot_preserves_runner_and_core.runner_secret_version_id
      expected_filesystem     = run.enable_workbot_preserves_runner_and_core.efs_file_system_id
      expected_core_secret    = run.enable_workbot_preserves_runner_and_core.secret_arn
      expected_database       = run.enable_workbot_preserves_runner_and_core.database_identifier
    }
  }
  assert {
    condition     = output.runner_secret_version_id == var.tags.expected_runner_version && output.efs_file_system_id == var.tags.expected_filesystem && output.secret_arn == var.tags.expected_core_secret && output.database_identifier == var.tags.expected_database
    error_message = "Gateway adoption must preserve runner credentials, EFS and core data identities."
  }
  assert {
    condition = alltrue([
      toset(keys(output.service_names)) == toset(["den_api", "den_web", "ai_gateway", "headless_runner", "workbot"]),
      toset(keys(output.task_definition_arns)) == toset(["den_api", "den_web", "ai_gateway", "headless_runner", "workbot"]),
      toset(keys(output.log_groups)) == toset(["den_api", "den_web", "ai_gateway", "headless_runner", "workbot"]),
      toset(keys(output.target_group_arns)) == toset(["den_api", "den_web", "ai_gateway", "workbot"]),
      aws_ecs_service.ai_gateway[0].desired_count == 1 && aws_ecs_service.runner[0].desired_count == 1 && aws_ecs_service.workbot[0].desired_count == 1,
      aws_ecs_task_definition.ai_gateway[0].cpu == "1024" && aws_ecs_task_definition.ai_gateway[0].memory == "2048",
    ])
    error_message = "Gateway runtime verification must include all five intended native services and the Gateway's measured resource floor."
  }
  assert {
    condition = alltrue([
      toset([for secret in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets : secret.name]) == toset(["HEADLESS_API_TOKEN"]),
      toset(keys(local.runner_secret_values)) == toset(["HEADLESS_API_TOKEN"]),
      length(local.runner_external_secrets) == 0,
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment, { name = "HEADLESS_MODEL_BASE_URL", value = "https://models.openwork.example.com" }),
      contains(jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment, { name = "HEADLESS_MODEL", value = "openai/gpt-6-luna" }),
      var.headless_computer.provider == "off" && var.headless_computer.snapshot == "",
      toset([for secret in jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].secrets : secret.name]) == toset(["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"]),
    ])
    error_message = "Member-scoped Gateway turns need no shared upstream model credential, and computers off needs no key or snapshot."
  }
  assert {
    condition = alltrue([
      local.environment.GATEWAY_ENABLED == "true",
      local.environment.GATEWAY_PUBLIC_BASE_URL == "https://models.openwork.example.com",
      local.environment.DEN_SLACK_ASSISTANT_WORKER_ENABLED == "true",
      local.environment.DEN_AUTOMATIONS_ENABLED == "true",
      contains(aws_acm_certificate.this[0].subject_alternative_names, "models.openwork.example.com"),
      length(aws_route53_record.this) == 4,
    ])
    error_message = "The native module alone supplies canonical Gateway settings, Slack/Automations enablement, and the fourth TLS/DNS host."
  }
}

run "gateway_runtime_daytona_receives_only_computer_credential" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.openwork.example.com"
    ai_gateway_image          = "ghcr.io/different-ai/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    headless_runner           = { enabled = true, model_protocol = "openai", model_base_url = "https://models.openwork.example.com", model = "openai/gpt-6-luna" }
    headless_model_secret_arn = ""
    headless_computer         = { provider = "daytona", snapshot = "computer-image" }
    workbot                   = { enabled = true }
    slack_assistant_enabled   = true
  }
  assert {
    condition     = toset([for secret in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets : secret.name]) == toset(["HEADLESS_API_TOKEN", "DAYTONA_API_KEY"]) && length(output.service_names) == 5
    error_message = "Optional Daytona injects its computer credential, never a model key or another service."
  }
}

run "gateway_runtime_freestyle_receives_only_computer_credential" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.openwork.example.com"
    ai_gateway_image          = "ghcr.io/different-ai/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    headless_runner           = { enabled = true, model_protocol = "openai", model_base_url = "https://models.openwork.example.com", model = "openai/gpt-6-luna" }
    headless_model_secret_arn = ""
    headless_computer         = { provider = "freestyle" }
    workbot                   = { enabled = true }
    slack_assistant_enabled   = true
  }
  assert {
    condition     = toset([for secret in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets : secret.name]) == toset(["HEADLESS_API_TOKEN", "FREESTYLE_API_KEY"]) && var.headless_computer.snapshot == "" && length(output.service_names) == 5
    error_message = "Optional Freestyle injects only its computer credential and needs no Daytona snapshot."
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
