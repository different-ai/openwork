# AWS implementation of the "health agent" building block. A scheduled,
# read-only function checks the installation and reports an allowlisted status
# summary to the control plane over outbound HTTPS. It authenticates with its
# own role identity (signed STS request), so no OpenWork credential is stored.

variable "name" { type = string }
variable "compact_id" { type = string }
variable "deployment_id" { type = string }
variable "control_plane_origin" { type = string }
variable "interval_minutes" { type = number }
variable "web_url" { type = string }
variable "api_url" { type = string }
variable "cluster_name" { type = string }
variable "cluster_arn" { type = string }
variable "service_names" { type = map(string) }
variable "target_group_arns" { type = map(string) }
variable "database_identifier" { type = string }
variable "certificate_arn" { type = string }

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  # The control plane accepts reports only from exactly this role.
  function_name = "openwork-${var.compact_id}-health"
  arn_prefix    = "arn:${data.aws_partition.current.partition}"
  account       = data.aws_caller_identity.current.account_id
  region        = data.aws_region.current.name
}

data "archive_file" "agent" {
  type        = "zip"
  source_file = "${path.module}/../../../health/health_agent.py"
  output_path = "${path.root}/build/health-agent.zip"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "agent" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "agent" {
  statement {
    sid       = "ReadServices"
    actions   = ["ecs:DescribeServices"]
    resources = [for service in values(var.service_names) : "${local.arn_prefix}:ecs:${local.region}:${local.account}:service/${var.cluster_name}/${service}"]
  }
  statement {
    sid       = "ReadDatabase"
    actions   = ["rds:DescribeDBInstances"]
    resources = ["${local.arn_prefix}:rds:${local.region}:${local.account}:db:${var.database_identifier}"]
  }
  statement {
    sid       = "ReadCertificate"
    actions   = ["acm:DescribeCertificate"]
    resources = [var.certificate_arn]
  }
  statement {
    # These read APIs do not support resource-level permissions.
    sid       = "ReadHealthWithoutResourceScoping"
    actions   = ["elasticloadbalancing:DescribeTargetHealth", "ecs:DescribeTaskDefinition", "cloudwatch:GetMetricStatistics"]
    resources = ["*"]
  }
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.agent.arn}:*"]
  }
}

resource "aws_iam_role_policy" "agent" {
  name   = "read-openwork-health"
  role   = aws_iam_role.agent.id
  policy = data.aws_iam_policy_document.agent.json
}

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "agent" {
  function_name    = local.function_name
  role             = aws_iam_role.agent.arn
  runtime          = "python3.12"
  handler          = "health_agent.handler"
  filename         = data.archive_file.agent.output_path
  source_code_hash = data.archive_file.agent.output_base64sha256
  timeout          = 60
  memory_size      = 256
  architectures    = ["arm64"]
  environment {
    variables = {
      CONTROL_PLANE_ORIGIN = var.control_plane_origin
      DEPLOYMENT_ID        = var.deployment_id
      WEB_URL              = var.web_url
      API_URL              = var.api_url
      CLUSTER_NAME         = var.cluster_name
      SERVICE_NAMES        = jsonencode(var.service_names)
      TARGET_GROUP_ARNS    = jsonencode(var.target_group_arns)
      DATABASE_IDENTIFIER  = var.database_identifier
      CERTIFICATE_ARN      = var.certificate_arn
    }
  }
  depends_on = [aws_iam_role_policy.agent, aws_cloudwatch_log_group.agent]
}

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = local.function_name
  description         = "Report OpenWork health to the control plane."
  schedule_expression = "rate(${var.interval_minutes} minutes)"
}

resource "aws_cloudwatch_event_target" "agent" {
  rule = aws_cloudwatch_event_rule.schedule.name
  arn  = aws_lambda_function.agent.arn
}

resource "aws_lambda_permission" "schedule" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}

output "function_name" { value = aws_lambda_function.agent.function_name }
output "role_name" { value = aws_iam_role.agent.name }
