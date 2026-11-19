# Existing cloud values are read ephemerally, never via a stateful data source.
# This also preserves credentials when an initial apply created only some apps.
data "azapi_resource" "existing_api" {
  type                   = "Microsoft.App/containerApps@2025-01-01"
  resource_id            = "${data.azurerm_resource_group.this.id}/providers/Microsoft.App/containerApps/${local.api_app_name}"
  ignore_not_found       = true
  response_export_values = { versions = "properties.template.containers[0].env[?name=='OPENWORK_DEPLOYMENT_SECRETS_VERSION'].value | [0]" }
}
data "azapi_resource" "existing_migration" {
  type             = "Microsoft.App/jobs@2025-01-01"
  resource_id      = "${data.azurerm_resource_group.this.id}/providers/Microsoft.App/jobs/${var.name}-migrate"
  ignore_not_found = true
  response_export_values = {
    versions          = "properties.template.containers[0].env[?name=='OPENWORK_DEPLOYMENT_SECRETS_VERSION'].value | [0]"
    database_url_mode = "properties.template.containers[0].env[?name=='OPENWORK_MIGRATION_DATABASE_URL_MODE'].value | [0]"
  }
}
ephemeral "azapi_resource_action" "api_secrets" {
  provider               = azapi.secret_read
  count                  = data.azapi_resource.existing_api.exists ? 1 : 0
  type                   = "Microsoft.App/containerApps@2025-01-01"
  resource_id            = data.azapi_resource.existing_api.resource_id
  action                 = "listSecrets"
  response_export_values = ["value"]
  lifecycle {
    postcondition {
      condition     = alltrue([for name in ["database-url", "better-auth-secret", "den-db-encryption-key", "den-initial-admin-bootstrap-code"] : contains([for secret in self.output.value : secret.name], name)])
      error_message = "Existing API secret store is incomplete; stop and recover its original values before applying."
    }
  }
}
ephemeral "azapi_resource_action" "migration_secrets" {
  provider               = azapi.secret_read
  count                  = data.azapi_resource.existing_migration.exists ? 1 : 0
  type                   = "Microsoft.App/jobs@2025-01-01"
  resource_id            = data.azapi_resource.existing_migration.resource_id
  action                 = "listSecrets"
  response_export_values = ["value"]
  lifecycle {
    postcondition {
      condition     = alltrue([for name in ["database-url", "den-db-encryption-key"] : contains([for secret in self.output.value : secret.name], name)])
      error_message = "Existing migration secret store is incomplete; recover its original values before applying."
    }
  }
}
locals {
  saved_api_secrets = data.azapi_resource.existing_api.exists ? { for secret in ephemeral.azapi_resource_action.api_secrets[0].output.value : secret.name => secret.value if contains([for name in local.managed_secret_names : lower(replace(name, "_", "-"))], secret.name) } : {}
  # A distinct DDL URL must never become the application's DML URL on recovery.
  saved_migration_all_secrets       = data.azapi_resource.existing_migration.exists ? { for secret in ephemeral.azapi_resource_action.migration_secrets[0].output.value : secret.name => secret.value } : {}
  saved_migration_database_url_mode = try(data.azapi_resource.existing_migration.output.database_url_mode, null)
  reusable_migration_secret_names   = concat(["den-db-encryption-key", "registry-password"], local.saved_migration_database_url_mode == "application" ? ["database-url"] : [])
  saved_migration_secrets           = { for name, value in local.saved_migration_all_secrets : name => value if contains(local.reusable_migration_secret_names, name) }
  saved_secrets                     = merge(local.saved_migration_secrets, local.saved_api_secrets)
  saved_versions                    = data.azapi_resource.existing_api.exists ? try(jsondecode(data.azapi_resource.existing_api.output.versions), {}) : try(jsondecode(data.azapi_resource.existing_migration.output.versions), {})
  version_names = {
    DATABASE_URL                     = "database_password_version"
    BETTER_AUTH_SECRET               = "better_auth_secret_version"
    DEN_DB_ENCRYPTION_KEY            = "db_encryption_key_version"
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = "bootstrap_code_version"
    SMTP_PASS                        = "smtp_password_version"
    RESEND_API_KEY                   = "resend_api_key_version"
    REGISTRY_PASSWORD                = "registry_password_version"
  }
  secret_values = { for name, generated in local.generated_secret_values : name => (
    var.secret_versions[local.version_names[name]] == try(local.saved_versions[local.version_names[name]], 1)
    ? try(local.saved_secrets[lower(replace(name, "_", "-"))], generated)
    : generated
  ) }
}

# If infrastructure failed before any cloud copy existed, do not invent a new
# password for a surviving database. Recovery must deliberately reset/preserve it.
data "azapi_resource" "existing_database" {
  count                  = var.create_database ? 1 : 0
  type                   = "Microsoft.DBforMySQL/flexibleServers@2023-12-30"
  resource_id            = "${data.azurerm_resource_group.this.id}/providers/Microsoft.DBforMySQL/flexibleServers/${var.name}-den-${random_string.db_suffix[0].result}"
  ignore_not_found       = true
  response_export_values = []
}
