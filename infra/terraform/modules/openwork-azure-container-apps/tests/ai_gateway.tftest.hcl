# OFFLINE. All Azure/external calls mocked; ephemeral random is local-only.
# Mock applies seed synthetic off/on state, then Gateway plan checks. No provisioning.
mock_provider "azurerm" {
  mock_data "azurerm_resource_group" { defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test", location = "eastus" } }
  mock_resource "azurerm_container_app_environment" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den", default_domain = "happy-sky-1234.eastus.azurecontainerapps.io", custom_domain_verification_id = "VERIFY123" }
  }
  mock_resource "azurerm_log_analytics_workspace" { defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.OperationalInsights/workspaces/openwork-den-logs" } }
  mock_resource "azurerm_mysql_flexible_server" { defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.DBforMySQL/flexibleServers/openwork", fqdn = "openwork-den.mysql.database.azure.com" } }
  mock_resource "azurerm_container_app_environment_certificate" { defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/openwork-den/certificates/openwork-den" } }
}
# Required ephemeral schema; synthetic binding has use_cli=false, and absent
# existing-store mocks ensure the real secret-read provider is never called.
provider "azapi" {
  alias           = "secret_read"
  subscription_id = "00000000-0000-0000-0000-000000000000"
  tenant_id       = "00000000-0000-0000-0000-000000000000"
  client_id       = "00000000-0000-0000-0000-000000000000"
  client_secret   = "fixture-not-used"
  use_cli         = false
}
mock_provider "azapi" {
  mock_data "azapi_resource" { defaults = { exists = false, output = { versions = null } } }
  mock_resource "azapi_resource" { defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/app", output = { properties = { outboundIpAddresses = [] } } } }
  mock_resource "azapi_resource_action" { defaults = { output = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/jobs/openwork-migrate/executions/test" } } }
}
override_resource {
  target = azapi_resource.ai_gateway
  values = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/containerApps/ai-gateway-distinct" }
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
  ai_gateway_image    = "ghcr.io/different-ai/openwork-inference@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
run "off_by_default" {
  command = apply # Mock state only; no cloud resources or Job execution.
  assert {
    condition     = length(azapi_resource.ai_gateway) == 0 && length(azurerm_container_app_custom_domain.ai_gateway) == 0 && output.ai_gateway_url == null && length([for env in azapi_resource.api.body.properties.template.containers[0].env : env.name if startswith(env.name, "GATEWAY_") || startswith(env.name, "INFERENCE_")]) == 0 && length(keys(local.app_specs)) == 2
    error_message = "Default: 0 AI Gateway apps/bindings, null URL, unchanged Den env; only two apps."
  }
}
run "enable_plan" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  assert {
    condition     = length(azapi_resource.ai_gateway) == 1 && azapi_resource.ai_gateway[0].body.properties.template.containers[0].image == var.ai_gateway_image && azapi_resource.ai_gateway[0].body.properties.configuration.ingress.targetPort == 8791 && azapi_resource.ai_gateway[0].body.properties.configuration.ingress.external && !azapi_resource.ai_gateway[0].body.properties.configuration.ingress.allowInsecure && azapi_resource.ai_gateway[0].body.properties.template.containers[0].probes[0].httpGet.path == "/health" && azapi_resource.ai_gateway[0].body.properties.template.containers[0].probes[1].httpGet.path == "/ready"
    error_message = "Enabled: 0 -> 1 inference app, HTTPS-only ingress to 8791, health/readiness probes."
  }
  assert {
    condition     = output.ai_gateway_url == "https://models.example.com" && azurerm_container_app_custom_domain.ai_gateway[0].name == "models.example.com" && azurerm_container_app_custom_domain.ai_gateway[0].certificate_binding_type == "SniEnabled" && output.ai_gateway_dns_records.cname == "openwork-ai-gateway.happy-sky-1234.eastus.azurecontainerapps.io"
    error_message = "Dedicated SNI hostname and DNS target expose the HTTPS origin to desktops."
  }
  assert {
    condition = alltrue([for c in [azapi_resource.api.body.properties.template.containers[0], azapi_resource.ai_gateway[0].body.properties.template.containers[0]] : alltrue([for k, v in {
      GATEWAY_ENABLED = "true", GATEWAY_PROXY_BASE_URL = "https://openwork-ai-gateway.happy-sky-1234.eastus.azurecontainerapps.io", GATEWAY_PUBLIC_BASE_URL = "https://models.example.com", INFERENCE_PROXY_BASE_URL = "https://models.example.com", DB_MODE = "mysql", NODE_ENV = "production"
    } : anytrue([for e in c.env : e.name == k && try(e.value == v, false)])]) && alltrue([for name in ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY"] : anytrue([for e in c.env : e.name == name && try(e.secretRef == lower(replace(name, "_", "-")), false)])])])
    error_message = "Den and Gateway share canonical env and database/encryption secretRefs; internal proxy differs from desktop origin."
  }
  assert {
    condition     = toset([for s in azapi_resource.ai_gateway[0].body.properties.configuration.secrets : s.name]) == toset(["database-url", "den-db-encryption-key"]) && alltrue([for s in azapi_resource.ai_gateway[0].body.properties.configuration.secrets : !contains(keys(s), "value")]) && length(azapi_resource.ai_gateway[0].sensitive_body_version) == 1 && var.secret_versions.db_encryption_key_version == 1 && var.secret_versions.database_password_version == 1 && length(azapi_resource.ai_gateway[0].body.properties.template.initContainers) == 0
    error_message = "Only existing database/encryption values enter the write-only payload; state holds metadata, version counters stay 1, replicas never migrate."
  }
}
run "den_custom_domains_coexist" {
  command = plan
  variables {
    domain_name               = "openwork.example.com"
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  assert {
    condition     = length(keys(local.app_specs)) == 3 && azurerm_container_app_custom_domain.web[0].name != azurerm_container_app_custom_domain.ai_gateway[0].name && azurerm_container_app_custom_domain.api[0].name != azurerm_container_app_custom_domain.ai_gateway[0].name && length(azurerm_container_app_environment_certificate.this) == 1
    error_message = "Three separate Den/AI apps and hostnames reuse the supplied covering certificate; no den-gateway service is implied."
  }
}
run "missing_domain" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  expect_failures = [var.ai_gateway_domain_name]
}
run "missing_certificate" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  expect_failures = [azapi_resource.ai_gateway]
}
run "conflicting_environment" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
    extra_environment         = { GATEWAY_ENABLED = "false" }
  }
  expect_failures = [var.extra_environment]
}
run "conflicting_host" {
  command = plan
  variables {
    domain_name               = "openwork.example.com"
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "openwork.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  expect_failures = [azapi_resource.ai_gateway]
}
run "mutable_image" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    ai_gateway_image          = "ghcr.io/different-ai/openwork-inference:latest"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  expect_failures = [var.ai_gateway_image]
}
run "enabled_mock_state" {
  command = apply # Mock-only state, no ARM or migration execution.
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  assert {
    condition     = length(azapi_resource.ai_gateway) == 1 && var.secret_versions.db_encryption_key_version == 1 && azurerm_container_app_custom_domain.ai_gateway[0].container_app_id == azapi_resource.ai_gateway[0].id && azurerm_container_app_custom_domain.ai_gateway[0].container_app_id != azapi_resource.api.id
    error_message = "Synthetic state binds the public domain to the distinct Gateway app, not Den; encryption counter remains 1."
  }
}
run "unchanged_enabled_plan" {
  command = plan
  variables {
    ai_gateway_enabled        = true
    ai_gateway_domain_name    = "models.example.com"
    custom_domain_certificate = { pfx_base64 = "UEZYLXRlc3Q=", password = "fixture" }
  }
  assert {
    condition     = azapi_resource.ai_gateway[0].sensitive_body_version["properties.configuration.secrets"] == local.app_write_versions.ai_gateway["properties.configuration.secrets"] && var.secret_versions.db_encryption_key_version == 1 && var.secret_versions.database_password_version == 1
    error_message = "Unchanged deployment hashes/write-only gates and rotation counters preserve existing secret values."
  }
}
run "disable_plan_keeps_data" {
  command = plan
  assert {
    condition     = length(azapi_resource.ai_gateway) == 0 && output.ai_gateway_url == null && length(azurerm_mysql_flexible_server.this) == 1 && length(local.secret_env_names) == 4 && var.secret_versions.db_encryption_key_version == 1 && !contains(keys(local.environment), "GATEWAY_ENABLED")
    error_message = "Disable: Gateway 1 -> 0, runtime defaults false, database and original secret/version metadata kept."
  }
}
