# Cloud SQL for PostgreSQL. n8n connects through the Cloud SQL connector of Cloud Run, on a Unix
# socket, so the instance needs no authorized networks.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "n8n" {
  project             = var.project_id
  name                = "${var.name}-db"
  region              = var.region
  database_version    = var.database.version
  deletion_protection = var.database.deletion_protection

  settings {
    edition                     = "ENTERPRISE"
    tier                        = var.database.tier
    availability_type           = var.database.availability_type
    disk_size                   = var.database.disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.database.deletion_protection
    user_labels                 = var.labels

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = var.database.backup_days
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "n8n" {
  project  = var.project_id
  instance = google_sql_database_instance.n8n.name
  name     = "n8n"
}

resource "google_sql_user" "n8n" {
  project  = var.project_id
  instance = google_sql_database_instance.n8n.name
  name     = "n8n"
  password = random_password.db.result
}
