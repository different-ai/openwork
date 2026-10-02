variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  type    = string
  default = "openwork-test"
}

variable "openwork_version" {
  type    = string
  default = "0.18.54"
}

variable "owner_emails" {
  type = list(string)
}

variable "org_name" {
  type    = string
  default = "OpenWork"
}

variable "create_redis" {
  type    = bool
  default = false
}

variable "domain_name" {
  description = "Hostname for Den web; api.<domain_name> is used for the API."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate in var.region for both hostnames. Empty needs route53_zone_id."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "ecs_cluster_arn" {
  description = "Existing ECS cluster to deploy into. Empty creates one."
  type        = string
  default     = ""
}
