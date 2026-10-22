# Queue mode: Azure Managed Redis with TLS and an access key, through a private endpoint. It holds
# the queue of the executions and the leader key of the main replicas.

resource "azurerm_managed_redis" "n8n" {
  count = local.queue ? 1 : 0

  name                  = "${var.name}-redis-${local.suffix}"
  location              = local.location
  resource_group_name   = var.resource_group_name
  sku_name              = var.redis_sku
  public_network_access = "Disabled"
  tags                  = var.tags

  default_database {
    access_keys_authentication_enabled = true
    client_protocol                    = "Encrypted"
    # The queue of n8n needs all its keys on one shard.
    clustering_policy = "EnterpriseCluster"
    eviction_policy   = "NoEviction"
  }
}

resource "azurerm_private_dns_zone" "redis" {
  count               = local.queue ? 1 : 0
  name                = "privatelink.redis.azure.net"
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "redis" {
  count               = local.queue ? 1 : 0
  name                = "${var.name}-redis"
  private_dns_zone_id = azurerm_private_dns_zone.redis[0].id
  virtual_network_id  = azurerm_virtual_network.n8n.id
  tags                = var.tags
}

resource "azurerm_private_endpoint" "redis" {
  count               = local.queue ? 1 : 0
  name                = "${var.name}-redis"
  location            = local.location
  resource_group_name = var.resource_group_name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = var.tags

  private_service_connection {
    name                           = "${var.name}-redis"
    private_connection_resource_id = azurerm_managed_redis.n8n[0].id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.redis[0].id]
  }
}
