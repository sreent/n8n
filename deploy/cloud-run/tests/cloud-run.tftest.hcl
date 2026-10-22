# Tests of the module with mock providers: no Google Cloud project and no costs.
# Run them with `terraform init -backend=false && terraform test` in deploy/cloud-run.

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = { connection_name = "test-project:europe-west1:n8n-db" }
  }
  mock_resource "google_redis_instance" {
    defaults = {
      host            = "10.1.2.3"
      port            = 6378
      auth_string     = "redis-auth"
      server_ca_certs = [{ cert = "CA", cert_serial_number = "1", create_time = "", expire_time = "", sha1_fingerprint = "" }]
    }
  }
  mock_resource "google_secret_manager_secret" {
    defaults = { id = "projects/test-project/secrets/mock" }
  }
  mock_resource "google_service_account" {
    defaults = {
      email  = "n8n-run@test-project.iam.gserviceaccount.com"
      member = "serviceAccount:n8n-run@test-project.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_compute_global_address" {
    defaults = { address = "203.0.113.10" }
  }
}

mock_provider "random" {}

variables {
  project_id        = "test-project"
  region            = "europe-west1"
  domain            = "n8n.example.com"
  image_tag         = "2.42.0-1a2b3c4d5e"
  ghcr_username     = "n8n-bot"
  ghcr_token_secret = "ghcr-token"
  network           = "projects/test-project/global/networks/default"
  subnetwork        = "projects/test-project/regions/europe-west1/subnetworks/default"
}

run "queue_mode_by_default" {
  command = apply

  assert {
    condition     = length(google_cloud_run_v2_worker_pool.worker) == 1 && length(google_redis_instance.n8n) == 1
    error_message = "Queue mode makes a worker pool and Memorystore."
  }
  assert {
    condition     = google_cloud_run_v2_service.main.template[0].scaling[0].min_instance_count == 1 && google_cloud_run_v2_service.main.template[0].scaling[0].max_instance_count == 2
    error_message = "The main service keeps one instance and grows to main_max_instances."
  }
  assert {
    condition     = google_cloud_run_v2_service.main.template[0].containers[0].resources[0].cpu_idle == false
    error_message = "n8n keeps its CPU between requests."
  }
  assert {
    condition     = google_cloud_run_v2_service.main.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" && google_cloud_run_v2_service.main.default_uri_disabled
    error_message = "The load balancer is the only way in."
  }
  assert {
    condition = alltrue([for pair in [
      "EXECUTIONS_MODE=queue",
      "N8N_MULTI_MAIN_SETUP_ENABLED=true",
      "N8N_WORKER_SERVER_ADDRESS=0.0.0.0",
      "QUEUE_BULL_REDIS_HOST=10.1.2.3",
      "QUEUE_BULL_REDIS_TLS=true",
      "N8N_AI_GATEWAY_BASE_URL=https://n8n.example.com/ai-gateway",
      "N8N_ENDPOINT_HEALTH=health",
      "DB_POSTGRESDB_HOST=/cloudsql/test-project:europe-west1:n8n-db",
      "N8N_OPEN_TRIGGERS_NEED_APPROVAL=true",
      "N8N_RUNNERS_BROKER_LISTEN_ADDRESS=127.0.0.1",
    ] : contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : "${env.name}=${env.value}" if env.value != null], pair)])
    error_message = "The main instances have the settings of the fork and of queue mode."
  }
  assert {
    condition = (
      contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : "${env.name}=${env.value}" if env.value != null], "NODE_EXTRA_CA_CERTS=/etc/n8n-redis-ca/ca.crt")
      && contains([for volume in google_cloud_run_v2_service.main.template[0].volumes : volume.name], "redis-ca")
      && !contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : env.name], "QUEUE_BULL_REDIS_TLS_VALIDATE_CERTIFICATE")
    )
    error_message = "n8n checks the certificate of Memorystore with the certificate authority of the instance."
  }
  assert {
    condition     = google_cloud_run_v2_worker_pool.worker[0].template[0].containers[0].args[1] == "--concurrency=10"
    error_message = "The workers start with n8n worker."
  }
  assert {
    condition     = google_cloud_run_v2_service.main.template[0].containers[0].image == "europe-west1-docker.pkg.dev/test-project/n8n-ghcr/sreent/n8n:2.42.0-1a2b3c4d5e"
    error_message = "The images come from the remote repository of ghcr.io."
  }
  assert {
    condition     = contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : env.name if env.value == null], "N8N_ENCRYPTION_KEY")
    error_message = "The encryption key comes from Secret Manager."
  }
  assert {
    condition     = length(google_compute_security_policy.n8n.rule) == 1
    error_message = "Without IP limits, Cloud Armor has only the default rule."
  }
}

run "single_mode" {
  command = apply

  variables {
    mode       = "single"
    network    = ""
    subnetwork = ""
  }

  assert {
    condition     = length(google_cloud_run_v2_worker_pool.worker) == 0 && length(google_redis_instance.n8n) == 0
    error_message = "Single mode has no workers and no Redis."
  }
  assert {
    condition     = google_cloud_run_v2_service.main.template[0].scaling[0].max_instance_count == 1
    error_message = "Single mode runs one instance."
  }
  assert {
    condition     = !contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : env.name], "EXECUTIONS_MODE")
    error_message = "Single mode runs the executions in the main instance."
  }
}

run "redis_without_certificate_check" {
  command = apply

  variables {
    redis_verify_certificate = false
  }

  assert {
    condition     = contains([for env in google_cloud_run_v2_worker_pool.worker[0].template[0].containers[0].env : "${env.name}=${env.value}" if env.value != null], "QUEUE_BULL_REDIS_TLS_VALIDATE_CERTIFICATE=false")
    error_message = "n8n encrypts the connection to Memorystore without a check of the certificate."
  }
  assert {
    condition     = length(google_secret_manager_secret.redis_ca) == 0 && !contains([for volume in google_cloud_run_v2_worker_pool.worker[0].template[0].volumes : volume.name], "redis-ca")
    error_message = "Without the check, n8n needs no certificate authority."
  }
}

run "ip_limits" {
  command = apply

  variables {
    webhook_allowed_ranges = ["10.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "100.64.0.0/10"]
    form_allowed_ranges    = ["10.0.0.0/8"]
  }

  assert {
    # Webhooks: two allow rules (four ranges, then one) and a deny rule. Forms: one and one.
    condition     = length(google_compute_security_policy.n8n.rule) == 6
    error_message = "Cloud Armor has the allow and deny rules of webhooks and forms."
  }
  assert {
    condition     = length([for rule in google_compute_security_policy.n8n.rule : rule if rule.action == "deny(403)"]) == 2
    error_message = "Webhooks and forms from other addresses get 403."
  }
  assert {
    condition     = length([for rule in google_compute_security_policy.n8n.rule : rule if strcontains(try(rule.match[0].expr[0].expression, ""), "inIpRange(origin.ip, '100.64.0.0/10')")]) == 1
    error_message = "The fifth range is in a rule of its own."
  }
}

run "existing_encryption_key" {
  command = apply
  # A state of its own: the module never deletes a key that it made.
  state_key = "existing_key"

  variables {
    encryption_key_secret = "vm-encryption-key"
  }

  assert {
    condition     = length(google_secret_manager_secret.encryption_key) == 0
    error_message = "An existing key needs no new secret."
  }
  assert {
    condition     = contains([for env in google_cloud_run_v2_service.main.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == "N8N_ENCRYPTION_KEY"], "vm-encryption-key")
    error_message = "n8n reads the existing key."
  }
}

run "queue_mode_needs_a_network" {
  command = plan

  variables {
    network    = ""
    subnetwork = ""
  }

  expect_failures = [google_redis_instance.n8n]
}
