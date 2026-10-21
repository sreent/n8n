# RDS for PostgreSQL. RDS makes the password and keeps it in Secrets Manager, so it is not in the
# state of Terraform.

resource "aws_db_subnet_group" "n8n" {
  name       = "${var.name}-db"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

resource "aws_db_instance" "n8n" {
  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = var.database.engine_version
  instance_class              = var.database.instance_class
  allocated_storage           = var.database.allocated_storage
  max_allocated_storage       = var.database.allocated_storage * 5
  storage_encrypted           = true
  db_name                     = "n8n"
  username                    = "n8n"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.n8n.name
  vpc_security_group_ids      = [aws_security_group.data.id]
  publicly_accessible         = false
  multi_az                    = var.database.multi_az
  backup_retention_period     = var.database.backup_days
  copy_tags_to_snapshot       = true
  deletion_protection         = var.database.deletion_protection
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-db-final"
  tags                        = var.tags
}
