variable "name" {
  description = "The prefix of the names of the resources."
  type        = string
  default     = "n8n"
}

variable "domain" {
  description = "The host name of n8n, for example n8n.example.com."
  type        = string
}

variable "certificate_arn" {
  description = "The ACM certificate of the domain, in the region of the module."
  type        = string
}

variable "route53_zone_id" {
  description = "A Route 53 zone of the domain. The module then makes the DNS record. Leave it empty to make the record yourself."
  type        = string
  default     = ""
}

variable "vpc_id" {
  description = "The VPC."
  type        = string
}

variable "public_subnet_ids" {
  description = "The subnets of the load balancer, in two or more availability zones."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "The subnets of the tasks, the database and Redis. The tasks need a NAT gateway to reach the internet and ghcr.io."
  type        = list(string)
}

variable "mode" {
  description = "single: one n8n task. A deploy stops it before the new one starts. queue: main tasks and workers with Redis, and only the leader of the main tasks runs the schedules."
  type        = string
  default     = "single"

  validation {
    condition     = contains(["single", "queue"], var.mode)
    error_message = "Set mode to single or queue."
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

variable "registry_credentials_secret_arn" {
  description = "A Secrets Manager secret with the user name and token of a private registry, as JSON: {\"username\": \"...\", \"password\": \"...\"}. ghcr.io needs it for private images."
  type        = string
  default     = ""
}

variable "settings" {
  description = "n8n settings that replace the values of deploy/settings.yaml and of the module, for example { N8N_SSO_MANAGED_BY_ENV = \"true\" }."
  type        = map(string)
  default     = {}
}

variable "encryption_key_secret_arn" {
  description = "A Secrets Manager secret with the encryption key of an existing n8n, for example the N8N_ENCRYPTION_KEY of the VM when you move its database. Empty makes a new key."
  type        = string
  default     = ""
}

variable "extra_secrets" {
  description = "More secret environment variables of n8n, from Secrets Manager secrets (ARN), for example { N8N_SSO_OIDC_CLIENT_SECRET = \"arn:aws:secretsmanager:...\" }."
  type        = map(string)
  default     = {}
}

variable "git_ca_certificate" {
  description = "The root certificate (PEM) of the Forgejo server of deploy/forgejo, for the Git features. Empty when Git uses public certificates."
  type        = string
  default     = ""
}

variable "database_ca_certificate" {
  description = "The certificates (PEM) of RDS for the region, from https://truststore.pki.rds.amazonaws.com/REGION/REGION-bundle.pem. n8n then checks the certificate of the database. Without it, the connection is encrypted but n8n does not check the certificate."
  type        = string
  default     = ""
}

variable "alb_allowed_ranges" {
  description = "The IP ranges that can reach the load balancer at all."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "webhook_allowed_ranges" {
  description = "The IP ranges that can call webhooks, chats and MCP servers. AWS WAF answers other addresses with 403. The default lets all addresses call them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "form_allowed_ranges" {
  description = "The IP ranges that can open and send forms. The default lets all addresses open them."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "main_count" {
  description = "Queue mode: the number of main tasks. Mode single always runs one."
  type        = number
  default     = 2
}

variable "worker_count" {
  description = "Queue mode: the number of workers."
  type        = number
  default     = 1
}

variable "worker_concurrency" {
  description = "Queue mode: the executions that each worker runs at the same time."
  type        = number
  default     = 10
}

variable "task_cpu" {
  description = "The CPU units of each task (1024 = 1 vCPU), for n8n and the task runners together."
  type        = number
  default     = 2048
}

variable "task_memory" {
  description = "The memory of each task in MiB, for n8n and the task runners together."
  type        = number
  default     = 4096
}

variable "database" {
  description = "RDS for PostgreSQL."
  type = object({
    engine_version      = optional(string, "18")
    instance_class      = optional(string, "db.t4g.small")
    allocated_storage   = optional(number, 20)
    multi_az            = optional(bool, false)
    backup_days         = optional(number, 14)
    deletion_protection = optional(bool, true)
  })
  default = {}
}

variable "redis_node_type" {
  description = "Queue mode: the node type of ElastiCache."
  type        = string
  default     = "cache.t4g.micro"
}

variable "log_retention_days" {
  description = "The days that CloudWatch keeps the logs of n8n."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags for the resources."
  type        = map(string)
  default     = {}
}
