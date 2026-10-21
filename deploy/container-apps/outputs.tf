output "url" {
  description = "The URL of n8n, after you bind the domain (README.md)."
  value       = "https://${var.domain}"
}

output "app_fqdn" {
  description = "The default host name of the main app. Point a CNAME record of the domain at it."
  value       = azurerm_container_app.main.ingress[0].fqdn
}

output "domain_verification_id" {
  description = "The value of the TXT record asuid.<domain>, which proves that you own the domain."
  value       = azurerm_container_app.main.custom_domain_verification_id
  sensitive   = true
}

output "environment_name" {
  description = "The Container Apps environment."
  value       = azurerm_container_app_environment.n8n.name
}

output "outbound_ip_address" {
  description = "The static address of the environment. Allow it on private hosts that n8n calls."
  value       = azurerm_container_app_environment.n8n.static_ip_address
}

output "database_server" {
  description = "The PostgreSQL server. Its backups are the backups of n8n."
  value       = azurerm_postgresql_flexible_server.n8n.name
}

output "encryption_key" {
  description = "The encryption key of n8n. Keep a copy outside Azure: terraform output -raw encryption_key"
  value       = local.secret_values["encryption-key"]
  sensitive   = true
}
