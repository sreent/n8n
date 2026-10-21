variable "name" {
  description = "The prefix of the names of the resources."
  type        = string
  default     = "n8n"
}

variable "resource_group_name" {
  description = "An existing resource group for the resources. Its location is the location of n8n."
  type        = string
}

variable "domain" {
  description = "The host name of n8n, for example n8n.example.com. README.md tells how to bind it to the app."
  type        = string
}

variable "mode" {
  description = "queue: a main replica and workers with Redis, and only the leader of the main replicas runs the schedules. single: one n8n replica. Container Apps can run two replicas for a short time when a revision changes, so single can run a schedule twice then."
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

variable "n8n_image" {
  description = "The full n8n image. Empty uses ghcr.io/sreent/n8n with image_tag."
  type        = string
  default     = ""
}

variable "runners_image" {
  description = "The full runners image. Empty uses ghcr.io/sreent/n8n-runners with image_tag."
  type        = string
  default     = ""
}

variable "registry" {
  description = "The registry of private images, for example { server = \"ghcr.io\", username = \"n8n-bot\", password = \"<token with read:packages>\" }. Empty for public images."
  type = object({
    server   = string
    username = string
    password = string
  })
  default   = null
  sensitive = true
}

variable "settings" {
  description = "n8n settings that replace the values of deploy/settings.yaml and of the module, for example { N8N_SSO_MANAGED_BY_ENV = \"true\" }."
  type        = map(string)
  default     = {}
}

variable "encryption_key" {
  description = "The encryption key of an existing n8n, for example the N8N_ENCRYPTION_KEY of the VM when you move its database. Empty makes a new key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "extra_secrets" {
  description = "More secret environment variables of n8n, for example { N8N_SSO_OIDC_CLIENT_SECRET = \"...\" }."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "git_ca_certificate" {
  description = "The root certificate (PEM) of the Forgejo server of deploy/forgejo, for the Git features. Empty when Git uses public certificates."
  type        = string
  default     = ""
}

variable "address_space" {
  description = "The address range of the VNet of the module: a /16 or larger. Peer it with the network of Forgejo or of your company."
  type        = string
  default     = "10.40.0.0/16"
}

variable "allowed_ranges" {
  description = "The IP ranges that can reach n8n at all. The default lets all addresses reach it."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "webhook_allowed_ranges" {
  description = "The IP ranges that can call webhooks, chats and MCP servers. A Caddy container answers other addresses with 403. The default lets all addresses call them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "form_allowed_ranges" {
  description = "The IP ranges that can open and send forms. The default lets all addresses open them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "main_replicas" {
  description = "Queue mode: the number of main replicas. Mode single always runs one."
  type        = number
  default     = 1
}

variable "worker_replicas" {
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
  description = "The CPU and memory of the n8n container. Container Apps takes 0.5 Gi of memory for each 0.25 CPU."
  type        = object({ cpu = number, memory = string })
  default     = { cpu = 1.5, memory = "3Gi" }
}

variable "runners_resources" {
  description = "The CPU and memory of the task runners container."
  type        = object({ cpu = number, memory = string })
  default     = { cpu = 0.5, memory = "1Gi" }
}

variable "database" {
  description = "Azure Database for PostgreSQL flexible server."
  type = object({
    version             = optional(string, "17")
    sku_name            = optional(string, "B_Standard_B2s")
    storage_mb          = optional(number, 32768)
    backup_days         = optional(number, 14)
    zone_redundant      = optional(bool, false)
    deletion_protection = optional(bool, true)
  })
  default = {}
}

variable "redis_sku" {
  description = "Queue mode: the SKU of Azure Managed Redis."
  type        = string
  default     = "Balanced_B0"
}

variable "tags" {
  description = "Tags for the resources."
  type        = map(string)
  default     = {}
}
