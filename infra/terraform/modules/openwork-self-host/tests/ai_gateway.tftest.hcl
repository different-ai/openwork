# Offline wrapper checks. Helm and Kubernetes are mocked; no cluster is used.
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {
  mock_resource "random_password" { defaults = { result = "SyntheticPreservedKey0123456789abcdef" } }
}
variables {
  openwork_version             = "0.0.0-test"
  web_origin                   = "https://openwork.example.com"
  database_url                 = "mysql://app:fixture@mysql.example.com/openwork_den?sslaccept=strict"
  owner_emails                 = ["admin@example.com"]
  initial_admin_bootstrap_code = "SyntheticBootstrap012345"
  ingress                      = { web_host = "openwork.example.com", tls_secret_name = "openwork-tls" }
}
run "off_by_default" {
  command = apply # Mock state only; no chart download or cluster connection.
  assert {
    condition     = length(kubernetes_ingress_v1.ai_gateway) == 0 && output.ai_gateway_url == null && length(keys(local.ai_gateway_values)) == 0 && length(helm_release.openwork.values) == 2
    error_message = "Default adds no ingress, Gateway values or public URL."
  }
}
run "enabled_chart_and_ingress" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
  }
  assert {
    condition     = yamldecode(helm_release.openwork.values[2]).gateway.enabled && yamldecode(helm_release.openwork.values[2]).config.internal.gatewayProxyBaseUrl == "http://openwork-ee-inference:8791" && yamldecode(helm_release.openwork.values[2]).config.public.gatewayPublicBaseUrl == "https://models.example.com" && output.ai_gateway_url == "https://models.example.com"
    error_message = "The wrapper delegates enabling and shared env/secrets to the existing chart; private service and desktop origins differ."
  }
  assert {
    condition     = kubernetes_ingress_v1.ai_gateway[0].spec[0].rule[0].http[0].path[0].backend[0].service[0].name == "openwork-ee-inference" && kubernetes_ingress_v1.ai_gateway[0].spec[0].tls[0].secret_name == "openwork-tls" && kubernetes_ingress_v1.ai_gateway[0].spec[0].rule[0].host == "models.example.com" && random_password.den_db_encryption_key[0].result == "SyntheticPreservedKey0123456789abcdef"
    error_message = "One TLS ingress targets the chart's existing service; encryption generator/state unchanged."
  }
}
run "preserves_advanced_values_interface" {
  command = plan
  variables { extra_helm_values = { gateway = { enabled = true } } }
  assert {
    condition     = yamldecode(helm_release.openwork.values[1]).gateway.enabled && length(helm_release.openwork.values) == 2
    error_message = "False first-class default does not override existing advanced gateway.enabled installs."
  }
}
run "operator_managed_https_routing" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    ingress                = { enabled = false }
  }
  assert {
    condition     = length(kubernetes_ingress_v1.ai_gateway) == 0 && yamldecode(helm_release.openwork.values[2]).gateway.enabled && output.ai_gateway_url == "https://models.example.com"
    error_message = "External routing creates no ingress but still enables the chart and reports the required HTTPS origin."
  }
}
run "rejects_shared_host_without_managed_ingress" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "openwork.example.com"
    ingress                = { enabled = false }
  }
  expect_failures = [helm_release.openwork]
}
run "missing_domain" {
  command = plan
  variables { ai_gateway_enabled = true }
  expect_failures = [helm_release.openwork]
}
run "conflicting_values" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    extra_helm_values      = { gateway = { enabled = false } }
  }
  expect_failures = [helm_release.openwork]
}
run "missing_tls" {
  command = plan
  variables {
    ai_gateway_enabled     = true
    ai_gateway_domain_name = "models.example.com"
    ingress                = { web_host = "openwork.example.com" }
  }
  expect_failures = [kubernetes_ingress_v1.ai_gateway]
}
