# Load balancer modes:
#   default            the module creates the ALB, its security group, and the
#                      HTTPS/HTTP listeners.
#   load_balancer_arn  the module adds HTTPS/HTTP listeners to your ALB.
#   alb_listener_arn   the module adds host rules to your HTTPS listener
#                      (takes precedence over load_balancer_arn).

locals {
  create_alb      = var.load_balancer_arn == "" && var.alb_listener_arn == ""
  create_listener = var.alb_listener_arn == ""
  # A security group can only be attached to an ALB this module creates. With
  # an existing ALB, alb_security_group_id is required (see tasks_from_alb).
  create_alb_sg         = local.create_alb && var.alb_security_group_id == ""
  alb_security_group_id = local.create_alb_sg ? one(aws_security_group.alb[*].id) : var.alb_security_group_id
  load_balancer_arn     = local.create_alb ? one(aws_lb.this[*].arn) : var.load_balancer_arn
  listener_arn          = local.create_listener ? one(aws_lb_listener.https[*].arn) : var.alb_listener_arn
}

# These resources gained `count`; keep existing deployments' objects in place.
moved {
  from = aws_security_group.alb
  to   = aws_security_group.alb[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.alb
  to   = aws_vpc_security_group_egress_rule.alb[0]
}

moved {
  from = aws_lb.this
  to   = aws_lb.this[0]
}

moved {
  from = aws_lb_listener.https
  to   = aws_lb_listener.https[0]
}

moved {
  from = aws_lb_listener.http
  to   = aws_lb_listener.http[0]
}

# Security groups ------------------------------------------------------------

resource "aws_security_group" "alb" {
  count = local.create_alb_sg ? 1 : 0

  name_prefix = "${var.name}-alb-"
  description = "OpenWork ALB"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each = local.create_alb_sg ? { for pair in setproduct([80, 443], var.allowed_ingress_cidrs) : "${pair[0]}-${pair[1]}" => pair } : {}

  security_group_id = aws_security_group.alb[0].id
  from_port         = each.value[0]
  to_port           = each.value[0]
  ip_protocol       = "tcp"
  cidr_ipv4         = each.value[1]
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  count = local.create_alb_sg ? 1 : 0

  security_group_id = aws_security_group.alb[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-tasks-"
  description = "OpenWork Fargate tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each = toset(["8788", "3005"])

  security_group_id            = aws_security_group.tasks.id
  from_port                    = tonumber(each.value)
  to_port                      = tonumber(each.value)
  ip_protocol                  = "tcp"
  referenced_security_group_id = local.alb_security_group_id

  lifecycle {
    precondition {
      condition     = local.create_alb || var.alb_security_group_id != ""
      error_message = "Set alb_security_group_id to your load balancer's security group when using load_balancer_arn or alb_listener_arn, so the tasks accept traffic from it."
    }
  }
}

# den-web -> den-api over Cloud Map.
resource "aws_vpc_security_group_ingress_rule" "tasks_self_api" {
  security_group_id            = aws_security_group.tasks.id
  from_port                    = 8788
  to_port                      = 8788
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

# Image pulls, email, MCP servers and model providers all need egress.
resource "aws_vpc_security_group_egress_rule" "tasks" {
  security_group_id = aws_security_group.tasks.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Load balancer -------------------------------------------------------------

resource "aws_lb" "this" {
  count                      = local.create_alb ? 1 : 0
  name                       = "${var.name}-den"
  internal                   = var.internal_alb
  load_balancer_type         = "application"
  security_groups            = [local.alb_security_group_id]
  subnets                    = var.alb_subnet_ids
  idle_timeout               = 300 # chat and MCP responses stream
  drop_invalid_header_fields = true
  tags                       = var.tags

  lifecycle {
    precondition {
      condition     = length(var.alb_subnet_ids) >= 2
      error_message = "alb_subnet_ids must contain at least two subnet IDs in different availability zones when creating an ALB."
    }
  }
}

# Target groups --------------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-den-api"
  port                 = 8788
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

resource "aws_lb_target_group" "web" {
  name                 = "${var.name}-den-web"
  port                 = 3005
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

# Listeners -----------------------------------------------------------------

# HTTPS on 443: den-web by default, den-api by host. HTTP redirects.
resource "aws_lb_listener" "https" {
  count = local.create_listener ? 1 : 0

  load_balancer_arn = local.load_balancer_arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn
  tags              = var.tags

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api_host" {
  listener_arn = local.listener_arn
  priority     = var.api_listener_rule_priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [local.api_host]
    }
  }
}

resource "aws_lb_listener_rule" "web_host" {
  count = local.create_listener ? 0 : 1

  listener_arn = local.listener_arn
  priority     = var.web_listener_rule_priority
  tags         = var.tags

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.domain_name]
    }
  }
}

resource "aws_lb_listener" "http" {
  count = local.create_listener ? 1 : 0

  load_balancer_arn = local.load_balancer_arn
  port              = 80
  protocol          = "HTTP"
  tags              = var.tags

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener_certificate" "this" {
  count = !local.create_listener && var.attach_listener_certificate ? 1 : 0

  listener_arn    = local.listener_arn
  certificate_arn = local.certificate_arn
}

# DNS ------------------------------------------------------------------------

resource "aws_route53_record" "this" {
  for_each = local.create_alb && var.route53_zone_id != "" ? toset(concat([var.domain_name, local.api_host], local.web_enabled ? [local.gateway_host] : [])) : toset([])

  zone_id = var.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.this[0].dns_name
    zone_id                = aws_lb.this[0].zone_id
    evaluate_target_health = true
  }
}
