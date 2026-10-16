# AI Gateway (ee/apps/gateway, image openwork-inference): the organization's
# own model gateway. Admins add AI providers, models and usage limits in Den;
# desktops and the headless runner call it at ai_gateway_host with each
# member's Gateway key. den-api manages it over ECS Service Connect at
# http://ai-gateway:8791. It shares Den's database and encryption key, so the
# migrations den-api runs at start cover its tables too. Not to be confused
# with den-gateway (gateway.tf), which serves OpenWork Web.

locals {
  ai_gateway_count = local.ai_gateway_enabled ? 1 : 0
}

resource "aws_cloudwatch_log_group" "ai_gateway" {
  count = local.ai_gateway_count

  name              = "/ecs/${var.name}/ai-gateway"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lb_target_group" "ai_gateway" {
  count = local.ai_gateway_count

  name                 = "${var.name}-ai-gateway"
  port                 = 8791
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_listener_rule" "ai_gateway_host" {
  count = local.ai_gateway_count

  listener_arn = local.listener_arn
  priority     = var.ai_gateway_listener_rule_priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ai_gateway[0].arn
  }

  condition {
    host_header {
      values = [local.ai_gateway_host]
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb_ai_gateway" {
  count = local.ai_gateway_count

  security_group_id            = aws_security_group.tasks.id
  from_port                    = 8791
  to_port                      = 8791
  ip_protocol                  = "tcp"
  referenced_security_group_id = local.alb_security_group_id
}

# den-api calls the Gateway over Service Connect.
resource "aws_vpc_security_group_ingress_rule" "tasks_self_ai_gateway" {
  count = local.ai_gateway_count

  security_group_id            = aws_security_group.tasks.id
  from_port                    = 8791
  to_port                      = 8791
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_ecs_task_definition" "ai_gateway" {
  count = local.ai_gateway_count

  family                   = "${var.name}-ai-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ai_gateway.cpu
  memory                   = var.ai_gateway.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name         = "ai-gateway"
      image        = local.ai_gateway_image
      essential    = true
      portMappings = [{ name = "ai-gateway", containerPort = 8791, protocol = "tcp", appProtocol = "http" }]
      # Mirrors the openwork-ee Helm chart's Gateway deployment (gateway.enabled).
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "OPENWORK_DEV_MODE", value = "0" },
        { name = "DB_MODE", value = "mysql" },
        { name = "PORT", value = "8791" },
        { name = "GATEWAY_ENABLED", value = "true" },
        { name = "GATEWAY_PUBLIC_BASE_URL", value = local.ai_gateway_url },
        { name = "GATEWAY_PROXY_BASE_URL", value = local.ai_gateway_internal_url },
        { name = "INFERENCE_PROXY_BASE_URL", value = local.ai_gateway_url },
      ]
      secrets = [for k in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY", "DATABASE_REDIS_URL"] : {
        name      = k
        valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::"
      } if contains(keys(local.secret_values), k)]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ai_gateway[0].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ai-gateway"
        }
      }
    },
  ])

  lifecycle {
    precondition {
      condition     = var.create_database || startswith(var.database_url, "mysql://")
      error_message = "The AI Gateway needs a mysql:// database_url (or create_database)."
    }
  }
}

resource "aws_ecs_service" "ai_gateway" {
  count = local.ai_gateway_count

  name                  = "${var.service_name_prefix}ai-gateway"
  cluster               = local.cluster_arn
  task_definition       = aws_ecs_task_definition.ai_gateway[0].arn
  desired_count         = var.ai_gateway.desired_count
  launch_type           = "FARGATE"
  wait_for_steady_state = var.wait_for_steady_state
  propagate_tags        = "SERVICE"
  tags                  = var.tags

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ai_gateway[0].arn
    container_name   = "ai-gateway"
    container_port   = 8791
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_private_dns_namespace.this.arn
    service {
      port_name      = "ai-gateway"
      discovery_name = "ai-gateway"
      client_alias {
        port     = 8791
        dns_name = "ai-gateway"
      }
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Started before den-api: a Service Connect client resolves only the aliases
  # that exist when its task starts. /health does not need den-api's migrations.
  depends_on = [aws_lb_listener_rule.ai_gateway_host, aws_secretsmanager_secret_version.app]
}
