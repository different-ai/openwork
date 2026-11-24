# Fresh state makes terminal completion an apply-time check on both tools.
mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test", location = "eastus" }
  }
  mock_data "azurerm_container_app_environment" {
    defaults = { default_domain = "shared.eastus.azurecontainerapps.io", custom_domain_verification_id = "VERIFY", location = "eastus" }
  }
}
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
  mock_data "external" { defaults = { result = { status = "Failed" } } }
}
variables {
  resource_group_name          = "rg-test"
  owner_emails                 = ["admin@example.com"]
  create_database              = false
  database_url                 = "mysql://app:fixture@db.example.com:3306/openwork_den?sslaccept=strict"
  container_app_environment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/shared"
}
run "failed_completion_blocks_rollout" {
  command         = apply
  expect_failures = [data.external.migration_completion]
}
