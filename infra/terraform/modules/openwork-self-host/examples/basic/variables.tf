variable "kubeconfig_path" {
  description = "kubeconfig for the target cluster."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "kubeconfig context. Empty uses the current context."
  type        = string
  default     = ""
}

variable "openwork_version" {
  description = "Published OpenWork release."
  type        = string
}

variable "web_host" {
  description = "Public hostname for OpenWork, e.g. openwork.example.com. DNS must point at the ingress controller."
  type        = string
}

variable "database_url" {
  description = "mysql:// URL for a MySQL 8 database named openwork_den (or similar)."
  type        = string
  sensitive   = true
}

variable "org_name" {
  type    = string
  default = "OpenWork"
}

variable "owner_emails" {
  type = list(string)
}

variable "initial_admin_bootstrap_code" {
  type      = string
  sensitive = true
}

variable "email_from" {
  type    = string
  default = ""
}

variable "smtp" {
  type = object({
    host     = optional(string, "")
    port     = optional(number, 587)
    username = optional(string, "")
    password = optional(string, "")
    secure   = optional(bool, false)
  })
  default   = {}
  sensitive = true
}

variable "ingress_class_name" {
  description = "IngressClass of an installed controller, e.g. nginx or webapprouting.kubernetes.azure.com."
  type        = string
  default     = "nginx"
}

variable "tls_secret_name" {
  description = "Existing kubernetes.io/tls Secret covering web_host (for example from cert-manager)."
  type        = string
  default     = "openwork-ee-tls"
}
