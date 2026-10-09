terraform {
  required_version = "= 1.9.8"
  backend "s3" {}
  required_providers {
    aws    = { source = "hashicorp/aws", version = "= 5.100.0" }
    random = { source = "hashicorp/random", version = "= 3.7.2" }
  }
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Project = "OpenWork", Deployment = var.deployment_id }
  }
}
variable "region" { type = string }
variable "account_id" { type = string }
variable "deployment_id" { type = string }
variable "domain_name" { type = string }
variable "route53_zone_id" { type = string }
variable "owner_email" { type = string }
variable "openwork_version" { type = string }
variable "test_disposable" {
  type    = bool
  default = false
}
data "aws_availability_zones" "available" { state = "available" }
locals {
  name = "ow-${substr(replace(var.deployment_id, "-", ""), 0, 12)}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}
resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}
resource "aws_internet_gateway" "this" { vpc_id = aws_vpc.this.id }
resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index)
}
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, 10 + count.index)
}
resource "aws_eip" "nat" { domain = "vpc" }
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
module "openwork" {
  source                     = "../../terraform/modules/openwork-aws-ecs"
  name                       = local.name
  openwork_version           = var.openwork_version
  owner_emails               = [var.owner_email]
  org_name                   = "OpenWork"
  vpc_id                     = aws_vpc.this.id
  alb_subnet_ids             = aws_subnet.public[*].id
  service_subnet_ids         = aws_subnet.private[*].id
  database_subnet_ids        = aws_subnet.private[*].id
  assign_public_ip           = false
  domain_name                = var.domain_name
  route53_zone_id            = var.route53_zone_id
  wait_for_steady_state      = true
  require_email_verification = false
  database = {
    deletion_protection = !var.test_disposable
    skip_final_snapshot = var.test_disposable
    apply_immediately   = true
  }
  depends_on = [aws_route_table_association.private]
}
output "web_url" { value = module.openwork.web_url }
output "api_url" { value = module.openwork.api_url }
output "setup_url" { value = module.openwork.setup_url }
output "cluster_name" { value = module.openwork.cluster_name }
output "service_names" { value = module.openwork.service_names }
output "secret_arn" { value = module.openwork.secret_arn }
output "log_groups" { value = module.openwork.log_groups }
