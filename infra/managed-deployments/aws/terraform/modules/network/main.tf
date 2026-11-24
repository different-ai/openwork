# AWS implementation of the "network" building block: a dedicated VPC with
# public subnets for the load balancer and private subnets for services and the
# database. Equivalent blocks on other clouds expose the same outputs shape.

variable "name" { type = string }
variable "cidr_block" {
  type    = string
  default = "10.42.0.0/16"
}
variable "single_nat_gateway" {
  description = "One NAT gateway (lower cost) instead of one per availability zone."
  type        = bool
  default     = true
}

data "aws_availability_zones" "available" { state = "available" }

locals {
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)
  nat_keys = var.single_nat_gateway ? [0] : [0, 1]
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, count.index)
  tags              = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, 10 + count.index)
  tags              = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  for_each = toset([for key in local.nat_keys : tostring(key)])
  domain   = "vpc"
  tags     = { Name = "${var.name}-nat-${each.key}" }
}

resource "aws_nat_gateway" "this" {
  for_each      = aws_eip.nat
  allocation_id = each.value.id
  subnet_id     = aws_subnet.public[tonumber(each.key)].id
  tags          = { Name = "${var.name}-nat-${each.key}" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? "0" : tostring(count.index)].id
  }
  tags = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

output "vpc_id" { value = aws_vpc.this.id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" {
  value      = aws_subnet.private[*].id
  depends_on = [aws_route_table_association.private]
}
