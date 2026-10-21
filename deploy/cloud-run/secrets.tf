# The secrets of n8n in Secret Manager. Terraform makes them, so its state holds them too: keep the
# state in a private bucket.

locals {
  new_encryption_key    = var.encryption_key_secret == ""
  encryption_key_secret = local.new_encryption_key ? google_secret_manager_secret.encryption_key[0].id : var.encryption_key_secret
}

resource "google_secret_manager_secret" "encryption_key" {
  count     = local.new_encryption_key ? 1 : 0
  project   = var.project_id
  secret_id = "${var.name}-encryption-key"
  labels    = var.labels
  replication {
    auto {}
  }
  # n8n encrypts the credentials with this key. Without it, a backup cannot be restored.
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.apis]
}

resource "random_password" "encryption_key" {
  count   = local.new_encryption_key ? 1 : 0
  length  = 48
  special = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_version" "encryption_key" {
  count       = local.new_encryption_key ? 1 : 0
  secret      = google_secret_manager_secret.encryption_key[0].id
  secret_data = random_password.encryption_key[0].result
}

resource "random_password" "runners_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "runners_token" {
  project   = var.project_id
  secret_id = "${var.name}-runners-token"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "runners_token" {
  secret      = google_secret_manager_secret.runners_token.id
  secret_data = random_password.runners_token.result
}

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "${var.name}-db-password"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

# Cloud Run mounts secrets as files. The root certificate of Forgejo is not secret, but a secret is
# the way to give Git a file.
resource "google_secret_manager_secret" "git_ca" {
  count     = var.git_ca_certificate != "" ? 1 : 0
  project   = var.project_id
  secret_id = "${var.name}-git-ca"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "git_ca" {
  count       = var.git_ca_certificate != "" ? 1 : 0
  secret      = google_secret_manager_secret.git_ca[0].id
  secret_data = var.git_ca_certificate
}
