variable "subscription_id" {
  type = string
}

variable "resource_group_name" {
  description = "Existing resource group; everything is created inside it."
  type        = string
}

variable "location" {
  description = "Region for new resources. Empty uses the existing resource group's location."
  type        = string
  default     = ""
}

variable "name" {
  type    = string
  default = "openwork-test"
}

variable "openwork_version" {
  type    = string
  default = "0.18.58"
}

variable "owner_emails" {
  type = list(string)
}

variable "org_name" {
  type    = string
  default = "OpenWork"
}

variable "database_name" {
  description = "Managed database schema name. Changing it replaces the schema; preserve the existing name on upgrades."
  type        = string
  default     = "openwork_den"
}

variable "den_api_image" {
  description = "Optional full API image pinned with @sha256:digest."
  type        = string
  default     = ""
}

variable "den_web_image" {
  description = "Optional full web image pinned with @sha256:digest."
  type        = string
  default     = ""
}

variable "den_api_replicas" {
  description = "API-only replica count; migration remains singleton."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Azure deletion lock on MySQL. Disable explicitly for disposable tests."
  type        = bool
  default     = true
}

variable "private_database" {
  description = "Put MySQL in a delegated subnet with a private DNS zone. false uses public access limited to Azure services (cheaper to tear down, test only)."
  type        = bool
  default     = true
}

variable "container_app_environment_id" {
  description = "Existing Container Apps environment to deploy into. Empty creates one in the new VNet."
  type        = string
  default     = ""
}
