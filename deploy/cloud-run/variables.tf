variable "project_id" {
  description = "The Google Cloud project."
  type        = string
}

variable "region" {
  description = "The region of Cloud Run, Cloud SQL and Memorystore, for example europe-west1."
  type        = string
}

variable "name" {
  description = "The prefix of the names of the resources."
  type        = string
  default     = "n8n"
}

variable "domain" {
  description = "The host name of n8n, for example n8n.example.com. Point its DNS record at the address of the output lb_ip_address."
  type        = string
}

variable "dns_managed_zone" {
  description = "A Cloud DNS zone of the project for the domain. The module then makes the DNS record. Leave it empty to make the record yourself."
  type        = string
  default     = ""
}

variable "mode" {
  description = "queue: main instances and workers with Redis, and only the leader of the main instances runs the schedules. single: one n8n instance. Cloud Run can run two instances for a short time after a deploy, so single can run a schedule twice then."
  type        = string
  default     = "queue"

  validation {
    condition     = contains(["queue", "single"], var.mode)
    error_message = "Set mode to queue or single."
  }
}

variable "image_tag" {
  description = "The tag of the two fork images, for example 2.42.0-1a2b3c4d5e."
  type        = string
}

variable "ghcr_username" {
  description = "The GitHub user that reads the images from ghcr.io. The module makes an Artifact Registry repository that serves the images of ghcr.io, because Cloud Run pulls only from Artifact Registry and Docker Hub. Leave it empty and set n8n_image and runners_image to use other images."
  type        = string
  default     = ""
}

variable "ghcr_token_secret" {
  description = "The Secret Manager secret (name or ID) with a GitHub token that can read the packages (read:packages). Make it before the apply: printf '%s' \"$TOKEN\" | gcloud secrets create ghcr-token --data-file=-"
  type        = string
  default     = ""
}

variable "n8n_image" {
  description = "The full n8n image, in place of the image from ghcr.io."
  type        = string
  default     = ""
}

variable "runners_image" {
  description = "The full runners image, in place of the image from ghcr.io. Use the version of the n8n image."
  type        = string
  default     = ""
}

variable "settings" {
  description = "n8n settings that replace the values of deploy/settings.yaml and of the module, for example { N8N_SSO_MANAGED_BY_ENV = \"true\" }."
  type        = map(string)
  default     = {}
}

variable "encryption_key_secret" {
  description = "A Secret Manager secret (name or ID) with the encryption key of an existing n8n, for example the N8N_ENCRYPTION_KEY of the VM when you move its database. Empty makes a new key."
  type        = string
  default     = ""
}

variable "extra_secrets" {
  description = "More secret environment variables of n8n, from Secret Manager secrets (name or ID), for example { N8N_SSO_OIDC_CLIENT_SECRET = \"n8n-oidc-client-secret\" }."
  type        = map(string)
  default     = {}
}

variable "git_ca_certificate" {
  description = "The root certificate (PEM) of the Forgejo server of deploy/forgejo, for the Git features. Empty when Git uses public certificates."
  type        = string
  default     = ""
}

variable "network" {
  description = "The VPC network for Direct VPC egress, for example projects/PROJECT/global/networks/default. Queue mode needs it for Memorystore. It also reaches private hosts such as Forgejo."
  type        = string
  default     = ""
}

variable "subnetwork" {
  description = "The subnetwork of the network for Direct VPC egress. Open the firewall of private hosts, such as Forgejo, for its range."
  type        = string
  default     = ""
}

variable "webhook_allowed_ranges" {
  description = "The IP ranges that can call webhooks, chats and MCP servers. Cloud Armor answers other addresses with 403. The default lets all addresses call them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "form_allowed_ranges" {
  description = "The IP ranges that can open and send forms. The default lets all addresses open them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "main_max_instances" {
  description = "Queue mode: the most main instances. Mode single always runs one."
  type        = number
  default     = 2
}

variable "worker_instances" {
  description = "Queue mode: the number of workers."
  type        = number
  default     = 1
}

variable "worker_concurrency" {
  description = "Queue mode: the executions that each worker runs at the same time."
  type        = number
  default     = 10
}

variable "n8n_resources" {
  description = "The CPU and memory of the n8n container of each instance."
  type        = object({ cpu = string, memory = string })
  default     = { cpu = "1", memory = "2Gi" }
}

variable "runners_resources" {
  description = "The CPU and memory of the task runners container of each instance."
  type        = object({ cpu = string, memory = string })
  default     = { cpu = "1", memory = "1Gi" }
}

variable "database" {
  description = "Cloud SQL for PostgreSQL. REGIONAL availability keeps a standby in a second zone."
  type = object({
    version             = optional(string, "POSTGRES_18")
    tier                = optional(string, "db-custom-1-3840")
    availability_type   = optional(string, "ZONAL")
    disk_size_gb        = optional(number, 20)
    backup_days         = optional(number, 14)
    deletion_protection = optional(bool, true)
  })
  default = {}
}

variable "redis_memory_gb" {
  description = "Queue mode: the memory of Memorystore for Redis."
  type        = number
  default     = 1
}

variable "redis_verify_certificate" {
  description = "Queue mode: check the TLS certificate of Memorystore with the certificate authority of the instance. With false, n8n encrypts the connection but does not check the certificate."
  type        = bool
  default     = true
}

variable "enable_apis" {
  description = "Turn on the Google APIs that the module uses."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Labels for the resources."
  type        = map(string)
  default     = {}
}
