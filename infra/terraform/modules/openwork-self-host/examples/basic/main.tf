terraform {
  required_version = ">= 1.5.0"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.12.0, < 3.0.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.24.0"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kubeconfig_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kubeconfig_context
  }
}

module "openwork" {
  source = "../.."

  openwork_version = var.openwork_version
  web_origin       = "https://${var.web_host}"
  database_url     = var.database_url

  org_name                     = var.org_name
  owner_emails                 = var.owner_emails
  initial_admin_bootstrap_code = var.initial_admin_bootstrap_code

  email_from = var.email_from
  smtp       = var.smtp

  ingress = {
    class_name      = var.ingress_class_name
    web_host        = var.web_host
    tls_secret_name = var.tls_secret_name
  }
}

output "setup_url" {
  value = module.openwork.setup_url
}

output "services" {
  value = module.openwork.services
}
