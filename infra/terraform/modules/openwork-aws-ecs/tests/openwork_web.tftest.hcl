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
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
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

run "web_off_by_default" {
  command = apply

  assert {
    condition     = length(aws_ecs_service.gateway) == 0 && length(aws_lb_target_group.gateway) == 0 && length(aws_lb_listener_rule.gateway_host) == 0
    error_message = "No gateway resources should exist while OpenWork Web is off."
  }
  assert {
    condition     = local.environment.PROVISIONER_MODE == "stub" && local.environment.DEN_GATEWAY_ORIGIN == ""
    error_message = "Web off keeps the stub provisioner and sets no gateway origin."
  }
  assert {
    condition     = !contains([for e in local.environment_list : e.name], "WORKER_ACTIVITY_BASE_URL") && !contains([for e in local.environment_list : e.name], "DAYTONA_SNAPSHOT")
    error_message = "Web off must not set Web or Daytona env vars."
  }
  assert {
    condition     = output.openwork_web_url == null && length(aws_route53_record.this) == 2
    error_message = "Web off has no gateway URL or DNS record."
  }
}

run "web_on" {
  command = apply

  variables {
    openwork_web_enabled = true
    daytona_api_key      = "dtn_test"
    daytona = {
      snapshot = "openwork-0.0.0-test"
    }
  }

  assert {
    condition     = length(aws_ecs_service.gateway) == 1 && aws_lb_listener_rule.gateway_host[0].listener_arn == aws_lb_listener.https[0].arn
    error_message = "Web on creates the gateway service and routes its host on the HTTPS listener."
  }
  assert {
    condition     = tolist(tolist(aws_lb_listener_rule.gateway_host[0].condition)[0].host_header[0].values)[0] == "web.openwork.example.com"
    error_message = "The gateway host defaults to web.<domain_name>."
  }
  assert {
    condition     = aws_lb_target_group.gateway[0].health_check[0].path == "/__gw/health" && aws_lb_target_group.gateway[0].port == 8788
    error_message = "The gateway target group must use the gateway's own health check on 8788."
  }
  assert {
    condition = alltrue([
      local.environment.DEN_OPENWORK_WEB_ENABLED == "true",
      local.environment.PROVISIONER_MODE == "daytona",
      local.environment.DEN_GATEWAY_ORIGIN == "https://web.openwork.example.com",
      local.environment.CORS_ORIGINS == "https://web.openwork.example.com",
      local.environment.DEN_BETTER_AUTH_TRUSTED_ORIGINS == "https://web.openwork.example.com",
      local.environment.DEN_WEB_OPENWORK_WEB_URL == "https://web.openwork.example.com",
      local.environment.WORKER_ACTIVITY_BASE_URL == "https://api.openwork.example.com",
      local.environment.DAYTONA_SNAPSHOT == "openwork-0.0.0-test",
      local.environment.DAYTONA_SANDBOX_NAME_PREFIX == "openwork-worker",
      local.environment.DAYTONA_SHARED_VOLUME_NAME == "openwork-workers",
    ])
    error_message = "Web on must wire the gateway origin, the dashboard button, sandbox heartbeats and Daytona into Den."
  }
  assert {
    condition     = contains(keys(local.secret_values), "DAYTONA_API_KEY") && contains(keys(local.secret_values), "DEN_GATEWAY_KEY")
    error_message = "The Daytona key and the shared gateway key belong in Secrets Manager."
  }
  assert {
    condition = alltrue([
      contains([for e in jsondecode(aws_ecs_task_definition.gateway[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "DEN_GATEWAY_DEN_WEB_URL=https://openwork.example.com"),
      contains([for e in jsondecode(aws_ecs_task_definition.gateway[0].container_definitions)[0].secrets : e.name], "DEN_GATEWAY_KEY"),
    ])
    error_message = "The gateway must sign members in through this Den and share the gateway key."
  }
  assert {
    condition     = output.openwork_web_url == "https://web.openwork.example.com" && contains(keys(aws_route53_record.this), "web.openwork.example.com")
    error_message = "Web on reports the gateway URL and creates its DNS record."
  }
}

run "web_certificate_covers_gateway" {
  command = plan

  # The real provider knows validation records at plan time; the mock does not.
  override_resource {
    target          = aws_acm_certificate.this
    override_during = plan
    values          = { arn = "arn:aws:acm:us-east-1:123456789012:certificate/new", domain_validation_options = [] }
  }

  variables {
    certificate_arn          = ""
    openwork_web_enabled     = true
    openwork_web_domain_name = "chat.example.com"
    daytona_api_key          = "dtn_test"
    daytona = {
      snapshot    = "openwork-0.0.0-test"
      name_prefix = "acme"
    }
  }

  assert {
    condition     = contains(aws_acm_certificate.this[0].subject_alternative_names, "chat.example.com")
    error_message = "A module-created certificate must cover the gateway host."
  }
  assert {
    condition     = local.environment.DAYTONA_SANDBOX_NAME_PREFIX == "acme-worker"
    error_message = "daytona.name_prefix should scope sandbox names."
  }
}

run "web_on_existing_listener" {
  command = apply

  variables {
    alb_listener_arn                    = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/shared/123/456"
    alb_security_group_id               = "sg-shared"
    openwork_web_enabled                = true
    openwork_web_listener_rule_priority = 130
    daytona_api_key                     = "dtn_test"
    daytona = {
      snapshot = "openwork-0.0.0-test"
    }
  }

  assert {
    condition     = aws_lb_listener_rule.gateway_host[0].listener_arn == var.alb_listener_arn && aws_lb_listener_rule.gateway_host[0].priority == 130
    error_message = "The gateway rule must attach to the existing listener with the requested priority."
  }
}

run "web_requires_daytona" {
  command = plan

  variables {
    openwork_web_enabled = true
  }

  expect_failures = [aws_ecs_task_definition.gateway]
}

run "rejects_render_provisioner" {
  command = plan

  variables {
    provisioner_mode = "render"
  }

  expect_failures = [var.provisioner_mode]
}
