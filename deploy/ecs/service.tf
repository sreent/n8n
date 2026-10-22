# The main tasks (behind the load balancer) and, in queue mode, the workers. Each task runs n8n with
# the task runners next to it.

resource "aws_ecs_cluster" "n8n" {
  name = var.name
  tags = var.tags

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "main" {
  family                   = "${var.name}-main"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  # The images are for x86-64 only.
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode(concat(local.files_container, [local.n8n_container, local.runners_container]))

  dynamic "volume" {
    for_each = var.git_ca_certificate != "" ? [1] : []
    content {
      name = "files"
    }
  }
}

resource "aws_ecs_service" "main" {
  name                              = "${var.name}-main"
  cluster                           = aws_ecs_cluster.n8n.id
  task_definition                   = aws_ecs_task_definition.main.arn
  launch_type                       = "FARGATE"
  desired_count                     = local.queue ? var.main_count : 1
  health_check_grace_period_seconds = 600
  propagate_tags                    = "SERVICE"
  tags                              = var.tags

  # Mode single: stop the old task before the new one starts, so that two tasks never run the
  # schedules at the same time. Queue mode: the leader election lets them run together.
  deployment_minimum_healthy_percent = local.queue ? 100 : 0
  deployment_maximum_percent         = local.queue ? 200 : 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.n8n.arn
    container_name   = "n8n"
    container_port   = 5678
  }

  dynamic "service_registries" {
    for_each = local.queue ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.main[0].arn
    }
  }

  depends_on = [aws_lb_listener.https, aws_iam_role_policy.read_secrets]
}

resource "aws_ecs_task_definition" "worker" {
  count = local.queue ? 1 : 0

  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = var.tags

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode(concat(local.files_container, [
    merge(local.n8n_container, { command = ["worker", "--concurrency=${var.worker_concurrency}"] }),
    local.runners_container,
  ]))

  dynamic "volume" {
    for_each = var.git_ca_certificate != "" ? [1] : []
    content {
      name = "files"
    }
  }
}

resource "aws_ecs_service" "worker" {
  count = local.queue ? 1 : 0

  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.n8n.id
  task_definition = aws_ecs_task_definition.worker[0].arn
  launch_type     = "FARGATE"
  desired_count   = var.worker_count
  propagate_tags  = "SERVICE"
  tags            = var.tags

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  depends_on = [aws_iam_role_policy.read_secrets]
}

# Queue mode: a private DNS name of the main tasks for the workers.
resource "aws_service_discovery_private_dns_namespace" "n8n" {
  count = local.queue ? 1 : 0
  name  = "${var.name}.internal"
  vpc   = var.vpc_id
  tags  = var.tags
}

resource "aws_service_discovery_service" "main" {
  count = local.queue ? 1 : 0
  name  = "main"
  tags  = var.tags

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.n8n[0].id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}
