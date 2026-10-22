# A global external Application Load Balancer in front of Cloud Run: the HTTPS certificate of the
# domain, and Cloud Armor for the IP limits of webhooks and forms (the rules of deploy/Caddyfile).

locals {
  webhook_paths = "request.path.matches('^/(webhook|webhook-test|webhook-waiting|mcp|mcp-test)/')"
  form_paths    = "request.path.matches('^/(form|form-test|form-waiting)/')"

  # A rule has at most five subexpressions: the path and four ranges. More ranges get more rules.
  armor_rules = concat(
    local.limit_webhooks ? [for i, ranges in chunklist(var.webhook_allowed_ranges, 4) : {
      priority    = 1000 + i
      action      = "allow"
      description = "Webhooks, chats and MCP servers from the allowed ranges"
      expression  = "${local.webhook_paths} && (${join(" || ", [for range in ranges : "inIpRange(origin.ip, '${range}')"])})"
    }] : [],
    local.limit_webhooks ? [{
      priority    = 1900
      action      = "deny(403)"
      description = "Webhooks, chats and MCP servers from other addresses"
      expression  = local.webhook_paths
    }] : [],
    local.limit_forms ? [for i, ranges in chunklist(var.form_allowed_ranges, 4) : {
      priority    = 2000 + i
      action      = "allow"
      description = "Forms from the allowed ranges"
      expression  = "${local.form_paths} && (${join(" || ", [for range in ranges : "inIpRange(origin.ip, '${range}')"])})"
    }] : [],
    local.limit_forms ? [{
      priority    = 2900
      action      = "deny(403)"
      description = "Forms from other addresses"
      expression  = local.form_paths
    }] : [],
  )
}

resource "google_compute_global_address" "n8n" {
  project = var.project_id
  name    = "${var.name}-ip"
  labels  = var.labels

  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "n8n" {
  project               = var.project_id
  name                  = "${var.name}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.main.name
  }
}

resource "google_compute_security_policy" "n8n" {
  project     = var.project_id
  name        = "${var.name}-armor"
  description = "The IP limits of the webhooks and the forms of n8n"

  dynamic "rule" {
    for_each = local.armor_rules
    content {
      priority    = rule.value.priority
      action      = rule.value.action
      description = rule.value.description
      match {
        expr {
          expression = rule.value.expression
        }
      }
    }
  }

  rule {
    priority    = 2147483647
    action      = "allow"
    description = "All other requests"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_compute_backend_service" "n8n" {
  project               = var.project_id
  name                  = "${var.name}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.n8n.id

  backend {
    group = google_compute_region_network_endpoint_group.n8n.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_managed_ssl_certificate" "n8n" {
  project = var.project_id
  name    = "${var.name}-cert"
  managed {
    domains = [var.domain]
  }

  lifecycle {
    create_before_destroy = true
  }
  depends_on = [google_project_service.apis]
}

resource "google_compute_url_map" "n8n" {
  project         = var.project_id
  name            = "${var.name}-https"
  default_service = google_compute_backend_service.n8n.id
}

resource "google_compute_target_https_proxy" "n8n" {
  project          = var.project_id
  name             = "${var.name}-https"
  url_map          = google_compute_url_map.n8n.id
  ssl_certificates = [google_compute_managed_ssl_certificate.n8n.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${var.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.n8n.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.n8n.id
  labels                = var.labels
}

# Port 80 sends each request to HTTPS.
resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "${var.name}-http"
  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${var.name}-http"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${var.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.n8n.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
  labels                = var.labels
}

resource "google_dns_record_set" "n8n" {
  count        = var.dns_managed_zone != "" ? 1 : 0
  project      = var.project_id
  managed_zone = var.dns_managed_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.n8n.address]
}
