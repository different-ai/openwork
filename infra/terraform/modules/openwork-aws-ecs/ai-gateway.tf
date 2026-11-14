# AI Gateway (ee/apps/gateway, published as openwork-inference), NOT den-gateway.
variable "ai_gateway_enabled" {
  description = "Deploy the AI Gateway for administrator-managed inference. Installation configuration, not a product rollout flag; does not enable OpenWork Web."
  type        = bool
  default     = false

  validation {
    condition = !var.ai_gateway_enabled || alltrue([for name in concat(keys(var.extra_environment), keys(var.extra_secrets)) :
      !startswith(name, "GATEWAY_") && !startswith(name, "INFERENCE_") && !contains(["DB_MODE", "DATABASE_URL", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD", "DEN_DB_ENCRYPTION_KEY", "NODE_ENV", "OPENWORK_DEV_MODE", "PORT"], name)
    ])
    error_message = "With ai_gateway_enabled, remove Gateway/Inference and shared runtime/database overrides from extra_environment and extra_secrets; use the module inputs and existing app secrets."
  }
}

variable "ai_gateway_domain_name" {
  description = "Dedicated desktop-reachable HTTPS hostname for the AI Gateway. Required when enabled; include it in externally managed DNS and certificates."
  type        = string
  default     = ""

  validation {
    condition = !var.ai_gateway_enabled || (
      length(var.ai_gateway_domain_name) <= 253 &&
      can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.ai_gateway_domain_name)) &&
      !can(regex("(^localhost\\.|\\.(localhost|local|internal|svc)$|\\.[0-9]+$)", var.ai_gateway_domain_name))
    )
    error_message = "ai_gateway_enabled requires ai_gateway_domain_name: a qualified non-local DNS hostname, without scheme, port or path."
  }
}

variable "ai_gateway_image" {
  description = "AI Gateway image pinned by digest, normally ghcr.io/different-ai/openwork-inference@sha256:<digest> from the same release as Den. Required when enabled."
  type        = string
  default     = ""

  validation {
    condition     = !var.ai_gateway_enabled || can(regex("@sha256:[a-f0-9]{64}$", var.ai_gateway_image))
    error_message = "ai_gateway_enabled requires ai_gateway_image pinned by @sha256 digest; mutable tags are not supported."
  }
}

variable "ai_gateway_listener_rule_priority" {
  description = "AI Gateway host rule priority on the HTTPS listener. Must be unique, including rules managed outside this module."
  type        = number
  default     = 50

  validation {
    condition     = var.ai_gateway_listener_rule_priority >= 1 && var.ai_gateway_listener_rule_priority <= 50000 && floor(var.ai_gateway_listener_rule_priority) == var.ai_gateway_listener_rule_priority
    error_message = "ai_gateway_listener_rule_priority must be an integer from 1 to 50000."
  }
}

locals {
  ai_gateway_url = "https://${var.ai_gateway_domain_name}"
  # Cloud Map resolves private task IPs. No new public port or shared auth key.
  ai_gateway_proxy_url = "http://ai-gateway.${aws_service_discovery_private_dns_namespace.this.name}:8791"
  ai_gateway_environment = var.ai_gateway_enabled ? {
    GATEWAY_ENABLED         = "true"
    GATEWAY_PROXY_BASE_URL  = local.ai_gateway_proxy_url
    GATEWAY_PUBLIC_BASE_URL = local.ai_gateway_url
    # The legacy Models destination must also be desktop-reachable, not Cloud Map.
    INFERENCE_PROXY_BASE_URL = local.ai_gateway_url
  } : {}
  ai_gateway_secrets = [for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : {
    name = name, valueFrom = "${aws_secretsmanager_secret.app.arn}:${name}::"
  }]
}

resource "aws_cloudwatch_log_group" "ai_gateway" {
  count             = var.ai_gateway_enabled ? 1 : 0
  name              = "/ecs/${var.name}/ai-gateway"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_service_discovery_service" "ai_gateway" {
  count = var.ai_gateway_enabled ? 1 : 0
  name  = "ai-gateway"
  tags  = var.tags
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "ai_gateway" {
  for_each                     = var.ai_gateway_enabled ? { alb = local.alb_security_group_id, internal = aws_security_group.tasks.id } : {}
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = each.value
  from_port                    = 8791
  to_port                      = 8791
  ip_protocol                  = "tcp"
}

resource "aws_lb_target_group" "ai_gateway" {
  count                = var.ai_gateway_enabled ? 1 : 0
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

resource "aws_lb_listener_rule" "ai_gateway" {
  count        = var.ai_gateway_enabled ? 1 : 0
  listener_arn = local.listener_arn
  priority     = var.ai_gateway_listener_rule_priority
  tags         = var.tags
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ai_gateway[0].arn
  }
  condition {
    host_header { values = [var.ai_gateway_domain_name] }
  }
  lifecycle {
    precondition {
      condition     = !contains(concat([var.domain_name, local.api_host], local.web_enabled ? [local.gateway_host] : [], local.workbot_enabled ? [local.workbot_host] : []), var.ai_gateway_domain_name)
      error_message = "The AI Gateway hostname must differ from Den, OpenWork Web (den-gateway) and Workbot."
    }
    precondition {
      condition     = !contains(concat([var.api_listener_rule_priority], !local.create_listener ? [var.web_listener_rule_priority] : [], local.web_enabled ? [var.openwork_web_listener_rule_priority] : [], local.workbot_enabled ? [var.workbot_listener_rule_priority] : []), var.ai_gateway_listener_rule_priority)
      error_message = "The AI Gateway listener priority must differ from all other enabled host rules."
    }
  }
}

resource "aws_ecs_task_definition" "ai_gateway" {
  count                    = var.ai_gateway_enabled ? 1 : 0
  family                   = "${var.name}-ai-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  container_definitions = jsonencode([{
    name         = "ai-gateway"
    image        = var.ai_gateway_image
    essential    = true
    portMappings = [{ containerPort = 8791, protocol = "tcp" }]
    environment  = [for name, value in merge(local.ai_gateway_environment, { NODE_ENV = "production", OPENWORK_DEV_MODE = "0", DB_MODE = "mysql", PORT = "8791" }) : { name = name, value = value }]
    secrets      = local.ai_gateway_secrets
    # Same CA setup as den-api; never run migrations from serving replicas.
    entryPoint = ["/bin/sh", "-ec"]
    command    = ["${local.tls_setup}exec node --import /app/ee/apps/gateway/dist/instrumentation.js /app/ee/apps/gateway/dist/server.js"]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group" = aws_cloudwatch_log_group.ai_gateway[0].name, "awslogs-region" = local.region, "awslogs-stream-prefix" = "ai-gateway"
      }
    }
  }])
}

resource "aws_ecs_service" "ai_gateway" {
  count                             = var.ai_gateway_enabled ? 1 : 0
  name                              = "${var.service_name_prefix}ai-gateway"
  cluster                           = local.cluster_arn
  task_definition                   = aws_ecs_task_definition.ai_gateway[0].arn
  desired_count                     = 1
  launch_type                       = "FARGATE"
  wait_for_steady_state             = var.wait_for_steady_state
  health_check_grace_period_seconds = 120
  propagate_tags                    = "SERVICE"
  tags                              = var.tags
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
  service_registries { registry_arn = aws_service_discovery_service.ai_gateway[0].arn }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [terraform_data.migration_complete, aws_lb_listener_rule.ai_gateway, aws_secretsmanager_secret_version.app]
}

output "ai_gateway_url" {
  description = "AI Gateway HTTPS origin for desktops, or null when disabled. Not the OpenWork Web den-gateway URL."
  value       = var.ai_gateway_enabled ? local.ai_gateway_url : null
}
