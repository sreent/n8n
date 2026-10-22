# The sreent/n8n fork on Amazon ECS with Fargate. README.md describes the module.

data "aws_region" "current" {}

locals {
  queue = var.mode == "queue"

  # The n8n settings of the fork (deploy/settings.yaml), with the changes of var.settings.
  settings = merge(yamldecode(file("${path.module}/../settings.yaml")).settings, var.settings)

  n8n_image     = var.n8n_image != "" ? var.n8n_image : "ghcr.io/sreent/n8n:${var.image_tag}"
  runners_image = var.runners_image != "" ? var.runners_image : "ghcr.io/sreent/n8n-runners:${var.image_tag}"

  # In queue mode, the workers reach the main tasks at this name of Cloud Map.
  main_host = "main.${var.name}.internal"

  # WAF rules stop only the addresses outside the ranges. A range for all addresses needs no rule.
  limit_webhooks = !contains(var.webhook_allowed_ranges, "0.0.0.0/0")
  limit_forms    = !contains(var.form_allowed_ranges, "0.0.0.0/0")

  platform_env = merge(
    {
      DB_TYPE                = "postgresdb"
      DB_POSTGRESDB_HOST     = aws_db_instance.n8n.address
      DB_POSTGRESDB_PORT     = tostring(aws_db_instance.n8n.port)
      DB_POSTGRESDB_DATABASE = "n8n"
      DB_POSTGRESDB_USER     = aws_db_instance.n8n.username
      # RDS asks for TLS. Without the certificates of RDS, n8n encrypts the connection but does not
      # check the certificate.
      DB_POSTGRESDB_SSL_ENABLED             = "true"
      DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED = var.database_ca_certificate != "" ? "true" : "false"
      DB_POSTGRESDB_SSL_CA                  = var.database_ca_certificate
      N8N_HOST                              = var.domain
      N8N_PROTOCOL                          = "https"
      N8N_PORT                              = "5678"
      N8N_LISTEN_ADDRESS                    = "0.0.0.0"
      WEBHOOK_URL                           = "https://${var.domain}/"
      # The load balancer appends the address of the caller to X-Forwarded-For.
      N8N_PROXY_HOPS = "1"
      # The task runners run in the same task and reach the broker on the loopback address.
      N8N_RUNNERS_MODE                  = "external"
      N8N_RUNNERS_BROKER_LISTEN_ADDRESS = "127.0.0.1"
    },
    var.git_ca_certificate != "" ? { GIT_SSL_CAINFO = "/files/git-ca.crt" } : {},
    local.queue ? {
      EXECUTIONS_MODE       = "queue"
      QUEUE_BULL_REDIS_HOST = aws_elasticache_replication_group.n8n[0].primary_endpoint_address
      QUEUE_BULL_REDIS_PORT = "6379"
      QUEUE_BULL_REDIS_TLS  = "true"
      # Only the leader of the main tasks runs the schedules and the polling triggers.
      N8N_MULTI_MAIN_SETUP_ENABLED         = "true"
      OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS = "true"
      QUEUE_HEALTH_CHECK_ACTIVE            = "true"
      # The default address of the health server of a worker is ::, which a task without IPv6
      # never opens.
      N8N_WORKER_SERVER_ADDRESS = "0.0.0.0"
      # The workers call the AI gateway on the main tasks. SSRF protection must let the name in.
      N8N_AI_GATEWAY_BASE_URL    = "http://${local.main_host}:5678/ai-gateway"
      N8N_SSRF_ALLOWED_HOSTNAMES = join(",", compact(concat(split(",", local.settings["N8N_SSRF_ALLOWED_HOSTNAMES"]), [local.main_host])))
    } : {},
  )
  # var.settings can also replace a value of the platform, but not the list of allowed hosts, which
  # already holds its hosts.
  env = { for name, value in merge(
    local.settings,
    local.platform_env,
    { for name, value in var.settings : name => value if name != "N8N_SSRF_ALLOWED_HOSTNAMES" },
  ) : name => value if value != "" }

  secrets = merge(
    {
      N8N_ENCRYPTION_KEY     = local.encryption_key_secret_arn
      N8N_RUNNERS_AUTH_TOKEN = aws_secretsmanager_secret.runners_token.arn
      # RDS keeps the password of the database in a secret of its own, as JSON.
      DB_POSTGRESDB_PASSWORD = "${aws_db_instance.n8n.master_user_secret[0].secret_arn}:password::"
    },
    local.queue ? { QUEUE_BULL_REDIS_PASSWORD = aws_secretsmanager_secret.redis_auth[0].arn } : {},
    var.extra_secrets,
  )

  repository_credentials = var.registry_credentials_secret_arn != "" ? { repositoryCredentials = { credentialsParameter = var.registry_credentials_secret_arn } } : {}

  log_options = {
    awslogs-group  = aws_cloudwatch_log_group.n8n.name
    awslogs-region = data.aws_region.current.region
  }

  # n8n is healthy when it answers on its health path. The image has Node.js, not curl.
  health_check = {
    command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:5678/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))\""]
    interval    = 30
    timeout     = 5
    retries     = 3
    startPeriod = 300
  }

  # Git needs the root certificate of Forgejo as a file. A short container writes it to a volume
  # of the task before n8n starts.
  files_container = var.git_ca_certificate != "" ? [merge(local.repository_credentials, {
    name        = "files"
    image       = local.n8n_image
    essential   = false
    user        = "0"
    entryPoint  = ["sh", "-c"]
    command     = ["printf '%s' \"$GIT_CA_CERTIFICATE\" > /files/git-ca.crt"]
    environment = [{ name = "GIT_CA_CERTIFICATE", value = var.git_ca_certificate }]
    mountPoints = [{ sourceVolume = "files", containerPath = "/files", readOnly = false }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = merge(local.log_options, { awslogs-stream-prefix = "files" })
    }
  })] : []

  n8n_container = merge(local.repository_credentials, {
    name         = "n8n"
    image        = local.n8n_image
    essential    = true
    environment  = [for name in sort(keys(local.env)) : { name = name, value = local.env[name] }]
    secrets      = [for name in sort(keys(local.secrets)) : { name = name, valueFrom = local.secrets[name] }]
    portMappings = [{ containerPort = 5678, protocol = "tcp" }]
    healthCheck  = local.health_check
    # n8n stops within 30 seconds (N8N_GRACEFUL_SHUTDOWN_TIMEOUT) and lets running executions finish.
    stopTimeout = 120
    mountPoints = var.git_ca_certificate != "" ? [{ sourceVolume = "files", containerPath = "/files", readOnly = true }] : []
    dependsOn   = var.git_ca_certificate != "" ? [{ containerName = "files", condition = "SUCCESS" }] : []
    logConfiguration = {
      logDriver = "awslogs"
      options   = merge(local.log_options, { awslogs-stream-prefix = "n8n" })
    }
  })

  runners_container = merge(local.repository_credentials, {
    name      = "runners"
    image     = local.runners_image
    essential = true
    environment = [
      { name = "N8N_RUNNERS_TASK_BROKER_URI", value = "http://127.0.0.1:5679" },
      { name = "GENERIC_TIMEZONE", value = local.settings["GENERIC_TIMEZONE"] },
      # A runner without work for 15 seconds stops. The launcher starts it again for the next task.
      { name = "N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT", value = "15" },
    ]
    secrets   = [{ name = "N8N_RUNNERS_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.runners_token.arn }]
    dependsOn = [{ containerName = "n8n", condition = "START" }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = merge(local.log_options, { awslogs-stream-prefix = "runners" })
    }
  })
}

resource "aws_cloudwatch_log_group" "n8n" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}
