# Exercise the health building block without cloud credentials or reporting.
mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_region" { defaults = { name = "us-east-1", region = "us-east-1" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:health" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:function:health" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/health" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/health" }
  }
}
mock_provider "archive" {}

variables {
  name                 = "ow-test"
  compact_id           = "test"
  deployment_id        = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
  control_plane_origin = "https://control.example.test"
  interval_minutes     = 5
  web_url              = "https://openwork.example.com"
  api_url              = "https://api.openwork.example.com"
  cluster_name         = "test"
  cluster_arn          = "arn:aws:ecs:us-east-1:123456789012:cluster/test"
  service_names        = { den_api = "den-api", den_web = "den-web" }
  target_group_arns    = { den_api = "api-target", den_web = "web-target" }
  database_identifier  = "database"
  certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/test"
}

run "disabled_profile_preserves_health_environment_and_permissions" {
  command = apply
  module { source = "./modules/health-agent" }
  assert {
    condition = toset(keys(one(aws_lambda_function.agent.environment).variables)) == toset([
      "CONTROL_PLANE_ORIGIN", "DEPLOYMENT_ID", "WEB_URL", "API_URL", "CLUSTER_NAME",
      "SERVICE_NAMES", "TARGET_GROUP_ARNS", "DATABASE_IDENTIFIER", "CERTIFICATE_ARN",
    ])
    error_message = "With assistants off, the health Lambda retains exactly its original environment keys."
  }
  assert {
    condition     = aws_lambda_function.agent.handler == "health_agent.handler" && endswith(data.archive_file.agent.source_file, "/health/health_agent.py") && length(data.archive_file.agent.source) == 0
    error_message = "Disabled assistants retain the original one-file health payload and handler, so its code hash does not change."
  }
  assert {
    condition     = length(data.aws_iam_policy_document.agent.statement) == 5 && alltrue([for statement in data.aws_iam_policy_document.agent.statement : !contains(statement.actions, "elasticfilesystem:DescribeFileSystems") && !contains(statement.actions, "backup:ListRecoveryPointsByBackupVault")])
    error_message = "With assistants off, the health agent gets no new read permissions."
  }
}

run "optional_health_uses_resource_scoped_metadata_only_permissions" {
  command = apply
  module { source = "./modules/health-agent" }
  variables {
    workbot_url              = "https://chat.openwork.example.com"
    efs_file_system_id       = "fs-test"
    runner_backup_vault_name = "ow-test-runner"
    service_names            = { den_api = "den-api", den_web = "den-web", headless_runner = "headless-runner", workbot = "workbot" }
  }
  assert {
    condition     = aws_lambda_function.agent.handler == "assistant_health_agent.handler" && data.archive_file.agent.source_file == null && toset([for source in data.archive_file.agent.source : source.filename]) == toset(["health_agent.py", "assistant_health_agent.py"])
    error_message = "The optional entrypoint is packaged only when assistant services are enabled."
  }
  assert {
    condition     = one(aws_lambda_function.agent.environment).variables.WORKBOT_URL == "https://chat.openwork.example.com" && one(aws_lambda_function.agent.environment).variables.EFS_FILE_SYSTEM_ID == "fs-test" && one(aws_lambda_function.agent.environment).variables.RUNNER_BACKUP_VAULT_NAME == "ow-test-runner"
    error_message = "Optional health receives non-secret observation references."
  }
  assert {
    condition = alltrue([
      length(data.aws_iam_policy_document.agent.statement) == 7,
      length([for statement in data.aws_iam_policy_document.agent.statement : statement if statement.sid == "ReadRunnerStorageMetadata" && statement.actions == toset(["elasticfilesystem:DescribeFileSystems"]) && statement.resources == toset(["arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-test"])]) == 1,
      length([for statement in data.aws_iam_policy_document.agent.statement : statement if statement.sid == "ReadRunnerBackupMetadata" && statement.actions == toset(["backup:ListRecoveryPointsByBackupVault"]) && statement.resources == toset(["arn:aws:backup:us-east-1:123456789012:backup-vault:ow-test-runner"])]) == 1,
    ])
    error_message = "Optional read access is limited to the runner filesystem metadata and its backup vault metadata."
  }
}
