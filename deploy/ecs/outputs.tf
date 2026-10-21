output "url" {
  description = "The URL of n8n."
  value       = "https://${var.domain}"
}

output "alb_dns_name" {
  description = "The DNS name of the load balancer. Point the domain at it (a CNAME or an alias record)."
  value       = aws_lb.n8n.dns_name
}

output "encryption_key_secret_arn" {
  description = "The secret with the encryption key of n8n. Keep a copy of its value outside AWS."
  value       = local.encryption_key_secret_arn
}

output "database_instance" {
  description = "The RDS instance. Its automated backups are the backups of n8n."
  value       = aws_db_instance.n8n.identifier
}

output "cluster" {
  description = "The ECS cluster."
  value       = aws_ecs_cluster.n8n.name
}
