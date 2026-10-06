# OpenWork Web: den-gateway serves the web app at openwork_web_domain_name,
# forwards /api/den to den-api, and proxies each signed-in member to their
# Daytona sandbox, which den-api provisions. Everything here exists only with
# openwork_web_enabled.

locals {
  gateway_count = local.web_enabled ? 1 : 0
}

# Shared by den-api and den-gateway: den-api answers sandbox lookups only for
# requests carrying it.
resource "random_password" "gateway_key" {
  count = local.gateway_count

  length  = 48
  special = false
}

resource "aws_cloudwatch_log_group" "gateway" {
  count = local.gateway_count

  name              = "/ecs/${var.name}/den-gateway"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lb_target_group" "gateway" {
  count = local.gateway_count

  name                 = "${var.name}-den-gw"
  port                 = 8788
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  # /health is forwarded to the member's sandbox; the gateway's own is /__gw/health.
  health_check {
    path                = "/__gw/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_listener_rule" "gateway_host" {
  count = local.gateway_count

  listener_arn = local.listener_arn
  priority     = var.openwork_web_listener_rule_priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway[0].arn
  }

  condition {
    host_header {
      values = [local.gateway_host]
    }
  }
}

resource "aws_ecs_task_definition" "gateway" {
  count = local.gateway_count

  family                   = "${var.name}-den-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.den_gateway.cpu
  memory                   = var.den_gateway.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name         = "den-gateway"
      image        = local.den_gateway_image
      essential    = true
      portMappings = [{ containerPort = 8788, protocol = "tcp" }]
      environment = [
        { name = "PORT", value = "8788" },
        { name = "DEN_API_BASE", value = local.internal_api_url },
        # The published image bakes in no Den; members sign in through this one.
        { name = "DEN_GATEWAY_DEN_WEB_URL", value = local.web_url },
        { name = "DEN_GATEWAY_VERSION", value = var.openwork_version },
      ]
      secrets = [
        { name = "DEN_GATEWAY_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:DEN_GATEWAY_KEY::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.gateway[0].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "den-gateway"
        }
      }
    },
  ])

  lifecycle {
    precondition {
      condition     = var.daytona_api_key != "" && var.daytona.snapshot != ""
      error_message = "openwork_web_enabled needs daytona_api_key and daytona.snapshot: OpenWork Web runs each member's workspace in a Daytona sandbox."
    }
    precondition {
      condition     = local.provisioner_mode == "daytona"
      error_message = "openwork_web_enabled needs provisioner_mode = \"daytona\" (or empty)."
    }
    precondition {
      condition     = !var.internal_alb || !local.create_alb
      error_message = "OpenWork Web needs an internet-facing ALB: Daytona sandboxes report activity to the public API URL."
    }
  }
}

resource "aws_ecs_service" "gateway" {
  count = local.gateway_count

  name                  = "den-gateway"
  cluster               = local.cluster_arn
  task_definition       = aws_ecs_task_definition.gateway[0].arn
  desired_count         = var.den_gateway.desired_count
  launch_type           = "FARGATE"
  wait_for_steady_state = var.wait_for_steady_state

  health_check_grace_period_seconds = 60
  propagate_tags                    = "SERVICE"
  tags                              = var.tags

  # Reaches den-api over Cloud Map (tasks_self_api); the ALB reaches it on
  # 8788 through tasks_from_alb.
  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway[0].arn
    container_name   = "den-gateway"
    container_port   = 8788
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.gateway_host]
}
