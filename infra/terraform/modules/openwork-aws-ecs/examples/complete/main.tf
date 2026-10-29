# Self-contained test stack: a new VPC and the module. By default tasks run in
# public subnets with public IPs (no NAT gateway, to keep it cheap); set
# private_subnets = true to run them in private subnets behind a NAT gateway,
# as in production. Supply a hostname plus either an ACM certificate you
# validated yourself or a Route 53 zone the module can use. For production,
# pass your own VPC and subnets instead.

terraform {
  required_version = ">= 1.11, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
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

# Private task subnets: outbound traffic (image pulls from ghcr.io, model
# providers, email) leaves through one NAT gateway in the first public subnet.
resource "aws_subnet" "private" {
  count             = var.private_subnets ? 2 : 0
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, 20 + count.index)
  tags              = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  count  = var.private_subnets ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count         = var.private_subnets ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.private_subnets ? 1 : 0
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[0].id
  }
}

resource "aws_route_table_association" "private" {
  count          = var.private_subnets ? 2 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

module "openwork" {
  source     = "../.."
  depends_on = [aws_route_table_association.public, aws_route_table_association.private]

  name                = var.name
  openwork_version    = var.openwork_version
  den_api_image       = var.den_api_image
  den_web_image       = var.den_web_image
  write_only_secrets  = var.write_only_secrets
  secret_values_wo    = var.secret_values_wo
  service_name_prefix = "${var.name}-"
  owner_emails        = var.owner_emails
  org_name            = var.org_name

  vpc_id         = aws_vpc.this.id
  alb_subnet_ids = aws_subnet.public[*].id
  # Private subnets reach the internet through the NAT gateway; public ones
  # need public IPs on the tasks.
  service_subnet_ids  = var.private_subnets ? aws_subnet.private[*].id : aws_subnet.public[*].id
  assign_public_ip    = !var.private_subnets
  database_subnet_ids = aws_subnet.database[*].id

  domain_name     = var.domain_name
  certificate_arn = var.certificate_arn
  route53_zone_id = var.route53_zone_id

  create_redis          = var.create_redis
  ecs_cluster_arn       = var.ecs_cluster_arn
  wait_for_steady_state = var.wait_for_steady_state

  den_api = { desired_count = var.den_api_desired_count }

  email_from = var.email_from
  smtp       = var.smtp

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
output "alb_arn" { value = module.openwork.alb_arn }
output "nat_public_ip" { value = one(aws_eip.nat[*].public_ip) }
output "log_groups" { value = module.openwork.log_groups }
output "migration_result" { value = module.openwork.migration_result }
output "migration_step_identifier" { value = module.openwork.migration_step_identifier }
output "database_identifier" { value = module.openwork.database_identifier }
output "target_group_arns" { value = module.openwork.target_group_arns }
output "service_names" { value = module.openwork.service_names }
