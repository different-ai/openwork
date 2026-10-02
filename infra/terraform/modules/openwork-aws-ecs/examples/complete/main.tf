# Self-contained test stack: a new VPC (no NAT gateway, to keep it cheap) and
# the module. Supply a hostname plus either an ACM certificate you validated
# yourself or a Route 53 zone the module can use. For production, pass your
# own VPC and subnets instead.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "openwork", Stack = var.name }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, 10 + count.index)
  tags              = { Name = "${var.name}-db-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

module "openwork" {
  source = "../.."

  name             = var.name
  openwork_version = var.openwork_version
  owner_emails     = var.owner_emails
  org_name         = var.org_name

  vpc_id              = aws_vpc.this.id
  alb_subnet_ids      = aws_subnet.public[*].id
  service_subnet_ids  = aws_subnet.public[*].id # no NAT: tasks get public IPs
  assign_public_ip    = true
  database_subnet_ids = aws_subnet.database[*].id

  domain_name     = var.domain_name
  certificate_arn = var.certificate_arn
  route53_zone_id = var.route53_zone_id

  create_redis    = var.create_redis
  ecs_cluster_arn = var.ecs_cluster_arn

  # Disposable test stack: allow a clean destroy.
  database = {
    deletion_protection = false
    skip_final_snapshot = true
    apply_immediately   = true
  }
  secret_recovery_window_days = 0
  log_retention_days          = 7
}

output "web_url" { value = module.openwork.web_url }
output "api_url" { value = module.openwork.api_url }
output "setup_url" { value = module.openwork.setup_url }
output "bootstrap_code" {
  value     = module.openwork.bootstrap_code
  sensitive = true
}
output "cluster_name" { value = module.openwork.cluster_name }
output "alb_dns_name" { value = module.openwork.alb_dns_name }
output "log_groups" { value = module.openwork.log_groups }
