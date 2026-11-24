# Offline contract: Azure is mocked; ephemeral random generation is local.
mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test", location = "eastus" }
  }
  mock_data "azurerm_container_app_environment" {
    defaults = { default_domain = "shared-env-9876.westeurope.azurecontainerapps.io", custom_domain_verification_id = "VERIFY987", location = "westeurope" }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den"
      default_domain                = "happy-sky-1234.eastus.azurecontainerapps.io"
      custom_domain_verification_id = "VERIFY123"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/openwork-den-logs" }
  }
  mock_resource "azurerm_mysql_flexible_server" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.DBforMySQL/flexibleServers/openwork", fqdn = "openwork-den-abc123.mysql.database.azure.com" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/privateDnsZones/openwork-den.private.mysql.database.azure.com" }
  }
  mock_resource "azurerm_container_app_environment_certificate" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den/certificates/openwork-den" }
  }
}
# Terraform does not mock ephemeral resource types, even with count = 0.
# Keep their schema real on a separate read-only binding; all existing-store
# metadata is mocked absent, so these synthetic credentials are never used.
provider "azapi" {
  alias           = "secret_read"
  subscription_id = "00000000-0000-0000-0000-000000000000"
  tenant_id       = "00000000-0000-0000-0000-000000000000"
  client_id       = "00000000-0000-0000-0000-000000000000"
  client_secret   = "fixture-not-used"
  use_cli         = false
}
mock_provider "azapi" {
  mock_data "azapi_resource" {
    defaults = { exists = false, output = { versions = null } }
  }
  mock_resource "azapi_resource" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/app", output = { properties = { outboundIpAddresses = [] } } }
  }
  mock_resource "azapi_resource_action" {
    defaults = { output = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate/executions/test" } }
  }
}
override_resource {
  target = azapi_resource.migration
  values = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate" }
}
mock_provider "external" {
  mock_data "external" { defaults = { result = { status = "Succeeded" } } }
}
variables {
  resource_group_name = "rg-test"
  owner_emails        = ["admin@example.com"]
}

run "default_stack" {
  command = apply
  assert {
    condition     = length(azurerm_container_app_environment.this) == 1 && length(azurerm_log_analytics_workspace.this) == 1 && azapi_resource.api.body.properties.managedEnvironmentId == azurerm_container_app_environment.this[0].id
    error_message = "A fresh stack must create an environment/log sink and use that environment."
  }
  assert {
    condition     = output.web_url == "https://openwork-den-web.happy-sky-1234.eastus.azurecontainerapps.io" && output.api_url == "https://openwork-den-api.happy-sky-1234.eastus.azurecontainerapps.io" && output.setup_url == "${output.web_url}/setup" && output.migration_step_identifier == azapi_resource.migration.id
    error_message = "Shared outputs must identify HTTPS origins and the native migration step."
  }
}

run "default_state_contains_no_secret_values" {
  command = apply
  assert {
    condition = alltrue(concat(
      [for secret in azapi_resource.api.body.properties.configuration.secrets : !contains(keys(secret), "value")],
      [for secret in azapi_resource.web.body.properties.configuration.secrets : !contains(keys(secret), "value")],
      [for secret in azapi_resource.migration.body.properties.configuration.secrets : !contains(keys(secret), "value")],
    )) && azurerm_mysql_flexible_server.this[0].administrator_password == null && output.bootstrap_code == null
    error_message = "Default persistent resource state must contain only secret metadata, never secret values or a bootstrap-code output."
  }
  assert {
    condition     = length(azapi_resource.api.sensitive_body_version) == 1 && length(azapi_resource.api.sensitive_body_version["properties.configuration.secrets"]) == 64 && var.database.tls_query == "sslaccept=strict" && var.deletion_protection && azurerm_management_lock.database[0].lock_level == "CanNotDelete"
    error_message = "State-free write-only secret gates, verified TLS and the database deletion lock must be defaults."
  }
}

run "surviving_database_without_secret_copy_fails_closed" {
  command = plan
  override_data {
    target = data.azapi_resource.existing_database
    values = { exists = true, output = {} }
  }
  expect_failures = [azurerm_mysql_flexible_server.this]
}

run "singleton_migration_and_api_only_replicas" {
  command = apply
  assert {
    condition     = azapi_resource.migration.body.properties.template.containers[0].command == ["node", "/app/ee/packages/den-db/dist/scripts/bootstrap.js"] && azapi_resource.migration.body.properties.configuration.replicaRetryLimit == 0 && azapi_resource.migration.body.properties.configuration.manualTriggerConfig.parallelism == 1 && azapi_resource.migration.body.properties.configuration.manualTriggerConfig.replicaCompletionCount == 1
    error_message = "Only the singleton Job may run the migration; failed attempts must not auto-retry."
  }
  assert {
    condition     = length(azapi_resource.api.body.properties.template.initContainers) == 0 && length(azapi_resource.web.body.properties.template.initContainers) == 0 && azapi_resource.migration.body.properties.template.containers[0].image == azapi_resource.api.body.properties.template.containers[0].image
    error_message = "API and web replicas must never migrate; Job and API must share the immutable image."
  }
  assert {
    condition     = alltrue(flatten([for container in [azapi_resource.api.body.properties.template.containers[0], azapi_resource.web.body.properties.template.containers[0], azapi_resource.migration.body.properties.template.containers[0]] : [for env in container.env : !contains(keys(env), "value") if contains(local.secret_env_names, env.name)]])) && !contains([for env in azapi_resource.migration.body.properties.template.containers[0].env : env.name], "BETTER_AUTH_SECRET")
    error_message = "Secrets must be secretRef bindings, never plain env values; migration must not receive app auth secrets."
  }
}

run "two_api_replicas_one_migrator" {
  command = apply
  variables {
    den_api             = { replicas = 2 }
    deletion_protection = false
    database            = { name = "exp-ow-tf-c1-proof-db" }
  }
  assert {
    condition     = azapi_resource.api.body.properties.template.scale.minReplicas == 2 && azapi_resource.api.body.properties.template.scale.maxReplicas == 2 && azapi_resource.migration.body.properties.configuration.manualTriggerConfig.parallelism == 1 && length(azurerm_management_lock.database) == 0 && azurerm_mysql_flexible_database.this[0].name == "exp-ow-tf-c1-proof-db"
    error_message = "Two API-only replicas must retain one migrator; disposable stacks can disable the lock and prefix their schema."
  }
  assert {
    condition     = azapi_resource.api.body.properties.template.containers[0].resources.cpu == 1 && azapi_resource.api.body.properties.template.containers[0].resources.memory == "2Gi" && azapi_resource.web.body.properties.template.containers[0].resources.cpu == 0.5 && azapi_resource.web.body.properties.template.containers[0].resources.memory == "1Gi"
    error_message = "API/web defaults must be at least 1 CPU/2 GiB and 0.5 CPU/1 GiB."
  }
}

run "rejects_plain_secret" {
  command = plan
  variables { extra_environment = { DATABASE_URL = "fixture", AZURE_STORAGE_KEY = "fixture", DOCKER_AUTH_CONFIG = "fixture" } }
  expect_failures = [var.extra_environment]
}
run "rejects_mutable_api_image" {
  command = plan
  variables { den_api_image = "ghcr.io/different-ai/openwork-den-api:latest" }
  expect_failures = [var.den_api_image]
}
run "rejects_mutable_web_image" {
  command = plan
  variables { den_web_image = "ghcr.io/different-ai/openwork-den-web:latest" }
  expect_failures = [var.den_web_image]
}
run "rejects_unverified_tls" {
  command = plan
  variables { database = { tls_query = "sslaccept=accept" } }
  expect_failures = [var.database]
}
run "rejects_fragment_or_encoded_tls_parameter_bypass" {
  command = plan
  variables {
    create_database        = false
    database_url           = "mysql://app:fixture@db.example.com:3306/openwork_den#fragment?sslaccept=strict"
    migration_database_url = "mysql://migrator:fixture@db.example.com:3306/openwork_den?%73slaccept=accept&nested=?sslaccept=strict"
  }
  expect_failures = [var.database_url, var.migration_database_url]
}

run "rejects_bad_name" {
  command = plan
  variables { name = "OpenWork_Prod" }
  expect_failures = [var.name]
}
run "rejects_unverified_restricted_ingress" {
  command = plan
  variables { allowed_ingress_cidrs = ["203.0.113.0/24"] }
  expect_failures = [var.allowed_ingress_cidrs]
}

run "https_without_ingress_restrictions" {
  command = apply
  assert {
    condition     = azapi_resource.api.body.properties.configuration.ingress.external && !azapi_resource.api.body.properties.configuration.ingress.allowInsecure && azapi_resource.api.body.properties.configuration.ingress.targetPort == 8788 && !azapi_resource.web.body.properties.configuration.ingress.allowInsecure && length(azapi_resource.api.body.properties.configuration.ingress.ipSecurityRestrictions) == 0 && length(azapi_resource.web.body.properties.configuration.ingress.ipSecurityRestrictions) == 0
    error_message = "The supported empty default must keep both endpoints HTTPS-only without silently adding or removing requested CIDR rules."
  }
}
run "existing_subnets_private_database" {
  command = apply
  variables {
    infrastructure_subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apps"
    database_network = {
      subnet_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql"
      virtual_network_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet"
    }
  }
  assert {
    condition     = azurerm_container_app_environment.this[0].infrastructure_subnet_id == var.infrastructure_subnet_id && azurerm_mysql_flexible_server.this[0].delegated_subnet_id == var.database_network.subnet_id && azurerm_mysql_flexible_server.this[0].public_network_access == "Disabled" && length(azurerm_private_dns_zone.db) == 1 && length(azurerm_mysql_flexible_server_firewall_rule.azure_services) == 0
    error_message = "Existing private subnets must remain supported without a public database firewall."
  }
}
run "existing_private_dns_zone" {
  command = apply
  variables {
    database_network = {
      subnet_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql"
      create_private_dns_zone = false
      private_dns_zone_id     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/privateDnsZones/corp.private.mysql.database.azure.com"
    }
  }
  assert {
    condition     = length(azurerm_private_dns_zone.db) == 0 && azurerm_mysql_flexible_server.this[0].private_dns_zone_id == var.database_network.private_dns_zone_id
    error_message = "The supplied private DNS zone must be used without creating another."
  }
}
run "private_database_needs_vnet" {
  command = plan
  variables { database_network = { subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql" } }
  expect_failures = [azurerm_private_dns_zone_virtual_network_link.db]
}
run "private_database_needs_dns_id" {
  command = plan
  variables { database_network = { subnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/mysql", create_private_dns_zone = false } }
  expect_failures = [azurerm_mysql_flexible_server.this]
}
run "existing_environment" {
  command = apply
  variables {
    container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/platform/providers/Microsoft.App/managedEnvironments/shared"
    app_name_prefix              = "ow-"
  }
  assert {
    condition     = length(azurerm_container_app_environment.this) == 0 && length(azurerm_log_analytics_workspace.this) == 0 && azapi_resource.api.body.properties.managedEnvironmentId == var.container_app_environment_id && output.web_url == "https://ow-openwork-den-web.shared-env-9876.westeurope.azurecontainerapps.io" && azapi_resource.api.location == "westeurope" && azapi_resource.migration.location == "westeurope"
    error_message = "Existing environments and app name prefixes must remain supported."
  }
}
run "rejects_environment_name" {
  command = plan
  variables { container_app_environment_id = "shared" }
  expect_failures = [var.container_app_environment_id]
}
run "existing_database_and_distinct_migration_principal" {
  command = apply
  variables {
    create_database        = false
    database_url           = "mysql://app:fixture@db.example.com:3306/openwork_den?sslaccept=strict"
    migration_database_url = "mysql://migrator:fixture@db.example.com:3306/openwork_den?sslaccept=strict"
  }
  assert {
    condition     = length(azurerm_mysql_flexible_server.this) == 0 && output.database_fqdn == null && terraform_data.migration_release.input.target == "db.example.com:3306/openwork_den" && local.migration_database_url == var.migration_database_url
    error_message = "Existing database/DML and same-target DDL principals must stay supported without creating a server."
  }
}
run "rejects_migration_for_other_database" {
  command = plan
  variables {
    create_database        = false
    database_url           = "mysql://app:fixture@db.example.com:3306/openwork_den?sslaccept=strict"
    migration_database_url = "mysql://migrator:fixture@other.example.com:3306/openwork_den?sslaccept=strict"
  }
  expect_failures = [azapi_resource.migration]
}
run "existing_database_needs_url" {
  command = plan
  variables { create_database = false }
  expect_failures = [azapi_resource.api]
}
run "key_vault_extra_secrets" {
  command = apply
  variables {
    key_vault_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/openwork"
    extra_secrets         = { DEN_SSO_CLIENT_SECRET = "https://corp-vault.vault.azure.net/secrets/openwork-sso" }
  }
  assert {
    condition     = anytrue([for secret in azapi_resource.api.body.properties.configuration.secrets : lookup(secret, "keyVaultUrl", "") == "https://corp-vault.vault.azure.net/secrets/openwork-sso"]) && length(azapi_resource.api.identity[0].identity_ids) == 1
    error_message = "Existing Key Vault references and their supplied identity must remain supported without reading values."
  }
}
run "migration_only_gets_registry_identity" {
  command = apply
  variables {
    key_vault_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/vault"
    user_assigned_identity_ids = [
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/vault",
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/registry",
    ]
    registry = { server = "registry.example.com", identity = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/registry" }
  }
  assert {
    condition     = length(azapi_resource.migration.identity[0].identity_ids) == 1 && contains(azapi_resource.migration.identity[0].identity_ids, var.registry.identity) && !contains(azapi_resource.migration.identity[0].identity_ids, var.key_vault_identity_id)
    error_message = "Migration must receive only its registry-pull identity, never the Key Vault identity even if repeated in user_assigned_identity_ids."
  }
}
run "rejects_shared_registry_and_vault_identity" {
  command = plan
  variables {
    key_vault_identity_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/vault"
    registry              = { server = "registry.example.com", identity = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/vault" }
  }
  expect_failures = [var.registry]
}
run "dedicated_ddl_url_is_not_an_application_recovery_source" {
  command = plan
  override_data {
    target = data.azapi_resource.existing_migration
    values = { exists = false, output = { versions = null, database_url_mode = "dedicated" } }
  }
  assert {
    condition     = local.saved_migration_database_url_mode == "dedicated" && !contains(local.reusable_migration_secret_names, "database-url")
    error_message = "Persisted dedicated-credential provenance must exclude the migration URL from application recovery regardless of the current empty migration_database_url input."
  }
}
run "allows_reviewed_public_environment" {
  command = apply
  variables { extra_environment = { SENTRY_LOG_LEVEL = "warn", NODE_USE_ENV_PROXY = "1" } }
  assert {
    condition     = anytrue([for env in azapi_resource.api.body.properties.template.containers[0].env : env.name == "SENTRY_LOG_LEVEL" && lookup(env, "value", "") == "warn"])
    error_message = "Reviewed nonsecret tuning must remain available through extra_environment."
  }
}

run "extra_secrets_need_identity" {
  command = plan
  variables { extra_secrets = { DEN_SSO_CLIENT_SECRET = "https://corp-vault.vault.azure.net/secrets/openwork-sso" } }
  expect_failures = [var.extra_secrets]
}
run "email_configuration" {
  command = apply
  variables {
    smtp = { host = "smtp.azurecomm.net", username = "openwork", password = "fixture" }
  }
  assert {
    condition     = anytrue([for env in azapi_resource.api.body.properties.template.containers[0].env : env.name == "SMTP_PASS" && lookup(env, "secretRef", "") == "smtp-pass"]) && !contains([for env in azapi_resource.api.body.properties.template.containers[0].env : env.name], "RESEND_API_KEY")
    error_message = "SMTP credentials must use secret references; unconfigured Resend must not be an environment variable."
  }
}
run "custom_domains" {
  command = apply
  variables {
    domain_name               = "openwork.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com" && azurerm_container_app_custom_domain.api[0].certificate_binding_type == "SniEnabled"
    error_message = "Custom hostname/certificate inputs must remain supported."
  }
}
run "custom_domain_needs_certificate" {
  command = plan
  variables { domain_name = "openwork.example.com" }
  expect_failures = [azapi_resource.api]
}
run "independent_explicit_rotation_versions" {
  command = plan
  variables { secret_versions = { better_auth_secret_version = 2 } }
  assert {
    condition     = var.secret_versions.better_auth_secret_version == 2 && var.secret_versions.db_encryption_key_version == 1 && local.app_write_versions.api["properties.configuration.secrets"] == azapi_resource.api.sensitive_body_version["properties.configuration.secrets"]
    error_message = "Explicit auth rotation must not advance the database encryption-key version."
  }
}
