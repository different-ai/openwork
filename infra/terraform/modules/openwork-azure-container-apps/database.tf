# Azure Database for MySQL Flexible Server -----------------------------------

locals {
  # Counts depend only on whether the object is set, never on IDs that may be
  # unknown until apply (subnets created in the same configuration).
  database_private = var.create_database && var.database_network != null
  create_dns_zone  = local.database_private && try(var.database_network.create_private_dns_zone, false)
}

# Server names are global (<name>.mysql.database.azure.com).
resource "random_string" "db_suffix" {
  count = var.create_database ? 1 : 0

  length  = 6
  special = false
  upper   = false
}

resource "azurerm_private_dns_zone" "db" {
  count = local.create_dns_zone ? 1 : 0

  name                = "${var.name}-den.private.mysql.database.azure.com"
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "db" {
  count = local.create_dns_zone ? 1 : 0

  name                 = "${var.name}-den-db"
  private_dns_zone_id  = azurerm_private_dns_zone.db[0].id
  virtual_network_id   = var.database_network.virtual_network_id
  registration_enabled = false
  tags                 = var.tags

  lifecycle {
    precondition {
      condition     = var.database_network.virtual_network_id != ""
      error_message = "database_network.virtual_network_id is required to link the private DNS zone the module creates (or set create_private_dns_zone = false and pass private_dns_zone_id)."
    }
  }
}

resource "azurerm_mysql_flexible_server" "this" {
  count = var.create_database ? 1 : 0

  name                = "${var.name}-den-${random_string.db_suffix[0].result}"
  resource_group_name = var.resource_group_name
  location            = local.location
  version             = var.database.version
  sku_name            = var.database.sku_name
  zone                = var.database.zone
  administrator_login = "openwork"
  # Ephemeral input never enters plan/state. Later runs do not write it unless
  # the explicit password version changes (or the database is replaced).
  administrator_password_wo         = local.database_password
  administrator_password_wo_version = var.secret_versions.database_password_version
  backup_retention_days             = var.database.backup_retention_days
  tags                              = var.tags

  # Private access (VNet integration) is chosen at creation and cannot change.
  delegated_subnet_id   = local.database_private ? var.database_network.subnet_id : null
  private_dns_zone_id   = local.database_private ? (local.create_dns_zone ? azurerm_private_dns_zone.db[0].id : var.database_network.private_dns_zone_id) : null
  public_network_access = local.database_private ? "Disabled" : "Enabled"

  storage {
    size_gb           = var.database.storage_gb
    auto_grow_enabled = true
  }

  dynamic "high_availability" {
    for_each = var.database.high_availability != "" ? [1] : []
    content {
      mode = var.database.high_availability
    }
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.db]

  lifecycle {
    precondition {
      condition     = !data.azapi_resource.existing_database[0].exists || data.azapi_resource.existing_api.exists || (data.azapi_resource.existing_migration.exists && local.saved_migration_database_url_mode == "application") || var.database_password_recovery_acknowledged
      error_message = "A database exists but no cloud credential copy can be recovered. Stop and preserve/reset its password explicitly before acknowledging recovery; do not regenerate silently."
    }
    precondition {
      condition     = !local.database_private || local.create_dns_zone || try(var.database_network.private_dns_zone_id, "") != ""
      error_message = "database_network with create_private_dns_zone = false needs private_dns_zone_id."
    }
    # Azure moves the primary to the standby zone on failover.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_management_lock" "database" {
  count = var.create_database && var.deletion_protection ? 1 : 0

  name       = "${var.name}-database-protection"
  scope      = azurerm_mysql_flexible_server.this[0].id
  lock_level = "CanNotDelete"
  notes      = "Protects against out-of-band deletion. Terraform destroy can remove this Terraform-managed lock."
}

resource "azurerm_mysql_flexible_database" "this" {
  count = var.create_database ? 1 : 0

  name                = var.database.name
  resource_group_name = var.resource_group_name
  server_name         = azurerm_mysql_flexible_server.this[0].name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

# Public access only: allow Azure services (including Container Apps without a
# VNet). The 0.0.0.0 rule is Azure's "allow Azure services" switch, not the
# internet. Prefer database_network outside test stacks.
resource "azurerm_mysql_flexible_server_firewall_rule" "azure_services" {
  count = var.create_database && !local.database_private ? 1 : 0

  name                = "allow-azure-services"
  resource_group_name = var.resource_group_name
  server_name         = azurerm_mysql_flexible_server.this[0].name
  start_ip_address    = "0.0.0.0"
  end_ip_address      = "0.0.0.0"
}
