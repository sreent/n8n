# Tests of the module with mock providers: no AWS account and no costs.
# Run them with `terraform init -backend=false && terraform test` in deploy/ecs.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address  = "n8n-db.abc.eu-west-1.rds.amazonaws.com"
      port     = 5432
      username = "n8n"
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rds-db-password-AbCdEf"
        kms_key_id    = ""
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:n8n-mock-AbCdEf" }
  }
  mock_resource "aws_elasticache_replication_group" {
    defaults = { primary_endpoint_address = "master.n8n-redis.abc.euw1.cache.amazonaws.com" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/n8n-mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/n8n-alb/abc", dns_name = "n8n-alb-1.eu-west-1.elb.amazonaws.com", zone_id = "Z32O12XQLNTSW2" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/n8n-main/abc" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/n8n/abc" }
  }
  mock_resource "aws_wafv2_ip_set" {
    defaults = { arn = "arn:aws:wafv2:eu-west-1:123456789012:regional/ipset/n8n/abc" }
  }
  mock_resource "aws_wafv2_regex_pattern_set" {
    defaults = { arn = "arn:aws:wafv2:eu-west-1:123456789012:regional/regexpatternset/n8n/abc" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:eu-west-1:123456789012:service/srv-abc" }
  }
}

mock_provider "random" {
  # ElastiCache takes an AUTH token of 16 or more characters.
  mock_resource "random_password" {
    defaults = { result = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL" }
  }
}

variables {
  domain             = "n8n.example.com"
  certificate_arn    = "arn:aws:acm:eu-west-1:123456789012:certificate/abc"
  vpc_id             = "vpc-123"
  public_subnet_ids  = ["subnet-pub-a", "subnet-pub-b"]
  private_subnet_ids = ["subnet-priv-a", "subnet-priv-b"]
  image_tag          = "2.42.0-1a2b3c4d5e"
}

run "single_mode_by_default" {
  command = apply

  assert {
    condition     = aws_ecs_service.main.desired_count == 1 && aws_ecs_service.main.deployment_minimum_healthy_percent == 0 && aws_ecs_service.main.deployment_maximum_percent == 100
    error_message = "One task, and a deploy stops it before the new one starts."
  }
  assert {
    condition     = length(aws_ecs_service.worker) == 0 && length(aws_elasticache_replication_group.n8n) == 0
    error_message = "Mode single has no workers and no Redis."
  }
  assert {
    condition     = [for c in jsondecode(aws_ecs_task_definition.main.container_definitions) : c.name] == ["n8n", "runners"]
    error_message = "The task runs n8n and the task runners."
  }
  assert {
    condition = alltrue([for pair in [
      "DB_POSTGRESDB_HOST=n8n-db.abc.eu-west-1.rds.amazonaws.com",
      "DB_POSTGRESDB_SSL_ENABLED=true",
      "DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false",
      "N8N_PROXY_HOPS=1",
      "N8N_OPEN_TRIGGERS_NEED_APPROVAL=true",
      "WEBHOOK_URL=https://n8n.example.com/",
    ] : contains([for e in jsondecode(aws_ecs_task_definition.main.container_definitions)[0].environment : "${e.name}=${e.value}"], pair)])
    error_message = "n8n has the settings of the fork and of RDS."
  }
  assert {
    condition     = contains([for s in jsondecode(aws_ecs_task_definition.main.container_definitions)[0].secrets : s.valueFrom if s.name == "DB_POSTGRESDB_PASSWORD"], "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rds-db-password-AbCdEf:password::")
    error_message = "The password of the database comes from the secret of RDS."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.main.container_definitions)[0].image == "ghcr.io/sreent/n8n:2.42.0-1a2b3c4d5e"
    error_message = "The images come from ghcr.io."
  }
  assert {
    condition     = aws_ecs_task_definition.main.runtime_platform[0].cpu_architecture == "X86_64"
    error_message = "The images are for x86-64."
  }
  assert {
    condition     = length(aws_wafv2_web_acl.n8n) == 0
    error_message = "Without IP limits, there is no WAF."
  }
}

run "queue_mode" {
  command = apply

  variables {
    mode = "queue"
  }

  assert {
    condition     = length(aws_ecs_service.worker) == 1 && aws_ecs_service.main.desired_count == 2 && aws_ecs_service.main.deployment_minimum_healthy_percent == 100
    error_message = "Queue mode runs two main tasks with rolling deploys, and workers."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].command == ["worker", "--concurrency=10"]
    error_message = "The workers start with n8n worker."
  }
  assert {
    condition = alltrue([for pair in [
      "EXECUTIONS_MODE=queue",
      "N8N_MULTI_MAIN_SETUP_ENABLED=true",
      "N8N_WORKER_SERVER_ADDRESS=0.0.0.0",
      "QUEUE_BULL_REDIS_HOST=master.n8n-redis.abc.euw1.cache.amazonaws.com",
      "QUEUE_BULL_REDIS_TLS=true",
      "N8N_AI_GATEWAY_BASE_URL=http://main.n8n.internal:5678/ai-gateway",
      "N8N_SSRF_ALLOWED_HOSTNAMES=main.n8n.internal",
    ] : contains([for e in jsondecode(aws_ecs_task_definition.main.container_definitions)[0].environment : "${e.name}=${e.value}"], pair)])
    error_message = "n8n has the settings of queue mode."
  }
  assert {
    condition     = length(aws_ecs_service.main.service_registries) == 1
    error_message = "The main tasks have a private DNS name for the workers."
  }
}

run "ip_limits" {
  command = apply

  variables {
    webhook_allowed_ranges = ["10.0.0.0/8", "203.0.113.0/24", "2001:db8::/32"]
    form_allowed_ranges    = ["10.0.0.0/8"]
  }

  assert {
    condition     = length(aws_wafv2_web_acl.n8n) == 1 && length(aws_wafv2_web_acl.n8n[0].rule) == 2
    error_message = "WAF has a rule for webhooks and a rule for forms."
  }
  assert {
    condition     = aws_wafv2_ip_set.allowed["webhooks"].addresses == toset(["10.0.0.0/8", "203.0.113.0/24"])
    error_message = "The IPv4 set has the IPv4 ranges."
  }
  assert {
    condition     = length(aws_wafv2_web_acl_association.n8n) == 1
    error_message = "WAF protects the load balancer."
  }
}

run "git_ca_and_registry" {
  command = apply

  variables {
    git_ca_certificate              = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
    registry_credentials_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:ghcr-AbCdEf"
  }

  assert {
    condition     = [for c in jsondecode(aws_ecs_task_definition.main.container_definitions) : c.name] == ["files", "n8n", "runners"]
    error_message = "A short container writes the certificate before n8n starts."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.main.container_definitions)[1].dependsOn == [{ containerName = "files", condition = "SUCCESS" }]
    error_message = "n8n waits for the certificate."
  }
  assert {
    condition     = contains([for e in jsondecode(aws_ecs_task_definition.main.container_definitions)[1].environment : "${e.name}=${e.value}"], "GIT_SSL_CAINFO=/files/git-ca.crt")
    error_message = "Git reads the certificate from the volume."
  }
  assert {
    condition     = alltrue([for c in jsondecode(aws_ecs_task_definition.main.container_definitions) : c.repositoryCredentials.credentialsParameter == "arn:aws:secretsmanager:eu-west-1:123456789012:secret:ghcr-AbCdEf"])
    error_message = "Each container pulls with the credentials of the registry."
  }
  assert {
    condition     = contains(data.aws_iam_policy_document.read_secrets.statement[0].resources, "arn:aws:secretsmanager:eu-west-1:123456789012:secret:ghcr-AbCdEf")
    error_message = "The execution role reads the credentials of the registry."
  }
}

run "existing_encryption_key" {
  command   = apply
  state_key = "existing_key"

  variables {
    encryption_key_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:vm-key-AbCdEf"
  }

  assert {
    condition     = length(aws_secretsmanager_secret.encryption_key) == 0
    error_message = "An existing key needs no new secret."
  }
  assert {
    condition     = contains([for s in jsondecode(aws_ecs_task_definition.main.container_definitions)[0].secrets : s.valueFrom if s.name == "N8N_ENCRYPTION_KEY"], "arn:aws:secretsmanager:eu-west-1:123456789012:secret:vm-key-AbCdEf")
    error_message = "n8n reads the existing key."
  }
}
