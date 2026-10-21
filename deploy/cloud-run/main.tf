# The sreent/n8n fork on Google Cloud Run. README.md describes the module.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  queue = var.mode == "queue"

  # The n8n settings of the fork (deploy/settings.yaml), with the changes of var.settings.
  settings = merge(yamldecode(file("${path.module}/../settings.yaml")).settings, var.settings)

  registry      = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name}-ghcr"
  n8n_image     = var.n8n_image != "" ? var.n8n_image : "${local.registry}/sreent/n8n:${var.image_tag}"
  runners_image = var.runners_image != "" ? var.runners_image : "${local.registry}/sreent/n8n-runners:${var.image_tag}"

  # Cloud Armor rules stop only the addresses outside the ranges. A range for all addresses needs
  # no rule.
  limit_webhooks = !contains(var.webhook_allowed_ranges, "0.0.0.0/0")
  limit_forms    = !contains(var.form_allowed_ranges, "0.0.0.0/0")

  platform_env = merge(
    {
      DB_TYPE                = "postgresdb"
      DB_POSTGRESDB_HOST     = "/cloudsql/${google_sql_database_instance.n8n.connection_name}"
      DB_POSTGRESDB_DATABASE = google_sql_database.n8n.name
      DB_POSTGRESDB_USER     = google_sql_user.n8n.name
      N8N_HOST               = var.domain
      N8N_PROTOCOL           = "https"
      N8N_PORT               = "5678"
      N8N_LISTEN_ADDRESS     = "0.0.0.0"
      WEBHOOK_URL            = "https://${var.domain}/"
      # The load balancer appends the address of the caller and its own address to X-Forwarded-For.
      N8N_PROXY_HOPS = "2"
      # Cloud Run reserves the paths that end with z, such as /healthz.
      N8N_ENDPOINT_HEALTH = "health"
      # The task runners run in the same instance and reach the broker on the loopback address.
      N8N_RUNNERS_MODE                  = "external"
      N8N_RUNNERS_BROKER_LISTEN_ADDRESS = "127.0.0.1"
    },
    var.git_ca_certificate != "" ? { GIT_SSL_CAINFO = "/etc/n8n-git-ca/root.crt" } : {},
    local.queue ? {
      EXECUTIONS_MODE       = "queue"
      QUEUE_BULL_REDIS_HOST = google_redis_instance.n8n[0].host
      QUEUE_BULL_REDIS_PORT = tostring(google_redis_instance.n8n[0].port)
      QUEUE_BULL_REDIS_TLS  = "true"
      # Memorystore signs its TLS certificate with a certificate authority of its own.
      NODE_EXTRA_CA_CERTS = "/etc/n8n-redis-ca/ca.crt"
      # Only the leader of the main instances runs the schedules and the polling triggers.
      N8N_MULTI_MAIN_SETUP_ENABLED         = "true"
      OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS = "true"
      QUEUE_HEALTH_CHECK_ACTIVE            = "true"
      # The default address of the health server of a worker is ::, which an instance without IPv6
      # never opens.
      N8N_WORKER_SERVER_ADDRESS = "0.0.0.0"
      # The workers call the AI gateway on the main instances, through the load balancer.
      N8N_AI_GATEWAY_BASE_URL = "https://${var.domain}/ai-gateway"
    } : {},
  )
  # var.settings can also replace a value of the platform. Cloud Run takes no empty values, and an
  # empty n8n setting is the same as no setting.
  env = { for name, value in merge(local.settings, local.platform_env, var.settings) : name => value if value != "" }

  secret_env = merge(
    {
      N8N_ENCRYPTION_KEY     = local.encryption_key_secret
      N8N_RUNNERS_AUTH_TOKEN = google_secret_manager_secret.runners_token.id
      DB_POSTGRESDB_PASSWORD = google_secret_manager_secret.db_password.id
    },
    local.queue ? { QUEUE_BULL_REDIS_PASSWORD = google_secret_manager_secret.redis_auth[0].id } : {},
    var.extra_secrets,
  )
}

resource "google_project_service" "apis" {
  for_each = var.enable_apis ? toset(concat(
    ["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "compute.googleapis.com", "artifactregistry.googleapis.com"],
    local.queue ? ["redis.googleapis.com"] : [],
    var.dns_managed_zone != "" ? ["dns.googleapis.com"] : [],
  )) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# The identity of n8n. It reads its secrets and connects to Cloud SQL.
resource "google_service_account" "n8n" {
  project      = var.project_id
  account_id   = "${var.name}-run"
  display_name = "n8n on Cloud Run"
}

resource "google_project_iam_member" "cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.n8n.member
}

resource "google_secret_manager_secret_iam_member" "n8n" {
  for_each = merge(local.secret_env, var.git_ca_certificate != "" ? { GIT_CA = google_secret_manager_secret.git_ca[0].id } : {}, local.queue ? { REDIS_CA = google_secret_manager_secret.redis_ca[0].id } : {})

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.n8n.member
}
