# Minimal pre-retention task-definition state. Providers are mocked by the test.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.69" }
  }
}
variable "name" { type = string }
variable "headless_runner_image" { type = string }
variable "workbot_image" { type = string }
variable "ai_gateway_image" { type = string }
variable "legacy_runner_enabled" {
  type    = bool
  default = true
}
variable "legacy_workbot_enabled" {
  type    = bool
  default = true
}
variable "legacy_ai_gateway_enabled" {
  type    = bool
  default = true
}

resource "aws_ecs_task_definition" "runner" {
  count                    = var.legacy_runner_enabled ? 1 : 0
  family                   = "${var.name}-headless-runner"
  skip_destroy             = false
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  container_definitions    = jsonencode([{ name = "headless-runner", image = var.headless_runner_image, essential = true }])
}
resource "aws_ecs_task_definition" "workbot" {
  count                    = var.legacy_workbot_enabled ? 1 : 0
  family                   = "${var.name}-workbot"
  skip_destroy             = false
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  container_definitions    = jsonencode([{ name = "workbot", image = var.workbot_image, essential = true }])
}
resource "aws_ecs_task_definition" "ai_gateway" {
  count                    = var.legacy_ai_gateway_enabled ? 1 : 0
  family                   = "${var.name}-ai-gateway"
  skip_destroy             = false
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  container_definitions    = jsonencode([{ name = "ai-gateway", image = var.ai_gateway_image, essential = true }])
}

resource "aws_ecs_service" "runner" {
  count                              = var.legacy_runner_enabled ? 1 : 0
  name                               = "headless-runner"
  cluster                            = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den"
  task_definition                    = aws_ecs_task_definition.runner[0].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  network_configuration {
    subnets = ["subnet-a", "subnet-b"]
  }
}
resource "aws_ecs_service" "workbot" {
  count           = var.legacy_workbot_enabled ? 1 : 0
  name            = "workbot"
  cluster         = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den"
  task_definition = aws_ecs_task_definition.workbot[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets = ["subnet-a", "subnet-b"]
  }
}
resource "aws_ecs_service" "ai_gateway" {
  count           = var.legacy_ai_gateway_enabled ? 1 : 0
  name            = "ai-gateway"
  cluster         = "arn:aws:ecs:us-east-1:123456789012:cluster/openwork-den"
  task_definition = aws_ecs_task_definition.ai_gateway[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets = ["subnet-a", "subnet-b"]
  }
}
