# AI Gateway and member Gateway keys for the runner. Offline checks (mocked AWS provider): terraform init && terraform test

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

run "ai_gateway_off_by_default" {
  command = apply

  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 0 && !contains([for e in local.environment_list : e.name], "GATEWAY_ENABLED")
    error_message = "No AI Gateway, and Den does not claim one, while it is off."
  }
}

run "ai_gateway_on" {
  command = apply

  variables {
    ai_gateway = { enabled = true }
  }

  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 1 && local.ai_gateway_host == "gateway.openwork.example.com"
    error_message = "The AI Gateway serves gateway.<domain_name>."
  }
  assert {
    condition     = local.environment.GATEWAY_ENABLED == "true" && local.environment.GATEWAY_PUBLIC_BASE_URL == "https://gateway.openwork.example.com" && local.environment.GATEWAY_PROXY_BASE_URL == "http://ai-gateway:8791"
    error_message = "den-api turns on AI Providers and reaches the Gateway privately."
  }
  assert {
    condition     = length(aws_ecs_service.api.service_connect_configuration) == 1
    error_message = "den-api resolves the ai-gateway alias through Service Connect."
  }
  assert {
    condition     = contains([for s in jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].secrets : s.name], "DATABASE_URL") && contains([for s in jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].secrets : s.name], "DEN_DB_ENCRYPTION_KEY")
    error_message = "The Gateway shares Den's database and encryption key."
  }
  assert {
    condition     = output.service_names.ai_gateway == "ai-gateway"
    error_message = "The installer waits for the AI Gateway service too."
  }
}

run "ai_gateway_in_created_certificate" {
  command = plan

  # The real provider knows validation records at plan time; the mock does not.
  override_resource {
    target          = aws_acm_certificate.this
    override_during = plan
    values          = { arn = "arn:aws:acm:us-east-1:123456789012:certificate/new", domain_validation_options = [] }
  }

  variables {
    certificate_arn = ""
    ai_gateway      = { enabled = true }
  }

  assert {
    condition     = contains(aws_acm_certificate.this[0].subject_alternative_names, "gateway.openwork.example.com")
    error_message = "A module-created certificate covers the AI Gateway host."
  }
}

run "runner_on_member_gateway_keys" {
  command = apply

  variables {
    ai_gateway          = { enabled = true }
    headless_model_auth = "member_gateway_key"
    headless_runner = {
      enabled        = true
      model_base_url = "https://gateway.openwork.example.com/api/v1"
      model          = "set-a-default-model-in-den"
    }
  }

  assert {
    condition     = local.environment.DEN_HEADLESS_MODEL_AUTH == "member_gateway_key"
    error_message = "den-api sends each member's Gateway key with their turns."
  }
  assert {
    condition     = !contains(keys(local.runner_secret_values), "HEADLESS_MODEL_API_KEY")
    error_message = "The runner holds no model key of its own."
  }
}

run "member_gateway_keys_need_the_gateway" {
  command = plan

  variables {
    headless_model_auth = "member_gateway_key"
    headless_runner = {
      enabled        = true
      model_base_url = "https://api.anthropic.com/v1"
      model          = "claude-test"
    }
  }

  expect_failures = [aws_ecs_task_definition.runner]
}
