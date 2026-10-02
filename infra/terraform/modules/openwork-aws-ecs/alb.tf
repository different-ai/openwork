# Security groups ------------------------------------------------------------

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "OpenWork ALB"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each = { for pair in setproduct([80, 443], var.allowed_ingress_cidrs) : "${pair[0]}-${pair[1]}" => pair }

  security_group_id = aws_security_group.alb.id
  from_port         = each.value[0]
  to_port           = each.value[0]
  ip_protocol       = "tcp"
  cidr_ipv4         = each.value[1]
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id = aws_security_group.alb.id
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
  referenced_security_group_id = aws_security_group.alb.id
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

# Load balancer --------------------------------------------------------------

resource "aws_lb" "this" {
  name                       = "${var.name}-den"
  internal                   = var.internal_alb
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.alb_subnet_ids
  idle_timeout               = 300 # chat and MCP responses stream
  drop_invalid_header_fields = true
  tags                       = var.tags
}

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

# HTTPS on 443: den-web by default, den-api by host. HTTP redirects.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
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
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
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

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
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

# DNS ------------------------------------------------------------------------

resource "aws_route53_record" "this" {
  for_each = var.route53_zone_id != "" ? toset([var.domain_name, local.api_host]) : toset([])

  zone_id = var.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
