# Native state transitions only; no AWS operations or migration executions.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" }
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
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" }
  }
  mock_resource "aws_lambda_invocation" {
    defaults = { result = "{\"exitCode\":0,\"image\":\"ghcr.io/different-ai/openwork-den-api@sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e\"}" }
  }
}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  name                   = "openwork"
  openwork_version       = "0.18.58"
  write_only_secrets     = false
  managed_legacy_secrets = true
  database_ca_bundle     = "-----BEGIN CERTIFICATE-----test"
  vpc_id                 = "vpc-test"
  alb_subnet_ids         = ["subnet-a", "subnet-b"]
  service_subnet_ids     = ["subnet-a", "subnet-b"]
  database_subnet_ids    = ["subnet-a", "subnet-b"]
  owner_emails           = ["admin@example.com"]
  domain_name            = "openwork.example.com"
  certificate_arn        = "arn:aws:acm:us-east-1:123456789012:certificate/test"
  headless_runner        = { enabled = true, model = "test-model" }
  workbot                = { enabled = true }
  ai_gateway_enabled     = true
  ai_gateway_domain_name = "models.openwork.example.com"
  headless_runner_image  = "example.test/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  workbot_image          = "example.test/workbot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ai_gateway_image       = "ghcr.io/different-ai/openwork-inference@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "legacy_optional_definitions_have_false_retention_in_state" {
  command   = apply
  state_key = "optional"
  module { source = "./tests/task-definitions-legacy" }
  assert {
    condition     = !aws_ecs_task_definition.runner[0].skip_destroy && !aws_ecs_task_definition.workbot[0].skip_destroy && !aws_ecs_task_definition.ai_gateway[0].skip_destroy
    error_message = "The regression must start with actual false-valued Terraform state for every legacy optional definition."
  }
}

run "adoption_forgets_old_optional_definitions" {
  command   = plan
  state_key = "optional"
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  assert {
    condition     = aws_ecs_service.runner[0].deployment_minimum_healthy_percent == 0 && aws_ecs_service.runner[0].deployment_maximum_percent == 100
    error_message = "The runner must retain stop-before-start deployment for its one EFS-backed SQLite writer."
  }
}

run "create_retained_optional_definition_state" {
  command   = apply
  state_key = "optional"
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  override_resource {
    target = aws_ecs_task_definition.runner_v1[0]
    values = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork-headless-runner:2" }
  }
  override_resource {
    target = aws_ecs_task_definition.workbot_v1[0]
    values = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork-workbot:2" }
  }
  override_resource {
    target = aws_ecs_task_definition.ai_gateway_v1[0]
    values = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork-ai-gateway:2" }
  }
  assert {
    condition     = aws_ecs_task_definition.runner_v1[0].skip_destroy && aws_ecs_task_definition.workbot_v1[0].skip_destroy && aws_ecs_task_definition.ai_gateway_v1[0].skip_destroy
    error_message = "Every newly adopted optional definition must retain revisions from its first creation."
  }
  assert {
    condition = alltrue([
      aws_ecs_service.runner[0].task_definition == aws_ecs_task_definition.runner_v1[0].arn,
      aws_ecs_service.workbot[0].task_definition == aws_ecs_task_definition.workbot_v1[0].arn,
      aws_ecs_service.ai_gateway[0].task_definition == aws_ecs_task_definition.ai_gateway_v1[0].arn,
      output.task_definition_arns.headless_runner == aws_ecs_task_definition.runner_v1[0].arn,
      output.task_definition_arns.workbot == aws_ecs_task_definition.workbot_v1[0].arn,
      output.task_definition_arns.ai_gateway == aws_ecs_task_definition.ai_gateway_v1[0].arn,
    ])
    error_message = "Services and verification outputs must use the new intended retained definitions."
  }
}

run "future_optional_image_and_memory_update_keeps_prior_retention" {
  command   = plan
  state_key = "optional"
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  variables {
    headless_runner       = { enabled = true, model = "test-model", memory = 2048 }
    workbot               = { enabled = true, memory = 1024 }
    headless_runner_image = "example.test/runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    workbot_image         = "example.test/workbot@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ai_gateway_image      = "ghcr.io/different-ai/openwork-inference@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  plan_options {
    replace = [aws_ecs_task_definition.runner_v1[0], aws_ecs_task_definition.workbot_v1[0], aws_ecs_task_definition.ai_gateway_v1[0]]
  }
  assert {
    condition     = aws_ecs_task_definition.runner_v1[0].skip_destroy && aws_ecs_task_definition.workbot_v1[0].skip_destroy && aws_ecs_task_definition.ai_gateway_v1[0].skip_destroy && aws_ecs_task_definition.runner_v1[0].memory == "2048" && aws_ecs_task_definition.workbot_v1[0].memory == "1024"
    error_message = "Later image/memory replacements must retain their old revisions, not change retention only during replacement."
  }
}

run "partially_applied_gateway_definition_state" {
  command   = apply
  state_key = "partial"
  module { source = "./tests/task-definitions-legacy" }
  variables {
    legacy_runner_enabled  = false
    legacy_workbot_enabled = false
  }
  assert {
    condition     = length(aws_ecs_task_definition.runner) == 0 && length(aws_ecs_task_definition.workbot) == 0 && !aws_ecs_task_definition.ai_gateway[0].skip_destroy
    error_message = "A failed apply may have registered only the legacy Gateway definition."
  }
}

run "adoption_forgets_present_partial_gateway_only" {
  command   = plan
  state_key = "partial"
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  assert {
    condition     = length(output.task_definition_arns) == 5 && aws_ecs_service.runner[0].deployment_minimum_healthy_percent == 0 && aws_ecs_service.runner[0].deployment_maximum_percent == 100
    error_message = "Partial adoption still prepares all five intended services and the singleton runner rollout."
  }
}
