output "namespace" {
  description = "Namespace that holds the release."
  value       = var.namespace
}

output "release_name" {
  description = "Helm release name."
  value       = helm_release.openwork.name
}

output "chart_version" {
  description = "Deployed openwork-ee chart version."
  value       = helm_release.openwork.version
}

output "web_url" {
  description = "Den web URL. First sign-in happens at <web_url>/setup."
  value       = trimsuffix(var.web_origin, "/")
}

output "setup_url" {
  description = "One-time first-administrator setup page."
  value       = "${trimsuffix(var.web_origin, "/")}/setup"
}

output "secret_name" {
  description = "Secret the pods read, whichever owner created it."
  value       = local.secret_owner == "chart" ? null : local.secret_name
}

output "services" {
  description = "In-cluster Service names, for a custom load balancer or port-forward."
  value = {
    den_api = "${local.chart_fullname}-den-api"
    den_web = "${local.chart_fullname}-den-web"
  }
}
