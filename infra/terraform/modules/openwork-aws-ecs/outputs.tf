output "web_url" {
  description = "Den web URL."
  value       = local.web_url
}

output "api_url" {
  description = "Den API public URL (DEN_API_PUBLIC_URL)."
  value       = local.api_url
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
  value = { den_api = aws_ecs_service.api.name, den_web = aws_ecs_service.web.name }
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
  value = { den_api = aws_cloudwatch_log_group.api.name, den_web = aws_cloudwatch_log_group.web.name }
}
