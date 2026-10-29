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
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/openwork" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openwork" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/openwork:1" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/openwork/abc/def" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/openwork/abc" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/openwork/abc" }
  }
}
mock_provider "random" {}
override_resource {
  target = aws_lambda_invocation.migrate
  values = { result = "{\"exitCode\":0,\"image\":\"ghcr.io/different-ai/openwork-den-api@sha256:0942e02a8e2033151e982f51b24926fe5090807b7f7480d77f2c4fc5b806737e\"}" }
}
variables {
  openwork_version    = "0.18.58"
  write_only_secrets  = false # exercise preserved legacy state path
  vpc_id              = "vpc-123"
  alb_subnet_ids      = ["subnet-a", "subnet-b"]
  service_subnet_ids  = ["subnet-a", "subnet-b"]
  database_subnet_ids = ["subnet-c", "subnet-d"]
  owner_emails        = ["admin@example.com"]
  domain_name         = "openwork.example.com"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  database_ca_bundle  = "-----BEGIN CERTIFICATE-----test"
}
run "singleton_api_only_security_and_defaults" {
  command = apply
  variables {
    den_api = { desired_count = 2 }
    smtp    = { username = "test-user", password = "test-password" }
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.api_v1.container_definitions)) == 1 && jsondecode(aws_ecs_task_definition.api_v1.container_definitions)[0].name == "den-api" && !strcontains(aws_ecs_task_definition.api_v1.container_definitions, "bootstrap.js")
    error_message = "API replicas must not contain migrations."
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.migrate_v1.container_definitions)) == 1 && jsondecode(aws_ecs_task_definition.migrate_v1.container_definitions)[0].essential && strcontains(aws_ecs_task_definition.migrate_v1.container_definitions, "bootstrap.js")
    error_message = "One standalone essential migrator must own bootstrap."
  }
  assert {
    condition     = !strcontains(aws_ecs_task_definition.migrate_v1.container_definitions, "openwork.example.com") && alltrue([for e in jsondecode(aws_ecs_task_definition.migrate_v1.container_definitions)[0].environment : contains(["CI", "NODE_ENV", "DB_MODE", "DEN_DB_0097_WRITERS_STOPPED"], e.name)])
    error_message = "Public endpoint changes must not rerun the migration task; only database/migration settings belong in its environment."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.migration.policy).Statement[0].Resource == "arn:aws:ecs:us-east-1:123456789012:task-definition/${var.name}-migrate:*" && jsondecode(aws_iam_role_policy.migration.policy).Statement[0].Condition.ArnEquals["ecs:cluster"] == local.cluster_arn
    error_message = "RunTask must allow only the owned migration family and cluster, with stable permissions across revisions."
  }
  assert {
    condition     = aws_ecs_service.api.desired_count == 2 && aws_db_instance.this[0].deletion_protection && var.den_api.cpu >= 1024 && var.den_api.memory >= 2048 && var.den_web.cpu >= 512 && var.den_web.memory >= 1024
    error_message = "Protected database and sized defaults are required; singleton must not reduce API replicas."
  }
  assert {
    condition     = alltrue([for e in local.environment_list : !contains(keys(local.secret_values), e.name)]) && contains([for s in local.secrets_list : s.name], "SMTP_USER") && contains([for s in local.secrets_list : s.name], "SMTP_PASS")
    error_message = "Secret values must only be injected through ECS secrets, never plain environment."
  }
  assert {
    condition     = var.database.tls_query == "sslaccept=strict" && strcontains(aws_ecs_task_definition.api_v1.container_definitions, "NODE_EXTRA_CA_CERTS") && strcontains(aws_ecs_task_definition.web_v1.container_definitions, "NODE_EXTRA_CA_CERTS") && strcontains(aws_ecs_task_definition.migrate_v1.container_definitions, "NODE_EXTRA_CA_CERTS")
    error_message = "Both apps and migrator need strict TLS plus the CA."
  }
  assert {
    condition     = alltrue([for d in [aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1] : can(regex("@sha256:[0-9a-f]{64}$", jsondecode(d.container_definitions)[0].image))])
    error_message = "Default release images must be immutable."
  }
}
run "small_trial_database_default" {
  command = plan
  assert {
    condition     = aws_db_instance.this[0].instance_class == "db.t4g.small" && aws_db_instance.this[0].allocated_storage == 20 && !aws_db_instance.this[0].apply_immediately
    error_message = "Small / trial must default to a 2 GiB database with 20 GiB storage and deferred modifications."
  }
}

run "explicit_legacy_micro_is_preserved" {
  command = plan
  variables { database = { instance_class = "db.t4g.micro" } }
  assert {
    condition     = aws_db_instance.this[0].instance_class == "db.t4g.micro" && !aws_db_instance.this[0].apply_immediately
    error_message = "Existing direct users must be able to pin micro without opting into an immediate restart."
  }
}

run "common_outputs_are_native_identifiers" {
  command = apply
  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com" && output.database_identifier == aws_db_instance.this[0].identifier && output.migration_step_identifier == aws_ecs_task_definition.migrate_v1.arn
    error_message = "Common outputs must expose both HTTPS URLs, the native RDS instance identifier and the migration task definition ARN."
  }
}

run "reject_plain_secret" {
  command = plan
  variables { extra_environment = { BETTER_AUTH_SECRET = "not-a-real-secret" } }
  expect_failures = [terraform_data.security_contract]
}
run "reject_mutable_image" {
  command = plan
  variables { den_api_image = "example.test/api:latest" }
  expect_failures = [terraform_data.security_contract]
}
run "reject_unverified_tls" {
  command = plan
  variables { database = { tls_query = "sslaccept=accept" } }
  expect_failures = [terraform_data.security_contract]
}
run "deletion_override_and_existing_db" {
  command = apply
  variables {
    create_database = false
    database_url    = "mysql://example:fixture@example.test/den?sslaccept=strict"
  }
  assert {
    condition     = length(aws_db_instance.this) == 0 && output.database_identifier == null
    error_message = "Existing databases must remain supported without creating RDS."
  }
}
run "write_only_existing_database_keeps_database_secret_reference" {
  command = apply
  variables {
    write_only_secrets = true
    create_database    = false
    secret_values_wo = {
      database_password  = ""
      database_url       = "mysql://example:fixture@example.test/den?sslaccept=strict"
      better_auth_secret = "fixture-auth-secret-at-least-32-characters"
      db_encryption_key  = "fixture-encryption-key-at-least-32-characters"
      bootstrap_code     = "fixture-bootstrap-code"
    }
  }
  assert {
    condition     = length(aws_db_instance.this) == 0 && alltrue([for definition in [aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1] : contains([for secret in jsondecode(definition.container_definitions)[0].secrets : secret.name], "DATABASE_URL")])
    error_message = "An ephemeral existing-DB URL must still be injected into API, web and migrator without creating RDS."
  }
}

run "missing_existing_keys_fail_before_conversion" {
  command = plan
  variables { write_only_secrets = true }
  expect_failures = [var.secret_values_wo]
}

run "write_only_core_secrets" {
  command = apply
  variables {
    write_only_secrets           = true
    deletion_protection          = false
    initial_admin_bootstrap_code = "fixture-legacy-bootstrap-must-not-enter-state"
    secret_values_wo = {
      database_password  = "FixturePassword123!"
      better_auth_secret = "fixture-auth-secret-at-least-32-characters"
      db_encryption_key  = "fixture-encryption-key-at-least-32-characters"
      bootstrap_code     = "fixture-bootstrap-code"
    }
  }
  assert {
    condition     = length(random_password.better_auth) == 0 && length(random_password.db_encryption) == 0 && length(random_password.db) == 0 && length(random_password.bootstrap_code) == 0 && aws_secretsmanager_secret_version.app.secret_string == null && aws_db_instance.this[0].password == null && output.bootstrap_code == null && !aws_db_instance.this[0].deletion_protection
    error_message = "Write-only mode must not retain core secret values in random resources or readable provider fields."
  }
}
