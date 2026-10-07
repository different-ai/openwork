# Headless runner and Workbot.
#
# The runner is Den's private agent service: Slack replies, headless
# Automations and Workbot turns run there. It calls the model directly and
# reaches tools through Den's public /mcp/agent with short-lived member-scoped
# tokens Den mints per turn. Den and Workbot reach it through ECS Service
# Connect at http://headless-runner:8795. State is one SQLite file, so it runs
# as a single task with its data on EFS. Workbot is a public chat app at
# workbot.domain_name whose turns run on the runner.

locals {
  runner_count = local.runner_enabled ? 1 : 0
  # Workbot needs the runner; den-api's precondition reports the mistake.
  workbot_count = local.workbot_enabled && local.runner_enabled ? 1 : 0
  efs_count     = local.runner_enabled ? 1 : 0

  runner_secret_values = local.runner_enabled ? { for k, v in {
    HEADLESS_API_TOKEN     = random_password.runner_token[0].result
    HEADLESS_MODEL_API_KEY = var.headless_model_api_key
    WORKBOT_SESSION_SECRET = try(random_password.workbot_session[0].result, "")
  } : k => v if v != "" } : {}

  runner_secret_ref = local.runner_enabled ? "${aws_secretsmanager_secret.runner[0].arn}:HEADLESS_API_TOKEN::" : ""
}

# Secrets only the runner and Workbot use, kept out of the shared app secret so
# den-web never receives them. den-api gets just the runner token.
resource "random_password" "runner_token" {
  count = local.runner_count

  length  = 48
  special = false
}

resource "random_password" "workbot_session" {
  count = local.workbot_count

  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "runner" {
  count = local.runner_count

  name_prefix             = "${var.name}-runner-"
  description             = "OpenWork headless runner and Workbot secrets (${var.name})"
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "runner" {
  count = local.runner_count

  secret_id     = aws_secretsmanager_secret.runner[0].id
  secret_string = jsonencode(local.runner_secret_values)
}

# Persistent storage ---------------------------------------------------------

resource "aws_efs_file_system" "agents" {
  count = local.efs_count

  creation_token = "${var.name}-agents"
  encrypted      = true
  tags           = merge(var.tags, { Name = "${var.name}-agents" })
}

resource "aws_security_group" "efs" {
  count = local.efs_count

  name_prefix = "${var.name}-efs-"
  description = "OpenWork agent data (EFS)"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-efs" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_tasks" {
  count = local.efs_count

  security_group_id            = aws_security_group.efs[0].id
  from_port                    = 2049
  to_port                      = 2049
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

# One mount target per service subnet. EFS allows one per availability zone,
# so service_subnet_ids must be in different zones (the usual layout). Counted
# by position because subnet ids may only be known after apply.
resource "aws_efs_mount_target" "agents" {
  count = local.runner_enabled ? length(var.service_subnet_ids) : 0

  file_system_id  = aws_efs_file_system.agents[0].id
  subnet_id       = var.service_subnet_ids[count.index]
  security_groups = [aws_security_group.efs[0].id]
}

resource "aws_efs_access_point" "runner" {
  count = local.runner_count

  file_system_id = aws_efs_file_system.agents[0].id
  tags           = merge(var.tags, { Name = "${var.name}-headless-runner" })

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/headless-runner"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "750"
    }
  }
}

resource "aws_efs_access_point" "workbot" {
  count = local.workbot_count

  file_system_id = one(aws_efs_file_system.agents[*].id)
  tags           = merge(var.tags, { Name = "${var.name}-workbot" })

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/workbot"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "750"
    }
  }
}

# den-api and Workbot call the runner over Service Connect.
resource "aws_vpc_security_group_ingress_rule" "tasks_self_runner" {
  count = local.runner_count

  security_group_id            = aws_security_group.tasks.id
  from_port                    = 8795
  to_port                      = 8795
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

# Headless runner --------------------------------------------------------------

resource "aws_cloudwatch_log_group" "runner" {
  count = local.runner_count

  name              = "/ecs/${var.name}/headless-runner"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_task_definition" "runner" {
  count = local.runner_count

  family                   = "${var.name}-headless-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.headless_runner.cpu
  memory                   = var.headless_runner.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.agents[0].id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.runner[0].id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name         = "headless-runner"
      image        = local.runner_image
      essential    = true
      portMappings = [{ name = "runner", containerPort = 8795, protocol = "tcp", appProtocol = "http" }]
      mountPoints  = [{ sourceVolume = "data", containerPath = "/var/data" }]
      environment = [
        { name = "HEADLESS_PORT", value = "8795" },
        { name = "HEADLESS_DB_PATH", value = "/var/data/headless.sqlite" },
        { name = "HEADLESS_MODEL_PROTOCOL", value = var.headless_runner.model_protocol },
        { name = "HEADLESS_MODEL_BASE_URL", value = var.headless_runner.model_base_url },
        { name = "HEADLESS_MODEL", value = var.headless_runner.model },
        # Tools come from Den's public MCP endpoint, which must be https.
        { name = "HEADLESS_MCP_URL", value = "${local.api_url}/mcp/agent" },
        # Uploads and files the agent hands back live next to the database.
        { name = "HEADLESS_FILES", value = "disk" },
      ]
      secrets = [for k in keys(local.runner_secret_values) : { name = k, valueFrom = "${aws_secretsmanager_secret.runner[0].arn}:${k}::" } if k != "WORKBOT_SESSION_SECRET"]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.runner[0].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "headless-runner"
        }
      }
    },
  ])

  lifecycle {
    precondition {
      condition     = var.headless_runner.model != ""
      error_message = "headless_runner.enabled needs headless_runner.model (a model id at headless_runner.model_base_url)."
    }
  }
}

resource "aws_ecs_service" "runner" {
  count = local.runner_count

  name                  = "headless-runner"
  cluster               = local.cluster_arn
  task_definition       = aws_ecs_task_definition.runner[0].arn
  desired_count         = 1
  launch_type           = "FARGATE"
  wait_for_steady_state = var.wait_for_steady_state
  propagate_tags        = "SERVICE"
  tags                  = var.tags

  # One SQLite file: never run two tasks against it, even during a deploy.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_private_dns_namespace.this.arn
    service {
      port_name      = "runner"
      discovery_name = "headless-runner"
      client_alias {
        port     = 8795
        dns_name = "headless-runner"
      }
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_efs_mount_target.agents, aws_secretsmanager_secret_version.runner]
}

# Workbot --------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "workbot" {
  count = local.workbot_count

  name              = "/ecs/${var.name}/workbot"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lb_target_group" "workbot" {
  count = local.workbot_count

  name                 = "${var.name}-workbot"
  port                 = 3020
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_listener_rule" "workbot_host" {
  count = local.workbot_count

  listener_arn = local.listener_arn
  priority     = var.workbot_listener_rule_priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.workbot[0].arn
  }

  condition {
    host_header {
      values = [local.workbot_host]
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb_workbot" {
  count = local.workbot_count

  security_group_id            = aws_security_group.tasks.id
  from_port                    = 3020
  to_port                      = 3020
  ip_protocol                  = "tcp"
  referenced_security_group_id = local.alb_security_group_id
}

resource "aws_ecs_task_definition" "workbot" {
  count = local.workbot_count

  family                   = "${var.name}-workbot"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.workbot.cpu
  memory                   = var.workbot.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = one(aws_efs_file_system.agents[*].id)
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = one(aws_efs_access_point.workbot[*].id)
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name         = "workbot"
      image        = local.workbot_image
      essential    = true
      portMappings = [{ name = "workbot", containerPort = 3020, protocol = "tcp", appProtocol = "http" }]
      mountPoints  = [{ sourceVolume = "data", containerPath = "/var/data" }]
      environment = [
        { name = "WORKBOT_PORT", value = "3020" },
        { name = "WORKBOT_DB_PATH", value = "/var/data/workbot.sqlite" },
        { name = "WORKBOT_PUBLIC_URL", value = local.workbot_url },
        { name = "WORKBOT_DEN_API_URL", value = local.api_url },
        { name = "WORKBOT_DEN_WEB_URL", value = local.web_url },
        { name = "WORKBOT_RUNNER_URL", value = local.runner_url },
      ]
      secrets = [
        { name = "WORKBOT_RUNNER_TOKEN", valueFrom = local.runner_secret_ref },
        { name = "WORKBOT_SESSION_SECRET", valueFrom = "${one(aws_secretsmanager_secret.runner[*].arn)}:WORKBOT_SESSION_SECRET::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.workbot[0].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "workbot"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "workbot" {
  count = local.workbot_count

  name                  = "workbot"
  cluster               = local.cluster_arn
  task_definition       = aws_ecs_task_definition.workbot[0].arn
  desired_count         = 1
  launch_type           = "FARGATE"
  wait_for_steady_state = var.wait_for_steady_state
  propagate_tags        = "SERVICE"
  tags                  = var.tags

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.workbot[0].arn
    container_name   = "workbot"
    container_port   = 3020
  }

  # Client only: resolves http://headless-runner.
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_private_dns_namespace.this.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.workbot_host, aws_efs_mount_target.agents, aws_secretsmanager_secret_version.runner, aws_ecs_service.runner]
}
