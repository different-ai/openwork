# AWS root for a managed OpenWork deployment. It composes provider-neutral
# building blocks (contract, network, platform, health agent); other clouds
# provide their own root with the same contract inputs and outputs.

terraform {
  required_version = "= 1.16.5"
  # Configured by the runner: customer-owned bucket, S3-native state locking.
  backend "s3" {}
  required_providers {
    aws     = { source = "hashicorp/aws", version = "= 5.100.0" }
    random  = { source = "hashicorp/random", version = "= 3.7.2" }
    archive = { source = "hashicorp/archive", version = "= 2.8.1" }
  }
}

# ---- Contract inputs (identical on every cloud) ----
variable "deployment_id" { type = string }
variable "domain_name" { type = string }
variable "owner_email" { type = string }
variable "openwork_version" { type = string }
variable "control_plane_origin" { type = string }
variable "size" {
  type    = string
  default = "small"
}

# ---- AWS inputs ----
variable "region" { type = string }
variable "account_id" { type = string }
variable "route53_zone_id" { type = string }
variable "test_disposable" {
  description = "Validation only: allow deleting the database without a final snapshot."
  type        = bool
  default     = false
}

module "contract" {
  source               = "../../contract"
  deployment_id        = var.deployment_id
  domain_name          = var.domain_name
  owner_email          = var.owner_email
  openwork_version     = var.openwork_version
  control_plane_origin = var.control_plane_origin
  size                 = var.size
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "OpenWork", Deployment = var.deployment_id }
  }
}

locals {
  # Capacity profiles map the neutral size to AWS instance choices.
  profiles = {
    small = {
      database = { instance_class = "db.t4g.micro", allocated_storage_gb = 20, max_allocated_storage = 100 }
      den_api  = { cpu = 1024, memory = 2048, desired_count = 1 }
      den_web  = { cpu = 512, memory = 1024, desired_count = 1 }
    }
  }
  profile = local.profiles[var.size]
}

module "network" {
  source = "./modules/network"
  name   = module.contract.name
}

module "platform" {
  source = "../../../terraform/modules/openwork-aws-ecs"

  name             = module.contract.name
  openwork_version = var.openwork_version
  owner_emails     = [var.owner_email]
  org_name         = "OpenWork"

  vpc_id              = module.network.vpc_id
  alb_subnet_ids      = module.network.public_subnet_ids
  service_subnet_ids  = module.network.private_subnet_ids
  database_subnet_ids = module.network.private_subnet_ids
  assign_public_ip    = false

  domain_name     = var.domain_name
  route53_zone_id = var.route53_zone_id

  wait_for_steady_state = true
  # The first administrator signs in with the one-time setup code; configure
  # SMTP and SSO after setup.
  require_email_verification = false

  den_api = local.profile.den_api
  den_web = local.profile.den_web
  database = merge(local.profile.database, {
    backup_retention_days = 7
    deletion_protection   = !var.test_disposable
    skip_final_snapshot   = var.test_disposable
    apply_immediately     = true
  })
}

module "health_agent" {
  source               = "./modules/health-agent"
  name                 = module.contract.name
  compact_id           = module.contract.compact_id
  deployment_id        = var.deployment_id
  control_plane_origin = var.control_plane_origin
  interval_minutes     = module.contract.health_interval_minutes
  web_url              = module.platform.web_url
  api_url              = module.platform.api_url
  cluster_name         = module.platform.cluster_name
  cluster_arn          = module.platform.cluster_arn
  service_names        = module.platform.service_names
  target_group_arns    = module.platform.target_group_arns
  database_identifier  = module.platform.database_identifier
  certificate_arn      = module.platform.certificate_arn
}

# ---- Contract outputs (identical on every cloud) ----
output "web_url" { value = module.platform.web_url }
output "api_url" { value = module.platform.api_url }
output "setup_url" { value = module.platform.setup_url }
output "health_agent" { value = module.health_agent.function_name }

# ---- AWS outputs used by the runner's verification ----
output "cluster_name" { value = module.platform.cluster_name }
output "service_names" { value = module.platform.service_names }
output "secret_arn" { value = module.platform.secret_arn }
