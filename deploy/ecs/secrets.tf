# The secrets of n8n in Secrets Manager. Terraform makes them, so its state holds them too: keep the
# state in a private bucket.

locals {
  new_encryption_key        = var.encryption_key_secret_arn == ""
  encryption_key_secret_arn = local.new_encryption_key ? aws_secretsmanager_secret.encryption_key[0].arn : var.encryption_key_secret_arn
}

resource "aws_secretsmanager_secret" "encryption_key" {
  count = local.new_encryption_key ? 1 : 0
  name  = "${var.name}/encryption-key"
  tags  = var.tags
  # n8n encrypts the credentials with this key. Without it, a backup cannot be restored.
  lifecycle {
    prevent_destroy = true
  }
}

resource "random_password" "encryption_key" {
  count   = local.new_encryption_key ? 1 : 0
  length  = 48
  special = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  count         = local.new_encryption_key ? 1 : 0
  secret_id     = aws_secretsmanager_secret.encryption_key[0].id
  secret_string = random_password.encryption_key[0].result
}

resource "random_password" "runners_token" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "runners_token" {
  name = "${var.name}/runners-token"
  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "runners_token" {
  secret_id     = aws_secretsmanager_secret.runners_token.id
  secret_string = random_password.runners_token.result
}
