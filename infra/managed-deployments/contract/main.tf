# Provider-neutral deployment contract.
#
# Every cloud root (aws/, and later azure/ and gcp/) calls this module first
# with the same inputs and returns the same root outputs. Cloud-specific values
# (AWS account, Azure subscription, GCP project, DNS zone ids) are separate root
# variables and never part of this contract. See ../README.md.

terraform {
  required_version = ">= 1.11.0"
}

variable "deployment_id" {
  description = "Hosted OpenWork deployment id (UUID)."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.deployment_id))
    error_message = "deployment_id must be a lowercase UUID."
  }
}

variable "domain_name" {
  description = "Hostname for OpenWork web; the API is served at api.<domain_name>."
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name)) && length(var.domain_name) <= 200
    error_message = "domain_name must be a lowercase DNS hostname."
  }
}

variable "owner_email" {
  description = "First administrator email."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "openwork_version" {
  description = "Published OpenWork image version."
  type        = string
  validation {
    condition     = can(regex("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$", var.openwork_version))
    error_message = "openwork_version must be an exact published version, never latest."
  }
}

variable "control_plane_origin" {
  description = "Hosted OpenWork API origin that receives outbound health reports."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", var.control_plane_origin))
    error_message = "control_plane_origin must be an https origin without a path."
  }
}

variable "size" {
  description = "Capacity profile. Each cloud maps it to its own instance sizes."
  type        = string
  default     = "small"
  validation {
    condition     = contains(["small"], var.size)
    error_message = "Only the small profile is available."
  }
}

locals {
  compact_id = replace(var.deployment_id, "-", "")
}

output "name" {
  description = "Short resource name prefix, unique per deployment and valid on every cloud."
  value       = "ow-${substr(local.compact_id, 0, 12)}"
}

output "compact_id" {
  description = "Deployment id without dashes, for identity names verified by the control plane."
  value       = local.compact_id
}

output "labels" {
  description = "Tags (AWS) / labels (GCP) / tags (Azure) applied to every resource."
  value       = { project = "openwork", openwork-deployment = var.deployment_id }
}

output "web_url" { value = "https://${var.domain_name}" }
output "api_url" { value = "https://api.${var.domain_name}" }
output "health_interval_minutes" { value = 5 }
