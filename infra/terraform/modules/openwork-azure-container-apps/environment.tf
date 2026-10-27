locals {
  create_environment = var.container_app_environment_id == ""
  # /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.App/managedEnvironments/<name>
  existing_environment = local.create_environment ? null : {
    resource_group_name = split("/", var.container_app_environment_id)[4]
    name                = split("/", var.container_app_environment_id)[8]
  }

  environment_id             = local.create_environment ? azurerm_container_app_environment.this[0].id : var.container_app_environment_id
  environment_default_domain = local.create_environment ? azurerm_container_app_environment.this[0].default_domain : data.azurerm_container_app_environment.existing[0].default_domain
  environment_verification   = local.create_environment ? azurerm_container_app_environment.this[0].custom_domain_verification_id : data.azurerm_container_app_environment.existing[0].custom_domain_verification_id
  app_location               = local.create_environment ? local.location : data.azurerm_container_app_environment.existing[0].location

  create_log_workspace    = local.create_environment && var.create_log_analytics_workspace
  log_analytics_workspace = local.create_log_workspace ? azurerm_log_analytics_workspace.this[0].id : (var.log_analytics_workspace_id != "" ? var.log_analytics_workspace_id : null)
}

data "azurerm_container_app_environment" "existing" {
  count = local.create_environment ? 0 : 1

  name                = local.existing_environment.name
  resource_group_name = local.existing_environment.resource_group_name
}

resource "azurerm_log_analytics_workspace" "this" {
  count = local.create_log_workspace ? 1 : 0

  name                = "${var.name}-den-logs"
  resource_group_name = var.resource_group_name
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = var.tags
}

resource "azurerm_container_app_environment" "this" {
  count = local.create_environment ? 1 : 0

  name                           = "${var.name}-den"
  resource_group_name            = var.resource_group_name
  location                       = local.location
  log_analytics_workspace_id     = local.log_analytics_workspace
  logs_destination               = local.log_analytics_workspace != null ? "log-analytics" : null
  infrastructure_subnet_id       = var.infrastructure_subnet_id != "" ? var.infrastructure_subnet_id : null
  internal_load_balancer_enabled = var.internal_load_balancer_enabled ? true : null
  tags                           = var.tags

  # A workload-profiles environment: needs only a /27 subnet and runs the
  # apps on the serverless Consumption profile.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  lifecycle {
    precondition {
      condition     = !var.internal_load_balancer_enabled || var.infrastructure_subnet_id != ""
      error_message = "internal_load_balancer_enabled needs infrastructure_subnet_id."
    }
    # Azure adds the infrastructure resource group name after creation.
    ignore_changes = [infrastructure_resource_group_name]
  }
}
