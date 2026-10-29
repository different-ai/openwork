# Offline managed contract checks. Real migration invocations are overridden.
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
run "strict_default_and_all_db_clients_trust_rds" {
  command = apply
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  assert {
    condition = alltrue([for definition in [aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1] :
      strcontains(definition.container_definitions, "NODE_EXTRA_CA_CERTS") && strcontains(definition.container_definitions, "node /tmp/openwork-db-tls-check.cjs; exec ") && definition.skip_destroy
    ])
    error_message = "All clients must validate strict TLS/CA before Node and retain their revisions."
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.api_v1.container_definitions)) == 1 && !strcontains(aws_ecs_task_definition.api_v1.container_definitions, "bootstrap.js") && strcontains(aws_ecs_task_definition.migrate_v1.container_definitions, "bootstrap.js")
    error_message = "Only the dedicated migration step may migrate."
  }
  assert {
    condition     = data.http.rds_ca[0].url == "https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem" && !data.http.rds_ca[0].insecure
    error_message = "Trust roots must use verified regional HTTPS."
  }
  assert {
    condition     = !one(aws_ecs_service.api.deployment_circuit_breaker).rollback && !one(aws_ecs_service.web.deployment_circuit_breaker).rollback
    error_message = "Managed adoption must never roll back to a no-CA or migration-capable revision."
  }
  assert {
    condition     = endswith(jsondecode(aws_secretsmanager_secret_version.app.secret_string).DATABASE_URL, "?sslaccept=accept") && endswith(jsondecode(aws_secretsmanager_secret_version.tls[0].secret_string).DATABASE_URL, "?sslaccept=strict") && alltrue([for key, value in local.secret_values : key == "DATABASE_URL" || jsondecode(aws_secretsmanager_secret_version.app.secret_string)[key] == value])
    error_message = "Seed and strict current versions preserve every core key and DB credential."
  }
}
run "reject_accept" {
  command = plan
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  variables { database = { tls_query = "sslaccept=accept" } }
  expect_failures = [terraform_data.security_contract]
}
run "reject_conflicting_query" {
  command = plan
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  variables { database = { tls_query = "sslaccept=strict&sslaccept=accept" } }
  expect_failures = [terraform_data.security_contract]
}
run "reject_failed_ca_fetch" {
  command = plan
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  override_data {
    target = data.http.rds_ca[0]
    values = { status_code = 503, response_body = "-----BEGIN CERTIFICATE-----test" }
  }
  expect_failures = [data.http.rds_ca[0]]
}
run "reject_non_pem_ca" {
  command = plan
  module { source = "../../../terraform/modules/openwork-aws-ecs" }
  override_data {
    target = data.http.rds_ca[0]
    values = { status_code = 200, response_body = "not a certificate" }
  }
  expect_failures = [data.http.rds_ca[0]]
}
