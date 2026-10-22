# Tests of the module with mock providers: no Azure subscription and no costs.
# Run them with `terraform init -backend=false && terraform test` in deploy/container-apps.

mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg"
      location = "westeurope"
    }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.OperationalInsights/workspaces/n8n-logs" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.Network/virtualNetworks/n8n-vnet" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.Network/virtualNetworks/n8n-vnet/subnets/apps" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.Network/privateDnsZones/n8n.private.postgres.database.azure.com" }
  }
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.App/managedEnvironments/n8n-env"
      default_domain    = "nicesky-1a2b3c4d.westeurope.azurecontainerapps.io"
      static_ip_address = "20.0.0.10"
    }
  }
  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/n8n-db-abc123"
      fqdn = "n8n-db-abc123.postgres.database.azure.com"
    }
  }
  mock_resource "azurerm_managed_redis" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.Cache/redisEnterprise/n8n-redis-abc123"
      hostname = "n8n-redis-abc123.westeurope.redis.azure.net"
      # The computed values of each default_database block.
      default_database = {
        port                 = 10000
        primary_access_key   = "redis-key"
        secondary_access_key = "redis-key-2"
      }
    }
  }
  mock_resource "azurerm_container_app" {
    defaults = {
      id                            = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/n8n-rg/providers/Microsoft.App/containerApps/n8n-main"
      custom_domain_verification_id = "verification-id"
    }
  }
}

mock_provider "random" {
  mock_resource "random_string" {
    defaults = { result = "abc123" }
  }
}

variables {
  resource_group_name = "n8n-rg"
  domain              = "n8n.example.com"
  image_tag           = "2.42.0-1a2b3c4d5e"
}

run "queue_mode_by_default" {
  command = apply

  assert {
    condition     = length(azurerm_container_app.worker) == 1 && length(azurerm_managed_redis.n8n) == 1
    error_message = "Queue mode makes a worker app and Azure Managed Redis."
  }
  assert {
    condition     = azurerm_container_app.main.template[0].min_replicas == 1 && azurerm_container_app.main.template[0].max_replicas == 1
    error_message = "One main replica by default."
  }
  assert {
    condition     = [for c in azurerm_container_app.main.template[0].container : c.name] == ["n8n", "runners"]
    error_message = "Without IP limits, the main app runs n8n and the task runners."
  }
  assert {
    condition = alltrue([for pair in [
      "EXECUTIONS_MODE=queue",
      "N8N_MULTI_MAIN_SETUP_ENABLED=true",
      "N8N_WORKER_SERVER_ADDRESS=0.0.0.0",
      "QUEUE_BULL_REDIS_HOST=n8n-redis-abc123.westeurope.redis.azure.net",
      "QUEUE_BULL_REDIS_PORT=10000",
      "QUEUE_BULL_REDIS_TLS=true",
      "DB_POSTGRESDB_HOST=n8n-db-abc123.postgres.database.azure.com",
      "DB_POSTGRESDB_SSL_ENABLED=true",
      "N8N_LISTEN_ADDRESS=0.0.0.0",
      "N8N_PROXY_HOPS=1",
      "N8N_OPEN_TRIGGERS_NEED_APPROVAL=true",
    ] : contains([for e in azurerm_container_app.main.template[0].container[0].env : "${e.name}=${e.value}" if e.value != null], pair)])
    error_message = "The main app has the settings of the fork and of queue mode."
  }
  assert {
    condition = alltrue([for pair in [
      "N8N_AI_GATEWAY_BASE_URL=https://n8n-main.nicesky-1a2b3c4d.westeurope.azurecontainerapps.io/ai-gateway",
      "N8N_SSRF_ALLOWED_HOSTNAMES=n8n-main.nicesky-1a2b3c4d.westeurope.azurecontainerapps.io",
    ] : contains([for e in azurerm_container_app.worker[0].template[0].container[0].env : "${e.name}=${e.value}" if e.value != null], pair)])
    error_message = "The workers call the AI gateway on the main app."
  }
  assert {
    condition     = join(" ", azurerm_container_app.worker[0].template[0].container[0].args) == "worker --concurrency=10"
    error_message = "The workers start with n8n worker."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.main.template[0].container[0].env : "${e.name}=${e.secret_name}" if e.secret_name != null], "N8N_ENCRYPTION_KEY=encryption-key")
    error_message = "The encryption key comes from a secret of the app."
  }
  assert {
    condition     = azurerm_container_app.main.ingress[0].target_port == 5678 && length(azurerm_container_app.main.ingress[0].ip_security_restriction) == 0
    error_message = "Without limits, the ingress goes to n8n for all addresses."
  }
}

run "single_mode" {
  command = apply

  variables {
    mode = "single"
  }

  assert {
    condition     = length(azurerm_container_app.worker) == 0 && length(azurerm_managed_redis.n8n) == 0
    error_message = "Mode single has no workers and no Redis."
  }
  assert {
    condition     = !contains([for e in azurerm_container_app.main.template[0].container[0].env : e.name], "EXECUTIONS_MODE")
    error_message = "Mode single runs the executions in the main app."
  }
}

run "ip_limits" {
  command = apply

  variables {
    allowed_ranges         = ["203.0.113.0/24", "198.51.100.0/24"]
    webhook_allowed_ranges = ["10.0.0.0/8"]
  }

  assert {
    condition     = [for c in azurerm_container_app.main.template[0].container : c.name] == ["n8n", "runners", "edge"]
    error_message = "A Caddy container applies the IP limits of webhooks and forms."
  }
  assert {
    condition     = azurerm_container_app.main.ingress[0].target_port == 8080 && azurerm_container_app.main.template[0].container[0].readiness_probe[0].port == 8080
    error_message = "The ingress and the probes go through Caddy."
  }
  assert {
    condition = alltrue([for pair in ["N8N_LISTEN_ADDRESS=127.0.0.1", "N8N_PROXY_HOPS=2"] :
    contains([for e in azurerm_container_app.main.template[0].container[0].env : "${e.name}=${e.value}" if e.value != null], pair)])
    error_message = "Only Caddy reaches n8n."
  }
  assert {
    condition     = strcontains(one([for e in azurerm_container_app.main.template[0].container[2].env : e.value if e.name == "CADDYFILE"]), "not client_ip 10.0.0.0/8") && strcontains(one([for e in azurerm_container_app.main.template[0].container[2].env : e.value if e.name == "CADDYFILE"]), "trusted_proxies static 10.40.0.0/23")
    error_message = "Caddy limits the webhooks and trusts the subnet of the environment."
  }
  assert {
    condition     = [for r in azurerm_container_app.main.ingress[0].ip_security_restriction : r.ip_address_range] == ["203.0.113.0/24", "198.51.100.0/24"]
    error_message = "The ingress lets only the allowed ranges in."
  }
}

run "registry_git_ca_and_extra_secrets" {
  command = apply

  variables {
    registry           = { server = "ghcr.io", username = "n8n-bot", password = "token" }
    git_ca_certificate = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
    extra_secrets      = { N8N_SSO_OIDC_CLIENT_SECRET = "oidc-secret" }
  }

  assert {
    condition     = azurerm_container_app.main.registry[0].server == "ghcr.io" && azurerm_container_app.main.registry[0].password_secret_name == "registry-password"
    error_message = "The apps pull with the credentials of the registry."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.main.template[0].container[0].env : "${e.name}=${e.value}" if e.value != null], "GIT_SSL_CAINFO=/etc/n8n-secrets/git-ca") && azurerm_container_app.main.template[0].volume[0].storage_type == "Secret"
    error_message = "Git reads the certificate from the secrets volume."
  }
  assert {
    condition     = contains([for e in azurerm_container_app.main.template[0].container[0].env : "${e.name}=${e.secret_name}" if e.secret_name != null], "N8N_SSO_OIDC_CLIENT_SECRET=extra-n8n-sso-oidc-client-secret")
    error_message = "An extra secret becomes a secret of the app."
  }
}

run "existing_encryption_key" {
  command   = apply
  state_key = "existing_key"

  variables {
    encryption_key = "the-key-of-the-vm"
  }

  assert {
    condition     = length(random_password.encryption_key) == 0
    error_message = "An existing key needs no new key."
  }
  assert {
    condition     = nonsensitive(output.encryption_key == "the-key-of-the-vm")
    error_message = "n8n uses the existing key."
  }
}
