# Minimal legacy state shapes, not a live historical installer. Provider mocks
# verify native address/value preservation; they do not emulate SDK ForceNew.
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.69" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}
resource "aws_ecs_task_definition" "api" {
  family                = "openwork-den-api"
  skip_destroy          = false
  container_definitions = jsonencode([{ name = "den-api", image = "example.test/api:legacy", essential = true }])
}
resource "aws_ecs_task_definition" "web" {
  family                = "openwork-den-web"
  skip_destroy          = false
  container_definitions = jsonencode([{ name = "den-web", image = "example.test/web:legacy", essential = true }])
}
# Both historical address shapes are deliberately present in this synthetic
# state fixture to verify forget and move independently in one native plan.
resource "aws_ecs_task_definition" "api_ca" {
  family                = "openwork-den-api"
  skip_destroy          = true
  container_definitions = jsonencode([{ name = "migrate", image = "example.test/api:legacy", essential = true }])
}
resource "aws_ecs_task_definition" "web_ca" {
  family                = "openwork-den-web"
  skip_destroy          = true
  container_definitions = jsonencode([{ name = "den-web", image = "example.test/web:legacy", essential = true }])
}
resource "random_password" "better_auth" {
  length  = 48
  special = false
}
resource "random_password" "db_encryption" {
  length  = 48
  special = false
}
resource "random_password" "bootstrap_code" {
  length  = 24
  special = false
}
resource "random_password" "db" {
  count   = 1
  length  = 32
  special = false
}
resource "aws_secretsmanager_secret" "app" {
  name_prefix             = "openwork-den-"
  description             = "OpenWork Den secrets (openwork)"
  recovery_window_in_days = 7
}
locals {
  seed = {
    DATABASE_URL                     = "mysql://openwork:${random_password.db[0].result}@db.example.test:3306/openwork_den?sslaccept=accept"
    BETTER_AUTH_SECRET               = random_password.better_auth.result
    DEN_DB_ENCRYPTION_KEY            = random_password.db_encryption.result
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = random_password.bootstrap_code.result
  }
}
resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.seed)
}
resource "aws_secretsmanager_secret_version" "tls" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(merge(local.seed, {
    DATABASE_URL = replace(local.seed.DATABASE_URL, "sslaccept=accept", "sslaccept=strict")
  }))
}
resource "aws_db_subnet_group" "this" {
  count       = 1
  name_prefix = "openwork-den-"
  subnet_ids  = ["subnet-a", "subnet-b"]
}
resource "aws_security_group" "db" {
  count       = 1
  name_prefix = "openwork-db-"
  description = "OpenWork RDS MySQL"
  vpc_id      = "vpc-test"
  tags        = { Name = "openwork-db" }
  lifecycle { create_before_destroy = true }
}
resource "aws_db_instance" "this" {
  count                      = 1
  identifier_prefix          = "openwork-den-"
  engine                     = "mysql"
  engine_version             = "8.4"
  instance_class             = "db.t4g.micro"
  db_name                    = "openwork_den"
  username                   = "openwork"
  password                   = random_password.db[0].result
  port                       = 3306
  allocated_storage          = 20
  max_allocated_storage      = 100
  storage_type               = "gp3"
  storage_encrypted          = true
  db_subnet_group_name       = aws_db_subnet_group.this[0].name
  vpc_security_group_ids     = [aws_security_group.db[0].id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = 7
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "openwork-den-final"
  copy_tags_to_snapshot      = true
  apply_immediately          = false
  auto_minor_version_upgrade = true
}
resource "aws_ecs_cluster" "this" {
  count = 1
  name  = "openwork-den"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_lb" "this" {
  count              = 1
  name               = "openwork-den"
  internal           = false
  load_balancer_type = "application"
  subnets            = ["subnet-a", "subnet-b"]
}
