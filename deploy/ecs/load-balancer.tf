# An Application Load Balancer with HTTPS, and AWS WAF for the IP limits of webhooks and forms (the
# rules of deploy/Caddyfile).

resource "aws_lb" "n8n" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
  # Long webhook calls and the push connection of the editor.
  idle_timeout               = 3600
  drop_invalid_header_fields = true
  tags                       = var.tags
}

resource "aws_lb_target_group" "n8n" {
  name                 = "${var.name}-main"
  port                 = 5678
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  tags                 = var.tags

  health_check {
    path                = "/healthz/readiness"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 4
  }

  # The editor of a user stays on one main task.
  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.n8n.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  tags              = var.tags

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.n8n.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.n8n.arn
  port              = 80
  protocol          = "HTTP"
  tags              = var.tags

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

locals {
  waf_rules = concat(
    local.limit_webhooks ? [{ name = "webhooks", priority = 1, ranges = var.webhook_allowed_ranges, path = "^/(webhook|webhook-test|webhook-waiting|mcp|mcp-test)/" }] : [],
    local.limit_forms ? [{ name = "forms", priority = 2, ranges = var.form_allowed_ranges, path = "^/(form|form-test|form-waiting)/" }] : [],
  )
}

# AWS WAF keeps IPv4 and IPv6 ranges in separate IP sets.
resource "aws_wafv2_ip_set" "allowed" {
  for_each = { for rule in local.waf_rules : rule.name => rule }

  name               = "${var.name}-${each.key}"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = [for range in each.value.ranges : range if !strcontains(range, ":")]
  tags               = var.tags
}

resource "aws_wafv2_regex_pattern_set" "paths" {
  for_each = { for rule in local.waf_rules : rule.name => rule }

  name  = "${var.name}-${each.key}"
  scope = "REGIONAL"
  tags  = var.tags

  regular_expression {
    regex_string = each.value.path
  }
}

resource "aws_wafv2_web_acl" "n8n" {
  count = length(local.waf_rules) > 0 ? 1 : 0

  name  = var.name
  scope = "REGIONAL"
  tags  = var.tags

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.waf_rules
    content {
      name     = "${rule.value.name}-from-other-addresses"
      priority = rule.value.priority

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            regex_pattern_set_reference_statement {
              arn = aws_wafv2_regex_pattern_set.paths[rule.value.name].arn
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
          statement {
            not_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.allowed[rule.value.name].arn
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-${rule.value.name}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "n8n" {
  count        = length(local.waf_rules) > 0 ? 1 : 0
  resource_arn = aws_lb.n8n.arn
  web_acl_arn  = aws_wafv2_web_acl.n8n[0].arn
}

resource "aws_route53_record" "n8n" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_lb.n8n.dns_name
    zone_id                = aws_lb.n8n.zone_id
    evaluate_target_health = true
  }
}
