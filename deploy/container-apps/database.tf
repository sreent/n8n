# Azure Database for PostgreSQL flexible server, in its own subnet, without public access.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                = "${var.name}-postgres"
  private_dns_zone_id = azurerm_private_dns_zone.postgres.id
  virtual_network_id  = azurerm_virtual_network.n8n.id
  tags                = var.tags
}

resource "azurerm_postgresql_flexible_server" "n8n" {
  name                          = "${var.name}-db-${local.suffix}"
  location                      = local.location
  resource_group_name           = var.resource_group_name
  version                       = var.database.version
  sku_name                      = var.database.sku_name
  storage_mb                    = var.database.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.database.backup_days
  delegated_subnet_id           = azurerm_subnet.database.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "n8n"
  administrator_password        = random_password.db.result
  tags                          = var.tags

  dynamic "high_availability" {
    for_each = var.database.zone_redundant ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  lifecycle {
    # Azure picks the zone. A later change of the zone would replace the server.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# The database holds all data of n8n. A lock stops its deletion until someone removes the lock.
resource "azurerm_management_lock" "database" {
  count      = var.database.deletion_protection ? 1 : 0
  name       = "${var.name}-db-lock"
  scope      = azurerm_postgresql_flexible_server.n8n.id
  lock_level = "CanNotDelete"
  notes      = "n8n keeps all its data in this database."
}

resource "azurerm_postgresql_flexible_server_database" "n8n" {
  name      = "n8n"
  server_id = azurerm_postgresql_flexible_server.n8n.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
