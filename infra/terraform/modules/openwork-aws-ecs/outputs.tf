output "web_url" {
  description = "Den web URL."
  value       = local.web_url
}

output "api_url" {
  description = "Den API public URL (DEN_API_PUBLIC_URL)."
  value       = local.api_url
}

output "openwork_web_url" {
  description = "OpenWork Web (den-gateway) URL. Null unless openwork_web_enabled."
  value       = local.web_enabled ? local.gateway_url : null
}

output "workbot_url" {
  description = "Workbot URL. Null unless workbot.enabled."
  value       = local.workbot_enabled ? local.workbot_url : null
}

output "setup_url" {
  description = "One-time first-administrator page. Works only while the database has no users."
  value       = "${local.web_url}/setup"
}

output "bootstrap_code" {
  description = "Code to enter at /setup with an owner email."
  value       = local.bootstrap_code
  sensitive   = true
}

output "alb_dns_name" {
  description = "ALB hostname, for a CNAME/alias if you manage DNS outside Route 53. Null with an existing ALB or listener."
  value       = one(aws_lb.this[*].dns_name)
}

output "alb_zone_id" {
  description = "ALB hosted zone ID, for a Route 53 alias record. Null with an existing ALB or listener."
  value       = one(aws_lb.this[*].zone_id)
}

output "cluster_name" {
  description = "ECS cluster the services run in (created, or the one passed as ecs_cluster_arn)."
  value       = local.cluster_name
}

output "cluster_arn" {
  value = local.cluster_arn
}

output "alb_arn" {
  description = "ALB ARN (created, or passed as load_balancer_arn). Null with alb_listener_arn."
  value       = local.create_listener ? local.load_balancer_arn : null
}

output "alb_security_group_id" {
  description = "Security group ID of the ALB (created, or passed as alb_security_group_id)."
  value       = local.alb_security_group_id
}

output "service_names" {
  value = { for k, v in {
    den_api         = aws_ecs_service.api.name
    den_web         = aws_ecs_service.web.name
    den_gateway     = one(aws_ecs_service.gateway[*].name)
    headless_runner = one(aws_ecs_service.runner[*].name)
    workbot         = one(aws_ecs_service.workbot[*].name)
  } : k => v if v != null }
}

output "secret_arn" {
  description = "Secrets Manager secret holding DATABASE_URL, auth and encryption keys."
  value       = aws_secretsmanager_secret.app.arn
}

output "database_endpoint" {
  value = var.create_database ? aws_db_instance.this[0].address : null
}

output "task_security_group_id" {
  description = "Allow this group on anything else the app must reach (existing database, internal MCP servers)."
  value       = aws_security_group.tasks.id
}

output "log_groups" {
  value = { for k, v in {
    den_api         = aws_cloudwatch_log_group.api.name
    den_web         = aws_cloudwatch_log_group.web.name
    den_gateway     = one(aws_cloudwatch_log_group.gateway[*].name)
    headless_runner = one(aws_cloudwatch_log_group.runner[*].name)
    workbot         = one(aws_cloudwatch_log_group.workbot[*].name)
  } : k => v if v != null }
}

output "target_group_arns" {
  description = "Load balancer target groups for health monitoring. Null with alb_listener_arn-only setups is not applicable; groups are always created."
  value       = { den_api = aws_lb_target_group.api.arn, den_web = aws_lb_target_group.web.arn }
}

output "database_identifier" {
  description = "RDS instance identifier, for health monitoring. Null with database_url."
  value       = var.create_database ? aws_db_instance.this[0].identifier : null
}

output "certificate_arn" {
  description = "ACM certificate serving the HTTPS listener."
  value       = local.certificate_arn
}
