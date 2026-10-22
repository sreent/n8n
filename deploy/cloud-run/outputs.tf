output "url" {
  description = "The URL of n8n."
  value       = "https://${var.domain}"
}

output "lb_ip_address" {
  description = "The address of the load balancer. Point the DNS record of the domain at it. Google makes the HTTPS certificate after that, which can take up to an hour."
  value       = google_compute_global_address.n8n.address
}

output "encryption_key_secret" {
  description = "The secret with the encryption key of n8n. Keep a copy of its value outside Google Cloud."
  value       = local.encryption_key_secret
}

output "database_instance" {
  description = "The Cloud SQL instance. Its backups are the backups of n8n."
  value       = google_sql_database_instance.n8n.name
}

output "service_account" {
  description = "The service account of n8n."
  value       = google_service_account.n8n.email
}
