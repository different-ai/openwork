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

run "creates_load_balancer_by_default" {
  command = apply

  assert {
    condition     = length(aws_lb.this) == 1 && length(aws_security_group.alb) == 1
    error_message = "The module should create the ALB and its security group by default."
  }
  assert {
    condition     = aws_lb.this[0].security_groups == toset(["sg-created"])
    error_message = "The created ALB must use the created security group."
  }
  assert {
    condition     = alltrue([for rule in aws_vpc_security_group_ingress_rule.tasks_from_alb : rule.referenced_security_group_id == "sg-created"])
    error_message = "Tasks must accept traffic from the created ALB security group."
  }
  assert {
    condition     = length(aws_lb_listener.https) == 1 && length(aws_lb_listener.http) == 1 && length(aws_lb_listener_rule.web_host) == 0
    error_message = "The module should create both listeners and route den-web through the HTTPS default action."
  }
  assert {
    condition     = aws_lb_listener_rule.api_host.listener_arn == aws_lb_listener.https[0].arn
    error_message = "The den-api rule must attach to the created HTTPS listener."
  }
  assert {
    condition     = length(aws_route53_record.this) == 2
    error_message = "DNS records should point both hostnames at the created ALB."
  }
  assert {
    condition     = aws_ecs_service.api.wait_for_steady_state == false && aws_ecs_service.web.wait_for_steady_state == false
    error_message = "wait_for_steady_state should default to false."
  }
}

run "custom_security_group_on_created_alb" {
  command = apply

  variables {
    alb_security_group_id = "sg-mine"
  }

  assert {
    condition     = length(aws_security_group.alb) == 0 && aws_lb.this[0].security_groups == toset(["sg-mine"])
    error_message = "A passed alb_security_group_id should replace the generated security group."
  }
}

run "existing_load_balancer" {
  command = apply

  variables {
    load_balancer_arn     = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shared/123"
    alb_security_group_id = "sg-shared"
    wait_for_steady_state = true
  }

  assert {
    condition     = length(aws_lb.this) == 0 && length(aws_security_group.alb) == 0
    error_message = "No ALB or ALB security group should be created for an existing ALB."
  }
  assert {
    condition     = aws_lb_listener.https[0].load_balancer_arn == var.load_balancer_arn && aws_lb_listener.http[0].load_balancer_arn == var.load_balancer_arn
    error_message = "Listeners must be added to the existing ALB."
  }
  assert {
    condition     = alltrue([for rule in aws_vpc_security_group_ingress_rule.tasks_from_alb : rule.referenced_security_group_id == "sg-shared"])
    error_message = "Tasks must accept traffic from the existing ALB security group."
  }
  assert {
    condition     = length(aws_route53_record.this) == 0 && output.alb_arn == var.load_balancer_arn && output.alb_dns_name == null
    error_message = "With an existing ALB the module creates no DNS records and reports the passed ARN."
  }
  assert {
    condition     = aws_ecs_service.api.wait_for_steady_state && aws_ecs_service.web.wait_for_steady_state
    error_message = "wait_for_steady_state must reach both services."
  }
}

run "existing_listener" {
  command = apply

  variables {
    alb_listener_arn            = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/shared/123/456"
    alb_security_group_id       = "sg-shared"
    api_listener_rule_priority  = 110
    web_listener_rule_priority  = 120
    attach_listener_certificate = true
  }

  assert {
    condition     = length(aws_lb.this) == 0 && length(aws_lb_listener.https) == 0 && length(aws_lb_listener.http) == 0
    error_message = "No ALB or listeners should be created for an existing listener."
  }
  assert {
    condition     = aws_lb_listener_rule.api_host.listener_arn == var.alb_listener_arn && aws_lb_listener_rule.api_host.priority == 110
    error_message = "The den-api rule must attach to the existing listener with the requested priority."
  }
  assert {
    condition     = aws_lb_listener_rule.web_host[0].listener_arn == var.alb_listener_arn && aws_lb_listener_rule.web_host[0].priority == 120
    error_message = "The den-web rule must attach to the existing listener with the requested priority."
  }
  assert {
    condition     = aws_lb_listener_certificate.this[0].certificate_arn == var.certificate_arn
    error_message = "attach_listener_certificate should add the certificate to the existing listener."
  }
  assert {
    condition     = length(aws_route53_record.this) == 0 && output.alb_arn == null
    error_message = "With an existing listener the module creates no DNS records."
  }
}

run "existing_load_balancer_requires_security_group" {
  command = plan

  variables {
    load_balancer_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shared/123"
  }

  expect_failures = [aws_vpc_security_group_ingress_rule.tasks_from_alb]
}

run "rejects_non_arn_listener" {
  command = plan

  variables {
    alb_listener_arn      = "shared-listener"
    alb_security_group_id = "sg-shared"
  }

  expect_failures = [var.alb_listener_arn]
}
