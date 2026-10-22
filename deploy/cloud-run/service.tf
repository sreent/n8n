# The main instances (a Cloud Run service) and, in queue mode, the workers (a worker pool). Each
# instance runs n8n with the task runners next to it.

locals {
  runners_env = {
    N8N_RUNNERS_TASK_BROKER_URI = "http://127.0.0.1:5679"
    GENERIC_TIMEZONE            = local.settings["GENERIC_TIMEZONE"]
    # A runner without work for 15 seconds stops. The launcher starts it again for the next task.
    N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT = "15"
  }

  secret_files = merge(
    var.git_ca_certificate != "" ? { git-ca = { secret = google_secret_manager_secret.git_ca[0].id, path = "/etc/n8n-git-ca", file = "root.crt" } } : {},
    local.redis_ca ? { redis-ca = { secret = google_secret_manager_secret.redis_ca[0].id, path = "/etc/n8n-redis-ca", file = "ca.crt" } } : {},
  )
}

resource "google_cloud_run_v2_service" "main" {
  project  = var.project_id
  name     = "${var.name}-main"
  location = var.region
  labels   = var.labels
  # The load balancer is the only way in. It does not sign in to Cloud Run, so Cloud Run lets
  # each caller in, and n8n checks the users.
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true
  default_uri_disabled = true
  deletion_protection  = false

  template {
    service_account       = google_service_account.n8n.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    # Long webhook calls and the push connection of the editor.
    timeout          = "3600s"
    session_affinity = true
    # Each open editor keeps a connection, so one instance takes many requests at the same time.
    max_instance_request_concurrency = 1000

    scaling {
      min_instance_count = 1
      max_instance_count = local.queue ? var.main_max_instances : 1
    }

    dynamic "vpc_access" {
      for_each = var.network != "" ? [1] : []
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = var.network
          subnetwork = var.subnetwork
        }
      }
    }

    containers {
      name  = "n8n"
      image = local.n8n_image

      ports {
        container_port = 5678
      }

      resources {
        limits = { cpu = var.n8n_resources.cpu, memory = var.n8n_resources.memory }
        # n8n runs schedules and other work between requests, so it keeps its CPU.
        cpu_idle          = false
        startup_cpu_boost = true
      }

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
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # The first start runs the migrations of the database.
      startup_probe {
        http_get {
          path = "/health"
          port = 5678
        }
        period_seconds    = 10
        timeout_seconds   = 5
        failure_threshold = 24
      }
      liveness_probe {
        http_get {
          path = "/health"
          port = 5678
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "volume_mounts" {
        for_each = local.secret_files
        content {
          name       = volume_mounts.key
          mount_path = volume_mounts.value.path
        }
      }
    }

    containers {
      name       = "runners"
      image      = local.runners_image
      depends_on = ["n8n"]

      resources {
        limits   = { cpu = var.runners_resources.cpu, memory = var.runners_resources.memory }
        cpu_idle = false
      }

      dynamic "env" {
        for_each = local.runners_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "N8N_RUNNERS_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.runners_token.id
            version = "latest"
          }
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.n8n.connection_name]
      }
    }
    dynamic "volumes" {
      for_each = local.secret_files
      content {
        name = volumes.key
        secret {
          secret = volumes.value.secret
          items {
            version = "latest"
            path    = volumes.value.file
          }
        }
      }
    }
  }

  # The images, the secrets and the access to them must exist before an instance starts.
  depends_on = [
    google_artifact_registry_repository.ghcr,
    google_secret_manager_secret_iam_member.n8n,
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_version.runners_token,
    google_secret_manager_secret_version.db_password,
    google_secret_manager_secret_version.encryption_key,
    google_secret_manager_secret_version.git_ca,
    google_secret_manager_secret_version.redis_auth,
    google_secret_manager_secret_version.redis_ca,
  ]
}

resource "google_cloud_run_v2_worker_pool" "worker" {
  count = local.queue ? 1 : 0

  project             = var.project_id
  name                = "${var.name}-worker"
  location            = var.region
  labels              = var.labels
  deletion_protection = false

  scaling {
    manual_instance_count = var.worker_instances
  }

  template {
    service_account = google_service_account.n8n.email

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
    }

    containers {
      name  = "n8n"
      image = local.n8n_image
      args  = ["worker", "--concurrency=${var.worker_concurrency}"]

      resources {
        limits = { cpu = var.n8n_resources.cpu, memory = var.n8n_resources.memory }
      }

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
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # QUEUE_HEALTH_CHECK_ACTIVE starts the health server of the worker on port 5678.
      startup_probe {
        http_get {
          path = "/health"
          port = 5678
        }
        period_seconds    = 10
        timeout_seconds   = 5
        failure_threshold = 24
      }
      liveness_probe {
        http_get {
          path = "/health"
          port = 5678
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "volume_mounts" {
        for_each = local.secret_files
        content {
          name       = volume_mounts.key
          mount_path = volume_mounts.value.path
        }
      }
    }

    containers {
      name       = "runners"
      image      = local.runners_image
      depends_on = ["n8n"]

      resources {
        limits = { cpu = var.runners_resources.cpu, memory = var.runners_resources.memory }
      }

      dynamic "env" {
        for_each = local.runners_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "N8N_RUNNERS_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.runners_token.id
            version = "latest"
          }
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.n8n.connection_name]
      }
    }
    dynamic "volumes" {
      for_each = local.secret_files
      content {
        name = volumes.key
        secret {
          secret = volumes.value.secret
          items {
            version = "latest"
            path    = volumes.value.file
          }
        }
      }
    }
  }

  # The images, the secrets and the access to them must exist before an instance starts.
  depends_on = [
    google_artifact_registry_repository.ghcr,
    google_secret_manager_secret_iam_member.n8n,
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_version.runners_token,
    google_secret_manager_secret_version.db_password,
    google_secret_manager_secret_version.encryption_key,
    google_secret_manager_secret_version.git_ca,
    google_secret_manager_secret_version.redis_auth,
    google_secret_manager_secret_version.redis_ca,
  ]
}
