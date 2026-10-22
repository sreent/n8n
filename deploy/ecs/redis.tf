# Queue mode: ElastiCache for Valkey with TLS and an AUTH token. It holds the queue of the
# executions and the leader key of the main tasks.

resource "random_password" "redis_auth" {
  count   = local.queue ? 1 : 0
  length  = 48
  special = false
}

resource "aws_elasticache_subnet_group" "n8n" {
  count      = local.queue ? 1 : 0
  name       = "${var.name}-redis"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

resource "aws_elasticache_replication_group" "n8n" {
  count = local.queue ? 1 : 0

  replication_group_id       = "${var.name}-redis"
  description                = "The queue of n8n"
  engine                     = "valkey"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.n8n[0].name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth[0].result
  tags                       = var.tags
}

resource "aws_secretsmanager_secret" "redis_auth" {
  count = local.queue ? 1 : 0
  name  = "${var.name}/redis-auth"
  tags  = var.tags
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  count         = local.queue ? 1 : 0
  secret_id     = aws_secretsmanager_secret.redis_auth[0].id
  secret_string = random_password.redis_auth[0].result
}
