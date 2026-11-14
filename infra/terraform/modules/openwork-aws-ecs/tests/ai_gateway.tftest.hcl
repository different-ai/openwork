# OFFLINE ONLY. Mock applies establish synthetic off/on state for upgrade plans;
# every cloud provider is mocked. No resources are provisioned.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:openwork" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den" } }
  mock_resource "aws_lb" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/openwork/abc" } }
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/openwork/abc" } }
  mock_resource "aws_lb_listener" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/openwork/abc/def" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/openwork" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" } }
  mock_resource "aws_service_discovery_service" { defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" } }
  mock_resource "aws_ecs_task_definition" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" } }
}
override_resource {
  target = aws_lb_target_group.ai_gateway
  values = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ai-gateway/distinct" }
}
mock_provider "random" {
  mock_resource "random_password" { defaults = { result = "SyntheticPreservedKey0123456789abcdef" } }
}
override_resource {
  target = aws_lambda_invocation.migrate
  values = { result = "{\"exitCode\":0,\"image\":\"ghcr.io/different-ai/openwork-den-api@sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e\"}" }
}
variables {
  openwork_version    = "0.18.58"
  write_only_secrets  = false
  database_ca_bundle  = "-----BEGIN CERTIFICATE-----test"
  vpc_id              = "vpc-123"
  alb_subnet_ids      = ["subnet-a", "subnet-b"]
  service_subnet_ids  = ["subnet-a", "subnet-b"]
  database_subnet_ids = ["subnet-c", "subnet-d"]
  owner_emails        = ["admin@example.com"]
  domain_name         = "openwork.example.com"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  route53_zone_id     = "Z123"
  ai_gateway_image    = "ghcr.io/different-ai/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
run "off_by_default" {
  command = apply # Mock state only: no provisioning, Lambda execution or SQL.
  assert {
    condition     = length(aws_ecs_task_definition.ai_gateway) == 0 && length(aws_ecs_service.ai_gateway) == 0 && length(aws_lb_target_group.ai_gateway) == 0 && length(aws_lb_listener_rule.ai_gateway) == 0 && length(aws_vpc_security_group_ingress_rule.ai_gateway) == 0 && length(aws_service_discovery_service.ai_gateway) == 0 && output.ai_gateway_url == null
    error_message = "Default: 0 AI Gateway tasks/services/routes/security rules/discovery; URL null."
  }
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.api_v1.container_definitions)[0].environment : e.name if startswith(e.name, "GATEWAY_") || startswith(e.name, "INFERENCE_")]) == 0 && length(aws_route53_record.this) == 2
    error_message = "Default Den environment and two DNS hosts remain unchanged."
  }
}
run "enable_plan" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 1 && aws_lb_target_group.ai_gateway[0].port == 8791 && aws_lb_target_group.ai_gateway[0].health_check[0].path == "/health" && aws_lb_listener_rule.ai_gateway[0].listener_arn == aws_lb_listener.https[0].arn && output.ai_gateway_url == "https://models.example.com"
    error_message = "Enabled: 0 -> 1 ECS service on 8791, /health, existing HTTPS listener, public models URL."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].image == var.ai_gateway_image && jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].portMappings[0].containerPort == 8791 && strcontains(jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0].command[0], "/app/ee/apps/gateway/dist/server.js")
    error_message = "Use the published inference image, correct server entrypoint and port, never the Web proxy or migrator."
  }
  assert {
    condition = alltrue([for container in [jsondecode(aws_ecs_task_definition.api_v1.container_definitions)[0], jsondecode(aws_ecs_task_definition.ai_gateway[0].container_definitions)[0]] : alltrue([for k, v in {
      GATEWAY_ENABLED = "true", GATEWAY_PROXY_BASE_URL = "http://ai-gateway.openwork.internal:8791", GATEWAY_PUBLIC_BASE_URL = "https://models.example.com", INFERENCE_PROXY_BASE_URL = "https://models.example.com", DB_MODE = "mysql", NODE_ENV = "production"
    } : contains([for e in container.environment : "${e.name}=${e.value}"], "${k}=${v}")]) && alltrue([for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : contains([for e in container.secrets : "${e.name}=${e.valueFrom}"], "${name}=${aws_secretsmanager_secret.app.arn}:${name}::")])])
    error_message = "Den and Gateway share managed env, the existing app database/encryption secret and separate private/public URLs."
  }
  assert {
    condition     = random_password.db_encryption[0].result == "SyntheticPreservedKey0123456789abcdef" && jsondecode(aws_secretsmanager_secret_version.app.secret_string).DEN_DB_ENCRYPTION_KEY == random_password.db_encryption[0].result && length(keys(local.secret_values)) == 4 && var.secrets_version == 1 && length(aws_route53_record.this) == 3 && contains(local.certificate_hosts, "models.example.com")
    error_message = "Encryption value and four app-secret keys preserved; version stays 1; hosts 2 -> 3, certificate includes AI Gateway."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.ai_gateway["alb"].from_port == 8791 && aws_vpc_security_group_ingress_rule.ai_gateway["internal"].referenced_security_group_id == aws_security_group.tasks.id
    error_message = "8791 accepts only ALB/tasks security groups, never a new public CIDR ingress."
  }
}
run "coexists_with_den_gateway" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    openwork_web_enabled   = true
    daytona_api_key        = "synthetic"
    daytona                = { snapshot = "synthetic" }
    den_gateway_image      = "example.test/den-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = length(aws_ecs_service.gateway) == 1 && length(aws_ecs_service.ai_gateway) == 1 && aws_lb_listener_rule.ai_gateway[0].priority != aws_lb_listener_rule.gateway_host[0].priority && local.gateway_host != var.ai_gateway_domain_name && aws_lb_target_group.gateway[0].port == 8788
    error_message = "AI Gateway and den-gateway have distinct services, hosts, ports and listener priorities."
  }
}
run "module_managed_certificate" {
  command = plan
  override_resource {
    target = aws_acm_certificate.this
    values = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/managed"
      domain_validation_options = [for host in ["openwork.example.com", "api.openwork.example.com", "models.example.com"] : {
        domain_name = host, resource_record_name = "_x.${host}.", resource_record_type = "CNAME", resource_record_value = "_y.acm-validations.aws."
      }]
    }
  }
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    certificate_arn        = ""
  }
  assert {
    condition     = contains(aws_acm_certificate.this[0].subject_alternative_names, "models.example.com") && contains(keys(aws_route53_record.certificate_validation), "models.example.com") && tolist(tolist(aws_lb_listener_rule.ai_gateway[0].condition)[0].host_header[0].values)[0] == "models.example.com"
    error_message = "Managed ACM SAN, Route 53 validation and listener host all include the dedicated AI Gateway hostname."
  }
}
run "shared_listener" {
  command = plan
  variables {
    ai_gateway_enabled                = true
    ai_gateway_domain_name            = "models.example.com"
    alb_listener_arn                  = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/shared/123/456"
    alb_security_group_id             = "sg-shared"
    ai_gateway_listener_rule_priority = 150
  }
  assert {
    condition     = aws_lb_listener_rule.ai_gateway[0].listener_arn == var.alb_listener_arn && aws_lb_listener_rule.ai_gateway[0].priority == 150 && length(aws_lb.this) == 0
    error_message = "Shared HTTPS listener receives only the requested AI Gateway rule; no replacement ALB."
  }
}
run "missing_domain" {
  command = plan
  variables { ai_gateway_enabled = true }
  expect_failures = [var.ai_gateway_domain_name]
}
run "mutable_image" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    ai_gateway_image       = "ghcr.io/different-ai/openwork-inference:latest"
  }
  expect_failures = [var.ai_gateway_image]
}
run "conflicting_environment" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    extra_environment      = { GATEWAY_ENABLED = "false" }
  }
  expect_failures = [var.ai_gateway_enabled]
}
run "conflicting_legacy_alias" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    extra_environment      = { INFERENCE_PROXY_BASE_URL = "https://other.example.com" }
  }
  expect_failures = [var.ai_gateway_enabled]
}
run "conflicting_priority" {
  command = plan
  variables {
    ai_gateway_enabled                = true
    ai_gateway_domain_name            = "models.example.com"
    ai_gateway_listener_rule_priority = 10
  }
  expect_failures = [aws_lb_listener_rule.ai_gateway]
}
run "conflicting_host" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "openwork.example.com"
  }
  expect_failures = [aws_lb_listener_rule.ai_gateway]
}
run "enabled_mock_state" {
  command = apply # Mock-only state for unchanged/disable plans below.
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 1 && random_password.db_encryption[0].result == "SyntheticPreservedKey0123456789abcdef" && tolist(aws_lb_listener_rule.ai_gateway[0].action)[0].target_group_arn == aws_lb_target_group.ai_gateway[0].arn && aws_ecs_service.ai_gateway[0].load_balancer != aws_ecs_service.api.load_balancer
    error_message = "Synthetic enabled state routes to the distinct AI target group, not Den, and retains the original encryption value."
  }
}
run "unchanged_enabled_plan" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 1 && random_password.db_encryption[0].result == "SyntheticPreservedKey0123456789abcdef" && var.secrets_version == 1
    error_message = "Unchanged enabled plan retains one Gateway and the original encryption key/version."
  }
}
run "disable_plan_keeps_data" {
  command = plan
  assert {
    condition     = length(aws_ecs_service.ai_gateway) == 0 && output.ai_gateway_url == null && length(aws_db_instance.this) == 1 && length(keys(local.secret_values)) == 4 && random_password.db_encryption[0].result == "SyntheticPreservedKey0123456789abcdef" && !contains(keys(local.environment), "GATEWAY_ENABLED")
    error_message = "Disable: Gateway 1 -> 0, URL null and runtime defaults false; database and four original app secrets kept."
  }
}
