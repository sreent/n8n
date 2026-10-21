# Queue mode: Memorystore for Redis with AUTH and TLS. It holds the queue of the executions and the
# leader key of the main instances.

resource "google_redis_instance" "n8n" {
  count = local.queue ? 1 : 0

  project                 = var.project_id
  name                    = "${var.name}-redis"
  region                  = var.region
  tier                    = "BASIC"
  memory_size_gb          = var.redis_memory_gb
  redis_version           = "REDIS_7_2"
  authorized_network      = var.network
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  labels                  = var.labels

  lifecycle {
    precondition {
      condition     = var.network != "" && var.subnetwork != ""
      error_message = "Queue mode needs network and subnetwork: Cloud Run reaches Memorystore through Direct VPC egress."
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "redis_auth" {
  count     = local.queue ? 1 : 0
  project   = var.project_id
  secret_id = "${var.name}-redis-auth"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "redis_auth" {
  count       = local.queue ? 1 : 0
  secret      = google_secret_manager_secret.redis_auth[0].id
  secret_data = google_redis_instance.n8n[0].auth_string
}

resource "google_secret_manager_secret" "redis_ca" {
  count     = local.queue ? 1 : 0
  project   = var.project_id
  secret_id = "${var.name}-redis-ca"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "redis_ca" {
  count       = local.queue ? 1 : 0
  secret      = google_secret_manager_secret.redis_ca[0].id
  secret_data = join("\n", google_redis_instance.n8n[0].server_ca_certs[*].cert)
}
