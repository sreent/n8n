# A VNet for the environment, the database and the private endpoint of Redis. Peer it with the
# network of Forgejo or of your company to reach private hosts.

resource "azurerm_virtual_network" "n8n" {
  name                = "${var.name}-vnet"
  location            = local.location
  resource_group_name = var.resource_group_name
  address_space       = [var.address_space]
  tags                = var.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "apps"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.n8n.name
  address_prefixes     = [cidrsubnet(var.address_space, 7, 0)]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "database" {
  name                 = "database"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.n8n.name
  address_prefixes     = [cidrsubnet(var.address_space, 8, 2)]

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                 = "endpoints"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.n8n.name
  address_prefixes     = [cidrsubnet(var.address_space, 8, 3)]
}
