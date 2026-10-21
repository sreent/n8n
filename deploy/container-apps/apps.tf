# The main app and, in queue mode, the worker app. Each replica runs n8n with the task runners next
# to it. The main app can also run the Caddy container of the IP limits.

resource "random_password" "encryption_key" {
  count   = var.encryption_key == "" ? 1 : 0
  length  = 48
  special = false
  # n8n encrypts the credentials with this key. Without it, a backup cannot be restored.
  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "runners_token" {
  length  = 48
  special = false
}

locals {
  # The values of the secrets of the apps, by name. Terraform keeps them in its state: keep the
  # state in a private storage account.
  secret_values = merge(
    {
      "encryption-key" = var.encryption_key != "" ? var.encryption_key : random_password.encryption_key[0].result
      "runners-token"  = random_password.runners_token.result
      "db-password"    = random_password.db.result
    },
    local.queue ? { "redis-key" = azurerm_managed_redis.n8n[0].default_database[0].primary_access_key } : {},
    local.has_registry ? { "registry-password" = var.registry.password } : {},
    var.git_ca_certificate != "" ? { "git-ca" = var.git_ca_certificate } : {},
    { for name, secret in local.extra_secret_names : secret => var.extra_secrets[name] },
  )
  secret_names = nonsensitive(toset(keys(local.secret_values)))

  # The probes go through Caddy when it runs, because n8n then listens only on the loopback address.
  main_probe_port = local.edge ? 8080 : 5678
}

resource "azurerm_container_app" "main" {
  name                         = local.main_app
  container_app_environment_id = azurerm_container_app_environment.n8n.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = var.tags

  dynamic "secret" {
    for_each = local.secret_names
    content {
      name  = secret.value
      value = local.secret_values[secret.value]
    }
  }

  dynamic "registry" {
    for_each = local.has_registry ? [1] : []
    content {
      server               = var.registry.server
      username             = var.registry.username
      password_secret_name = "registry-password"
    }
  }

  ingress {
    external_enabled           = true
    target_port                = local.main_probe_port
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    dynamic "ip_security_restriction" {
      for_each = local.limit_app ? var.allowed_ranges : []
      content {
        name             = "allow-${ip_security_restriction.key}"
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
      }
    }
  }

  template {
    min_replicas = local.queue ? var.main_replicas : 1
    max_replicas = local.queue ? var.main_replicas : 1
    # n8n stops within 30 seconds (N8N_GRACEFUL_SHUTDOWN_TIMEOUT) and lets running executions finish.
    termination_grace_period_seconds = 60

    container {
      name   = "n8n"
      image  = local.n8n_image
      cpu    = var.n8n_resources.cpu
      memory = var.n8n_resources.memory

      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      # The first start runs the migrations of the database.
      startup_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = local.main_probe_port
        interval_seconds        = 10
        failure_count_threshold = 30
      }
      readiness_probe {
        transport        = "HTTP"
        path             = "/healthz/readiness"
        port             = local.main_probe_port
        interval_seconds = 10
      }
      liveness_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = local.main_probe_port
        interval_seconds        = 30
        failure_count_threshold = 3
      }

      dynamic "volume_mounts" {
        for_each = var.git_ca_certificate != "" ? [1] : []
        content {
          name = "secrets"
          path = "/etc/n8n-secrets"
        }
      }
    }

    container {
      name   = "runners"
      image  = local.runners_image
      cpu    = var.runners_resources.cpu
      memory = var.runners_resources.memory

      env {
        name  = "N8N_RUNNERS_TASK_BROKER_URI"
        value = "http://127.0.0.1:5679"
      }
      env {
        name        = "N8N_RUNNERS_AUTH_TOKEN"
        secret_name = "runners-token"
      }
      env {
        name  = "GENERIC_TIMEZONE"
        value = local.settings["GENERIC_TIMEZONE"]
      }
      # A runner without work for 15 seconds stops. The launcher starts it again for the next task.
      env {
        name  = "N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT"
        value = "15"
      }
    }

    dynamic "container" {
      for_each = local.edge ? [1] : []
      content {
        name    = "edge"
        image   = "docker.io/library/caddy:2-alpine"
        cpu     = 0.25
        memory  = "0.5Gi"
        command = ["sh", "-c", "printf '%s' \"$CADDYFILE\" > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile"]

        env {
          name  = "CADDYFILE"
          value = local.caddyfile
        }
      }
    }

    # Container Apps mounts the secrets of the app as files: Git reads the root certificate of
    # Forgejo from /etc/n8n-secrets/git-ca.
    dynamic "volume" {
      for_each = var.git_ca_certificate != "" ? [1] : []
      content {
        name         = "secrets"
        storage_type = "Secret"
      }
    }
  }
}

resource "azurerm_container_app" "worker" {
  count = local.queue ? 1 : 0

  name                         = "${var.name}-worker"
  container_app_environment_id = azurerm_container_app_environment.n8n.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = var.tags

  dynamic "secret" {
    for_each = local.secret_names
    content {
      name  = secret.value
      value = local.secret_values[secret.value]
    }
  }

  dynamic "registry" {
    for_each = local.has_registry ? [1] : []
    content {
      server               = var.registry.server
      username             = var.registry.username
      password_secret_name = "registry-password"
    }
  }

  template {
    min_replicas                     = var.worker_replicas
    max_replicas                     = var.worker_replicas
    termination_grace_period_seconds = 60

    container {
      name   = "n8n"
      image  = local.n8n_image
      args   = ["worker", "--concurrency=${var.worker_concurrency}"]
      cpu    = var.n8n_resources.cpu
      memory = var.n8n_resources.memory

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      # QUEUE_HEALTH_CHECK_ACTIVE starts the health server of the worker on port 5678.
      startup_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 5678
        interval_seconds        = 10
        failure_count_threshold = 30
      }
      liveness_probe {
        transport               = "HTTP"
        path                    = "/healthz"
        port                    = 5678
        interval_seconds        = 30
        failure_count_threshold = 3
      }

      dynamic "volume_mounts" {
        for_each = var.git_ca_certificate != "" ? [1] : []
        content {
          name = "secrets"
          path = "/etc/n8n-secrets"
        }
      }
    }

    container {
      name   = "runners"
      image  = local.runners_image
      cpu    = var.runners_resources.cpu
      memory = var.runners_resources.memory

      env {
        name  = "N8N_RUNNERS_TASK_BROKER_URI"
        value = "http://127.0.0.1:5679"
      }
      env {
        name        = "N8N_RUNNERS_AUTH_TOKEN"
        secret_name = "runners-token"
      }
      env {
        name  = "GENERIC_TIMEZONE"
        value = local.settings["GENERIC_TIMEZONE"]
      }
      env {
        name  = "N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT"
        value = "15"
      }
    }

    dynamic "volume" {
      for_each = var.git_ca_certificate != "" ? [1] : []
      content {
        name         = "secrets"
        storage_type = "Secret"
      }
    }
  }
}
