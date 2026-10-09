# Offline checks (mocked AWS provider): terraform init && terraform test

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
  mock_resource "aws_security_group" {
    defaults = { id = "sg-created" }
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
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" }
  }
}

mock_provider "random" {}

variables {
  openwork_version    = "0.0.0-test"
  vpc_id              = "vpc-123"
  alb_subnet_ids      = ["subnet-a", "subnet-b"]
  service_subnet_ids  = ["subnet-a", "subnet-b"]
  database_subnet_ids = ["subnet-c", "subnet-d"]
  owner_emails        = ["admin@example.com"]
  domain_name         = "openwork.example.com"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  route53_zone_id     = "Z123"
}

run "agents_off_by_default" {
  command = apply

  assert {
    condition     = length(aws_ecs_service.runner) == 0 && length(aws_ecs_service.workbot) == 0 && length(aws_efs_file_system.agents) == 0
    error_message = "No runner, Workbot or EFS while they are off."
  }
  assert {
    condition     = alltrue([for k in ["DEN_HEADLESS_RUNNER_URL", "DEN_FEATURE_SLACK_ASSISTANT", "DEN_WORKBOT_URL", "DEN_AUTOMATIONS_RUNTIME_ENABLED"] : !contains([for e in local.environment_list : e.name], k)])
    error_message = "No runner, Slack or Workbot settings while they are off."
  }
  assert {
    condition     = length(aws_ecs_service.api.service_connect_configuration) == 0
    error_message = "den-api needs no Service Connect without the runner."
  }
}

run "runner_workbot_and_slack" {
  command = apply

  variables {
    automations_enabled     = true
    slack_assistant_enabled = true
    headless_model_api_key  = "sk-test"
    headless_runner = {
      enabled = true
      model   = "claude-test"
    }
    workbot = {
      enabled       = true
      desired_count = 2
    }
  }

  assert {
    condition     = one(one(aws_ecs_service.runner[0].service_connect_configuration).service).client_alias[0].dns_name == "headless-runner"
    error_message = "The runner must be reachable at the dotless Service Connect alias headless-runner."
  }
  assert {
    condition     = one(aws_ecs_service.api.service_connect_configuration).enabled && one(aws_ecs_service.workbot[0].service_connect_configuration).enabled
    error_message = "den-api and Workbot must join Service Connect to reach the runner."
  }
  assert {
    condition = alltrue([
      local.environment.DEN_HEADLESS_RUNNER_URL == "http://headless-runner:8795",
      local.environment.DEN_FEATURE_HEADLESS_AUTOMATIONS == "true",
      local.environment.DEN_FEATURE_SLACK_ASSISTANT == "true",
      local.environment.DEN_FEATURE_SLACK_ASSISTANT_HEADLESS == "true",
      local.environment.DEN_AUTOMATIONS_RUNTIME_ENABLED == "true",
      local.environment.DEN_WORKBOT_URL == "https://chat.openwork.example.com",
      local.environment.DEN_FEATURE_WORKBOT == "true",
    ])
    error_message = "Den must be pointed at the runner and Workbot, with their features on."
  }
  assert {
    condition = alltrue([
      contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[1].secrets : s.name], "DEN_HEADLESS_RUNNER_TOKEN"),
      !contains([for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s.name], "DEN_HEADLESS_RUNNER_TOKEN"),
      !contains(keys(local.secret_values), "HEADLESS_MODEL_API_KEY"),
    ])
    error_message = "Only den-api gets the runner token; the model key stays out of the shared app secret."
  }
  assert {
    condition = alltrue([
      contains([for e in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "HEADLESS_MCP_URL=https://api.openwork.example.com/mcp/agent"),
      contains([for e in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].secrets : e.name], "HEADLESS_MODEL_API_KEY"),
      contains([for e in jsondecode(aws_ecs_task_definition.workbot[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "WORKBOT_RUNNER_URL=http://headless-runner:8795"),
    ])
    error_message = "The runner reaches Den's public MCP endpoint with its model key; Workbot reaches the runner."
  }
  assert {
    condition     = length(aws_efs_mount_target.agents) == 2 && aws_ecs_service.runner[0].deployment_maximum_percent == 100
    error_message = "One EFS mount target per service subnet, and never two runner tasks on one database."
  }
  assert {
    condition     = output.workbot_url == "https://chat.openwork.example.com" && contains(keys(aws_route53_record.this), "chat.openwork.example.com")
    error_message = "Workbot gets its public host and DNS record."
  }
  assert {
    condition = alltrue([
      length(aws_ecs_task_definition.workbot[0].volume) == 0,
      !contains([for e in jsondecode(aws_ecs_task_definition.workbot[0].container_definitions)[0].environment : e.name], "WORKBOT_DB_PATH"),
      !contains(keys(jsondecode(aws_ecs_task_definition.workbot[0].container_definitions)[0]), "mountPoints"),
      aws_ecs_service.workbot[0].desired_count == 2,
      aws_ecs_service.workbot[0].deployment_minimum_healthy_percent == 100,
      aws_ecs_service.workbot[0].deployment_maximum_percent == 200,
    ])
    error_message = "Workbot is diskless, supports multiple replicas and rolls without downtime."
  }
}

run "slack_without_runner_uses_web" {
  command = apply

  variables {
    slack_assistant_enabled = true
  }

  assert {
    condition     = local.environment.DEN_FEATURE_SLACK_ASSISTANT == "true" && local.environment.DEN_FEATURE_SLACK_ASSISTANT_HEADLESS == ""
    error_message = "Without the runner, Slack replies stay on OpenWork Web."
  }
}

run "workbot_requires_runner" {
  command = plan

  variables {
    workbot = {
      enabled = true
    }
  }

  expect_failures = [aws_ecs_task_definition.api]
}

run "runner_requires_model" {
  command = plan

  variables {
    headless_runner = {
      enabled = true
    }
  }

  expect_failures = [aws_ecs_task_definition.runner]
}

run "daytona_computer_uses_separate_image_and_runner_only_key" {
  command = apply

  variables {
    headless_runner   = { enabled = true, model = "test-model" }
    headless_computer = { provider = "daytona", snapshot = "computer-image" }
    daytona_api_key   = "test-daytona-key"
  }

  assert {
    condition     = contains([for e in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "HEADLESS_COMPUTER=daytona") && contains([for e in jsondecode(aws_ecs_task_definition.runner[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "HEADLESS_COMPUTER_SNAPSHOT=computer-image")
    error_message = "The runner should use Daytona and the computer snapshot, not the Web snapshot."
  }
  assert {
    condition     = contains(keys(local.runner_secret_values), "DAYTONA_API_KEY") && !contains([for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s.name], "DAYTONA_API_KEY")
    error_message = "The computer key belongs to the runner secret."
  }
}

run "daytona_computer_requires_snapshot" {
  command = plan
  variables {
    headless_runner   = { enabled = true, model = "test-model" }
    headless_computer = { provider = "daytona" }
    daytona_api_key   = "test-daytona-key"
  }
  expect_failures = [aws_ecs_task_definition.runner]
}

run "external_cells_have_no_node_runner_or_efs" {
  command = apply

  variables {
    headless_runner       = { enabled = true, external_url = "https://cells.example.com" }
    headless_runner_token = "test-fleet-token-at-least-32-characters"
    workbot               = { enabled = true, desired_count = 2 }
  }

  assert {
    condition     = length(aws_ecs_service.runner) == 0 && length(aws_ecs_task_definition.runner) == 0 && length(aws_efs_file_system.agents) == 0 && length(aws_efs_mount_target.agents) == 0
    error_message = "An external fleet must not provision a Node runner or persistent filesystem."
  }
  assert {
    condition     = length(aws_ecs_service.api.service_connect_configuration) == 0 && length(aws_ecs_service.workbot[0].service_connect_configuration) == 0
    error_message = "External fleets do not use the module's Service Connect alias."
  }
  assert {
    condition     = local.environment.DEN_HEADLESS_RUNNER_URL == "https://cells.example.com" && contains([for e in jsondecode(aws_ecs_task_definition.workbot[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "WORKBOT_RUNNER_URL=https://cells.example.com")
    error_message = "Both callers must use the external fleet endpoint."
  }
  assert {
    condition     = local.runner_secret_values.HEADLESS_API_TOKEN == var.headless_runner_token && !contains(keys(local.runner_secret_values), "HEADLESS_MODEL_API_KEY") && length(random_password.runner_token) == 0
    error_message = "Use the existing fleet token, not a new token or unused model credentials."
  }
  assert {
    condition     = contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[1].secrets : s.name], "DEN_HEADLESS_RUNNER_TOKEN") && contains([for s in jsondecode(aws_ecs_task_definition.workbot[0].container_definitions)[0].secrets : s.name], "WORKBOT_RUNNER_TOKEN") && !contains([for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s.name], "DEN_HEADLESS_RUNNER_TOKEN")
    error_message = "The external token belongs to den-api and Workbot only."
  }
}

run "external_cells_require_token" {
  command = plan
  variables {
    headless_runner = { enabled = true, external_url = "https://cells.example.com" }
  }
  expect_failures = [aws_ecs_task_definition.api]
}

run "external_cells_allow_private_single_label_hostname" {
  command = plan
  variables {
    headless_runner       = { enabled = true, external_url = "http://headless-cells:8795" }
    headless_runner_token = "test-fleet-token-at-least-32-characters"
  }
  assert {
    condition     = local.runner_url == "http://headless-cells:8795"
    error_message = "A private single-label HTTP hostname is supported."
  }
}

run "external_cells_reject_public_http" {
  command = plan
  variables {
    headless_runner = { enabled = true, external_url = "http://cells.example.com" }
  }
  expect_failures = [var.headless_runner]
}

run "workbot_rejects_zero_replicas" {
  command = plan
  variables {
    workbot = { enabled = true, desired_count = 0 }
  }
  expect_failures = [var.workbot]
}
