locals {
  migration_identity_ids           = var.registry == null ? [] : (var.registry.identity != "" && var.registry.identity != var.key_vault_identity_id ? [var.registry.identity] : [])
  migration_database_url_mode      = nonsensitive(var.migration_database_url != "") ? "dedicated" : "application"
  migration_database_url_candidate = var.migration_database_url != "" ? var.migration_database_url : local.database_url
  migration_database_url           = local.saved_migration_database_url_mode == local.migration_database_url_mode && var.secret_versions.database_password_version == try(local.saved_versions.database_password_version, 1) && var.secret_versions.migration_database_url_version == try(local.saved_versions.migration_database_url_version, 1) ? try(local.saved_migration_all_secrets["database-url"], local.migration_database_url_candidate) : local.migration_database_url_candidate
  app_database_target              = var.create_database ? "${azurerm_mysql_flexible_server.this[0].fqdn}:3306/${var.database.name}" : nonsensitive(try(regex("^mysql://[^@]+@([^?]+)[?]", var.database_url)[0], ""))
  migration_secret_names           = concat(["database-url", "den-db-encryption-key"], local.registry_password ? ["registry-password"] : [])
  migration_secret_values          = { database-url = local.migration_database_url, den-db-encryption-key = local.secret_values.DEN_DB_ENCRYPTION_KEY, registry-password = local.secret_values.REGISTRY_PASSWORD }
  migration_secret_metadata        = [for name in local.migration_secret_names : { name = name }]
  migration_secret_payload         = [for name in local.migration_secret_names : { name = name, value = local.migration_secret_values[name] }]
  migration_body = {
    properties = {
      environmentId       = local.environment_id
      workloadProfileName = var.workload_profile_name != "" ? var.workload_profile_name : null
      configuration = {
        triggerType         = "Manual", replicaTimeout = var.migration_timeout_seconds, replicaRetryLimit = 0
        manualTriggerConfig = { parallelism = 1, replicaCompletionCount = 1 }
        secrets             = local.migration_secret_metadata
        registries          = local.registries
      }
      template = {
        containers = [{
          name      = "migrate", image = local.den_api_image
          command   = ["node", "/app/ee/packages/den-db/dist/scripts/bootstrap.js"]
          resources = { cpu = 0.5, memory = "1Gi" }
          env = concat(local.plain_env, [
            { name = "OPENWORK_MIGRATION_DATABASE_URL_MODE", value = local.migration_database_url_mode },
            { name = "DATABASE_URL", secretRef = "database-url" },
            { name = "DEN_DB_ENCRYPTION_KEY", secretRef = "den-db-encryption-key" },
          ])
        }]
      }
    }
  }
}
resource "azapi_resource" "migration" {
  type                   = "Microsoft.App/jobs@2025-01-01"
  name                   = "${var.name}-migrate"
  parent_id              = data.azurerm_resource_group.this.id
  location               = local.app_location
  tags                   = var.tags
  ignore_null_property   = true
  response_export_values = []
  dynamic "identity" {
    for_each = length(local.migration_identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.migration_identity_ids
    }
  }
  body           = local.migration_body
  sensitive_body = { properties = { configuration = { secrets = local.migration_secret_payload } } }
  # Full collection must accompany PUT; existing values are read ephemerally.
  sensitive_body_version = {
    "properties.configuration.secrets" = sha256(jsonencode({ body = local.migration_body, tags = var.tags, identities = local.migration_identity_ids, location = local.app_location }))
  }
  depends_on = [azurerm_mysql_flexible_database.this, azurerm_mysql_flexible_server_firewall_rule.azure_services]
  lifecycle {
    precondition {
      condition     = !data.azapi_resource.existing_migration.exists || local.saved_migration_database_url_mode == null || local.saved_migration_database_url_mode == local.migration_database_url_mode || var.secret_versions.migration_database_url_version > try(local.saved_versions.migration_database_url_version, 1)
      error_message = "Changing the migration credential role requires an explicit migration_database_url_version bump."
    }
    precondition {
      condition     = var.migration_database_url == "" || try(regex("^mysql://[^@]+@([^?]+)[?]", var.migration_database_url)[0] == local.app_database_target, false)
      error_message = "migration_database_url must target the same host, port and schema as the application database URL."
    }
  }
}
resource "terraform_data" "migration_release" {
  input = {
    image         = local.den_api_image
    database      = var.create_database ? azurerm_mysql_flexible_database.this[0].id : var.existing_database_identifier
    target        = local.app_database_target
    versions      = var.secret_versions
    deployment_id = var.migration_deployment_id
  }
}
resource "azapi_resource_action" "migration_start" {
  type                   = "Microsoft.App/jobs@2025-01-01"
  resource_id            = azapi_resource.migration.id
  action                 = "start"
  response_export_values = ["id", "name"]
  lifecycle { replace_triggered_by = [terraform_data.migration_release] }
}
# ARM acceptance is not completion. This bounded observer only GETs the exact
# native execution. It never starts/retries/stops a Job and fails closed.
data "external" "migration_completion" {
  program = ["python3", "${path.module}/scripts/wait-for-migration.py"]
  query = {
    execution_id = azapi_resource_action.migration_start.output.id
    timeout      = tostring(var.migration_timeout_seconds + 120)
  }
  lifecycle {
    postcondition {
      condition     = self.result.status == "Succeeded"
      error_message = "Migration did not complete successfully; application rollout is blocked. Inspect the retained Job execution before retrying."
    }
  }
}
