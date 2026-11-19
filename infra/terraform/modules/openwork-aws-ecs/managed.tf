# Managed installers retain their legacy state-backed seed and strict current
# version. Direct callers keep the write-only default and single app version.
variable "managed_legacy_secrets" {
  description = "Installer compatibility only: preserve the legacy seed and strict current SecretVersion. Requires the installer's maintenance fence; never enable for a direct deployment."
  type        = bool
  default     = false
  validation {
    condition     = !var.managed_legacy_secrets || !var.write_only_secrets
    error_message = "Managed legacy state must explicitly retain write_only_secrets=false."
  }
}

locals {
  managed_seed_values = merge(local.secret_values, {
    DATABASE_URL = replace(local.database_url, "?${var.database.tls_query}", "?sslaccept=accept")
  })
}

moved {
  from = aws_secretsmanager_secret_version.tls
  to   = aws_secretsmanager_secret_version.tls[0]
}

# The runner has already stopped legacy writers. Definitions have CA trust
# before AWSCURRENT can change; no service starts until strict migration passes.
resource "aws_secretsmanager_secret_version" "tls" {
  count         = var.managed_legacy_secrets ? 1 : 0
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.secret_values)
  depends_on = [
    aws_secretsmanager_secret_version.app,
    aws_ecs_task_definition.api_v1, aws_ecs_task_definition.web_v1, aws_ecs_task_definition.migrate_v1,
  ]
}
