# Security groups: the internet reaches only the load balancer. The tasks take traffic from the
# load balancer and, in queue mode, from each other. Only the tasks reach the database and Redis.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "The load balancer of n8n"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each = { for pair in setproduct(var.alb_allowed_ranges, [80, 443]) : "${pair[0]}-${pair[1]}" => pair }

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS, and HTTP for the redirect"
  cidr_ipv4         = strcontains(each.value[0], ":") ? null : each.value[0]
  cidr_ipv6         = strcontains(each.value[0], ":") ? each.value[0] : null
  ip_protocol       = "tcp"
  from_port         = each.value[1]
  to_port           = each.value[1]
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the n8n tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5678
  to_port                      = 5678
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "The n8n tasks"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 5678
  to_port                      = 5678
}

# Queue mode: the workers call the AI gateway on the main tasks.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_tasks" {
  count = local.queue ? 1 : 0

  security_group_id            = aws_security_group.tasks.id
  description                  = "From the other n8n tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5678
  to_port                      = 5678
}

# The nodes of n8n call services on the internet and in the VPC.
resource "aws_vpc_security_group_egress_rule" "tasks" {
  security_group_id = aws_security_group.tasks.id
  description       = "All outbound traffic"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "data" {
  name        = "${var.name}-data"
  description = "The database and Redis of n8n"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "data" {
  for_each = local.queue ? { postgres = 5432, redis = 6379 } : { postgres = 5432 }

  security_group_id            = aws_security_group.data.id
  description                  = "From the n8n tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}
