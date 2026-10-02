locals {
  create_cluster = var.ecs_cluster_arn == ""
  cluster_arn    = local.create_cluster ? aws_ecs_cluster.this[0].arn : var.ecs_cluster_arn
  # arn:aws:ecs:<region>:<account>:cluster/<name>
  cluster_name = local.create_cluster ? aws_ecs_cluster.this[0].name : element(split("/", var.ecs_cluster_arn), length(split("/", var.ecs_cluster_arn)) - 1)
}

resource "aws_ecs_cluster" "this" {
  count = local.create_cluster ? 1 : 0

  name = "${var.name}-den"
  tags = var.tags

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Earlier versions always created the cluster; keep it in state when upgrading.
moved {
  from = aws_ecs_cluster.this
  to   = aws_ecs_cluster.this[0]
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.name}.internal"
  description = "OpenWork service discovery"
  vpc         = var.vpc_id
  tags        = var.tags
}

resource "aws_service_discovery_service" "api" {
  name = "den-api"
  tags = var.tags

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

}

# IAM ------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by the ECS agent: pull images, write logs, read secrets.
resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-den-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([aws_secretsmanager_secret.app.arn], [for a in local.extra_secret_resource_arns : a if strcontains(a, ":secretsmanager:")])
  }

  dynamic "statement" {
    for_each = length([for a in local.extra_secret_resource_arns : a if strcontains(a, ":ssm:")]) > 0 ? [1] : []
    content {
      actions   = ["ssm:GetParameters"]
      resources = [for a in local.extra_secret_resource_arns : a if strcontains(a, ":ssm:")]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-openwork-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Assumed by the app itself. No AWS permissions yet; attach policies here if
# you add, for example, Bedrock or SES API access.
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name}-den-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = var.tags
}

# Logs -----------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/den-api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}/den-web"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

locals {
  log_options = {
    api = { "awslogs-group" = aws_cloudwatch_log_group.api.name, "awslogs-region" = local.region }
    web = { "awslogs-group" = aws_cloudwatch_log_group.web.name, "awslogs-region" = local.region }
  }
}

# Task definitions -----------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-den-api"
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

  container_definitions = jsonencode([
    {
      # Same migration the Helm chart runs as a pre-install/pre-upgrade Job.
      # It exits when done; den-api starts only if it succeeded.
      name        = "migrate"
      image       = local.den_api_image
      essential   = false
      command     = ["node", "/app/ee/packages/den-db/dist/scripts/bootstrap.js"]
      environment = local.environment_list
      secrets     = local.secrets_list
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options.api, { "awslogs-stream-prefix" = "migrate" })
      }
    },
    {
      name         = "den-api"
      image        = local.den_api_image
      essential    = true
      portMappings = [{ containerPort = 8788, protocol = "tcp" }]
      environment  = concat(local.environment_list, [{ name = "PORT", value = "8788" }])
      secrets      = local.secrets_list
      dependsOn    = [{ containerName = "migrate", condition = "SUCCESS" }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options.api, { "awslogs-stream-prefix" = "den-api" })
      }
    },
  ])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-den-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.den_web.cpu
  memory                   = var.den_web.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name         = "den-web"
      image        = local.den_web_image
      essential    = true
      portMappings = [{ containerPort = 3005, protocol = "tcp" }]
      environment  = concat(local.environment_list, [{ name = "PORT", value = "3005" }])
      secrets      = local.secrets_list
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options.web, { "awslogs-stream-prefix" = "den-web" })
      }
    },
  ])
}

# Services -------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "den-api"
  cluster         = local.cluster_arn
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.den_api.desired_count
  launch_type     = "FARGATE"

  # Migrations run before den-api listens; allow for a cold start.
  health_check_grace_period_seconds = 300
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"
  tags                              = var.tags

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "den-api"
    container_port   = 8788
  }

  service_registries {
    registry_arn = aws_service_discovery_service.api.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.api_host]
}

resource "aws_ecs_service" "web" {
  name            = "den-web"
  cluster         = local.cluster_arn
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.den_web.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 120
  propagate_tags                    = "SERVICE"
  tags                              = var.tags

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "den-web"
    container_port   = 3005
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}
