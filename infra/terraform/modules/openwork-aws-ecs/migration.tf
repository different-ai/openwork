# AWS has no declarative RunTask-and-wait resource. A synchronous Lambda
# invocation is the native completion gate; no workstation provisioner is used.
removed {
  from = aws_ecs_task_definition.migrate
  lifecycle { destroy = false }
}
resource "aws_ecs_task_definition" "migrate_v1" {
  skip_destroy             = true
  depends_on               = [terraform_data.security_contract]
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.den_api.cpu
  memory                   = var.den_api.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  container_definitions = jsonencode([{
    name       = "migrate"
    image      = local.den_api_image
    essential  = true
    entryPoint = ["/bin/sh", "-ec"]
    command    = ["${local.tls_setup}exec node /app/ee/packages/den-db/dist/scripts/bootstrap.js"]
    # Public URL, org and mail changes must not rerun schema migrations.
    environment = [for entry in local.environment_list : entry if contains(["CI", "NODE_ENV", "DB_MODE", "DEN_DB_0097_WRITERS_STOPPED"], entry.name)]
    secrets     = [for secret in local.secrets_list : secret if secret.name == "DATABASE_URL"]
    logConfiguration = {
      logDriver = "awslogs"
      options   = merge(local.log_options.api, { "awslogs-stream-prefix" = "migrate" })
    }
  }])
}

resource "aws_iam_role" "migration" {
  name_prefix = "${var.name}-migrate-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "migration" {
  role = aws_iam_role.migration.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Stable family scope avoids IAM propagation races on each new revision.
        # Account, region and cluster remain fixed; no application families match.
        Effect    = "Allow", Action = ["ecs:RunTask"]
        Resource  = replace(local.cluster_arn, "/:cluster/.*$/", ":task-definition/${var.name}-migrate:*")
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster_arn } }
      },
      {
        Effect    = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "*"
        Condition = { ArnEquals = { "ecs:cluster" = local.cluster_arn } }
      },
      {
        Effect    = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect   = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.migration.arn}:*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/aws/lambda/${var.name}-migrate"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

data "archive_file" "migration" {
  type        = "zip"
  source_file = "${path.module}/migration.py"
  output_path = "${path.root}/.openwork-migration.zip"
}

resource "aws_lambda_function" "migration" {
  function_name    = "${var.name}-migrate"
  role             = aws_iam_role.migration.arn
  runtime          = "python3.13"
  handler          = "migration.handler"
  filename         = data.archive_file.migration.output_path
  source_code_hash = data.archive_file.migration.output_base64sha256
  timeout          = 900
  memory_size      = 128
  # Invocation runs only ECS control-plane calls, never connects to the database.
  # Do not reserve concurrency: low-quota accounts may not have capacity above
  # Lambda's required unreserved floor. ECS clientToken deduplicates retries;
  # the Terraform state lock and one schema coordinator serialize deployments.
  tags       = var.tags
  depends_on = [aws_iam_role_policy.migration]
}

resource "terraform_data" "migration_complete" {
  input = aws_lambda_invocation.migrate.result
  lifecycle {
    precondition {
      condition     = try(jsondecode(aws_lambda_invocation.migrate.result).exitCode == 0 && jsondecode(aws_lambda_invocation.migrate.result).image == local.den_api_image, false)
      error_message = "Migration failed or returned an unknown/wrong-image result. No service rollout is permitted."
    }
  }
}

resource "aws_lambda_invocation" "migrate" {
  function_name   = aws_lambda_function.migration.function_name
  lifecycle_scope = "CREATE_ONLY"
  input = jsonencode({
    cluster        = local.cluster_arn
    taskDefinition = aws_ecs_task_definition.migrate_v1.arn
    image          = local.den_api_image
    deployment     = var.migration_run_id
    networkConfiguration = {
      awsvpcConfiguration = {
        subnets        = var.service_subnet_ids
        securityGroups = [aws_security_group.tasks.id]
        assignPublicIp = var.assign_public_ip ? "ENABLED" : "DISABLED"
      }
    }
  })
  triggers = { source = data.archive_file.migration.output_base64sha256 }
  depends_on = [
    aws_secretsmanager_secret_version.app,
    aws_secretsmanager_secret_version.tls,
    aws_secretsmanager_secret_version.runner,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution,
    aws_vpc_security_group_ingress_rule.db_from_tasks,
  ]
}
