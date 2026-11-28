# A plan made from the installer's record (applied/) must not depend on a
# download: the recorded trust roots replace the fetch and embed the same bytes.
# Mocked providers; the migration invocation is overridden.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" { defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den" } }
  mock_resource "aws_lb" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/openwork/abc" } }
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/openwork/abc" } }
  mock_resource "aws_lb_listener" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/openwork/abc/def" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/openwork" } }
  mock_resource "aws_service_discovery_service" { defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" } }
  mock_resource "aws_service_discovery_private_dns_namespace" { defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" } }
  mock_resource "aws_ecs_task_definition" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" } }
}
mock_provider "random" {}
mock_provider "http" {
  mock_data "http" { defaults = { status_code = 200, response_body = "-----BEGIN CERTIFICATE-----test" } }
}
override_resource {
  target = aws_lambda_invocation.migrate
  values = { result = "{\"exitCode\":0,\"image\":\"ghcr.io/different-ai/openwork-den-api@sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e\"}" }
}
variables {
  openwork_version       = "0.18.58"
  write_only_secrets     = false
  managed_legacy_secrets = true
  vpc_id                 = "vpc-test"
  alb_subnet_ids         = ["subnet-a", "subnet-b"]
  service_subnet_ids     = ["subnet-a", "subnet-b"]
  database_subnet_ids    = ["subnet-a", "subnet-b"]
  owner_emails           = ["admin@example.com"]
  domain_name            = "openwork.example.com"
  certificate_arn        = "arn:aws:acm:us-east-1:123456789012:certificate/test"
  wait_for_steady_state  = true
}
run "downloaded_trust_roots_are_embedded" {
  command = apply
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  assert {
    condition     = length(data.http.rds_ca) == 1
    error_message = "Without recorded trust roots the regional bundle is downloaded."
  }
  assert {
    condition = alltrue([for definition in [aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1] :
      strcontains(definition.container_definitions, base64encode("-----BEGIN CERTIFICATE-----test"))
    ])
    error_message = "Every database client embeds the downloaded trust roots."
  }
}
run "recorded_trust_roots_need_no_download" {
  command = plan
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  variables { database_ca_bundle = "-----BEGIN CERTIFICATE-----test" }
  assert {
    condition     = length(data.http.rds_ca) == 0
    error_message = "Recorded trust roots must replace the download."
  }
  assert {
    condition = alltrue([for definition in [aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1] :
      strcontains(definition.container_definitions, base64encode("-----BEGIN CERTIFICATE-----test"))
    ])
    error_message = "The same recorded bytes must produce the same task definitions."
  }
}
