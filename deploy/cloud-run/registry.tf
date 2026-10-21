# Cloud Run pulls images only from Artifact Registry and Docker Hub. This remote repository serves
# the fork images of ghcr.io, with the token of ghcr_token_secret.

resource "google_artifact_registry_repository" "ghcr" {
  count = var.ghcr_username != "" ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = "${var.name}-ghcr"
  description   = "The images of ghcr.io for n8n"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  labels        = var.labels

  remote_repository_config {
    description = "ghcr.io"
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
    upstream_credentials {
      username_password_credentials {
        username                = var.ghcr_username
        password_secret_version = "${startswith(var.ghcr_token_secret, "projects/") ? var.ghcr_token_secret : "projects/${var.project_id}/secrets/${var.ghcr_token_secret}"}/versions/latest"
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.ghcr_token_secret != ""
      error_message = "Set ghcr_token_secret to the secret with the GitHub token."
    }
  }
  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.ghcr_token,
  ]
}

# Artifact Registry reads the token with its service agent.
resource "google_secret_manager_secret_iam_member" "ghcr_token" {
  count = var.ghcr_username != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.ghcr_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"
}
