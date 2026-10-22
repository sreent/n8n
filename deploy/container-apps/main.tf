# The sreent/n8n fork on Azure Container Apps. README.md describes the module.

data "azurerm_resource_group" "n8n" {
  name = var.resource_group_name
}

# Azure needs names that are unique in all of Azure for the database and Redis.
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  queue    = var.mode == "queue"
  location = data.azurerm_resource_group.n8n.location
  suffix   = random_string.suffix.result

  # The n8n settings of the fork (deploy/settings.yaml), with the changes of var.settings.
  settings = merge(yamldecode(file("${path.module}/../settings.yaml")).settings, var.settings)

  n8n_image     = var.n8n_image != "" ? var.n8n_image : "ghcr.io/sreent/n8n:${var.image_tag}"
  runners_image = var.runners_image != "" ? var.runners_image : "ghcr.io/sreent/n8n-runners:${var.image_tag}"

  main_app = "${var.name}-main"
  # Apps of the environment call each other at this name, and the traffic stays in the environment.
  main_fqdn = "${local.main_app}.${azurerm_container_app_environment.n8n.default_domain}"

  # Container Apps limits the addresses of a whole app, not of a path. A Caddy container in front of
  # n8n applies the IP limits of webhooks and forms, with the rules of deploy/Caddyfile.
  limit_webhooks = !contains(var.webhook_allowed_ranges, "0.0.0.0/0")
  limit_forms    = !contains(var.form_allowed_ranges, "0.0.0.0/0")
  edge           = local.limit_webhooks || local.limit_forms
  limit_app      = !contains(var.allowed_ranges, "0.0.0.0/0")

  platform_env = merge(
    {
      DB_TYPE                = "postgresdb"
      DB_POSTGRESDB_HOST     = azurerm_postgresql_flexible_server.n8n.fqdn
      DB_POSTGRESDB_PORT     = "5432"
      DB_POSTGRESDB_DATABASE = azurerm_postgresql_flexible_server_database.n8n.name
      DB_POSTGRESDB_USER     = azurerm_postgresql_flexible_server.n8n.administrator_login
      # Azure asks for TLS, with a certificate that Node.js trusts.
      DB_POSTGRESDB_SSL_ENABLED = "true"
      N8N_HOST                  = var.domain
      N8N_PROTOCOL              = "https"
      N8N_PORT                  = "5678"
      # With the Caddy container, only Caddy reaches n8n.
      N8N_LISTEN_ADDRESS = local.edge ? "127.0.0.1" : "0.0.0.0"
      WEBHOOK_URL        = "https://${var.domain}/"
      # The ingress of Container Apps appends the address of the caller to X-Forwarded-For, and Caddy
      # is one more proxy.
      N8N_PROXY_HOPS = local.edge ? "2" : "1"
      # The task runners run in the same replica and reach the broker on the loopback address.
      N8N_RUNNERS_MODE                  = "external"
      N8N_RUNNERS_BROKER_LISTEN_ADDRESS = "127.0.0.1"
    },
    var.git_ca_certificate != "" ? { GIT_SSL_CAINFO = "/etc/n8n-secrets/git-ca" } : {},
    local.queue ? {
      EXECUTIONS_MODE       = "queue"
      QUEUE_BULL_REDIS_HOST = azurerm_managed_redis.n8n[0].hostname
      QUEUE_BULL_REDIS_PORT = tostring(azurerm_managed_redis.n8n[0].default_database[0].port)
      QUEUE_BULL_REDIS_TLS  = "true"
      # Only the leader of the main replicas runs the schedules and the polling triggers.
      N8N_MULTI_MAIN_SETUP_ENABLED         = "true"
      OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS = "true"
      QUEUE_HEALTH_CHECK_ACTIVE            = "true"
      # The default address of the health server of a worker is ::, which a replica without IPv6
      # never opens.
      N8N_WORKER_SERVER_ADDRESS = "0.0.0.0"
    } : {},
  )
  # var.settings can also replace a value of the platform. Container Apps takes no empty values, and
  # an empty n8n setting is the same as no setting.
  env = { for name, value in merge(local.settings, local.platform_env, var.settings) : name => value if value != "" }

  # The workers call the AI gateway on the main replicas. SSRF protection must let the name in.
  worker_env = merge(local.env, {
    N8N_AI_GATEWAY_BASE_URL    = "https://${local.main_fqdn}/ai-gateway"
    N8N_SSRF_ALLOWED_HOSTNAMES = join(",", compact(concat(split(",", lookup(local.env, "N8N_SSRF_ALLOWED_HOSTNAMES", "")), [local.main_fqdn])))
  })

  # The secrets of the apps: the name of the secret for each environment variable.
  extra_secret_names = { for name in nonsensitive(keys(var.extra_secrets)) : name => "extra-${lower(replace(name, "_", "-"))}" }
  secret_env = merge(
    {
      N8N_ENCRYPTION_KEY     = "encryption-key"
      N8N_RUNNERS_AUTH_TOKEN = "runners-token"
      DB_POSTGRESDB_PASSWORD = "db-password"
    },
    local.queue ? { QUEUE_BULL_REDIS_PASSWORD = "redis-key" } : {},
    local.extra_secret_names,
  )
  has_registry = nonsensitive(var.registry != null)

  caddyfile = <<-EOT
    {
    	admin off
    	auto_https off
    	persist_config off
    	servers {
    		# The ingress of Container Apps connects from the subnet of the environment.
    		trusted_proxies static ${azurerm_subnet.apps.address_prefixes[0]}
    		client_ip_headers X-Forwarded-For
    		trusted_proxies_strict
    	}
    }
    :8080 {
    	@webhook_blocked {
    		path /webhook/* /webhook-test/* /webhook-waiting/* /mcp/* /mcp-test/*
    		not client_ip ${join(" ", var.webhook_allowed_ranges)}
    	}
    	respond @webhook_blocked 403
    	@form_blocked {
    		path /form/* /form-test/* /form-waiting/*
    		not client_ip ${join(" ", var.form_allowed_ranges)}
    	}
    	respond @form_blocked 403

    	reverse_proxy 127.0.0.1:5678
    }
  EOT
}

resource "azurerm_log_analytics_workspace" "n8n" {
  name                = "${var.name}-logs"
  location            = local.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

resource "azurerm_container_app_environment" "n8n" {
  name                       = "${var.name}-env"
  location                   = local.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.n8n.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  tags                       = var.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}
