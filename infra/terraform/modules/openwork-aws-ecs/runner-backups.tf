# The single runner's SQLite database and delivered files live on EFS. Back up
# only that filesystem; this role cannot restore, delete or read file contents.
# AWS Backup encrypts the vault with its AWS-managed KMS key by default.
resource "aws_backup_vault" "runner" {
  count = local.runner_count

  name          = "${var.name}-runner"
  force_destroy = false
  tags          = var.tags
}

resource "aws_iam_role" "runner_backup" {
  count = local.runner_count

  name = "${var.name}-runner-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "backup.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = split(":", aws_iam_role.execution.arn)[4] }
        ArnLike      = { "aws:SourceArn" = "arn:${split(":", aws_iam_role.execution.arn)[1]}:backup:${local.region}:${split(":", aws_iam_role.execution.arn)[4]}:*" }
      }
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "runner_backup" {
  count = local.runner_count

  name = "backup-runner-storage"
  role = aws_iam_role.runner_backup[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["elasticfilesystem:Backup", "elasticfilesystem:DescribeTags"]
        Resource = aws_efs_file_system.agents[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["backup:DescribeBackupVault"]
        Resource = aws_backup_vault.runner[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = distinct([aws_efs_file_system.agents[0].kms_key_id, aws_backup_vault.runner[0].kms_key_arn])
      },
      {
        Effect    = "Allow"
        Action    = ["kms:CreateGrant"]
        Resource  = distinct([aws_efs_file_system.agents[0].kms_key_id, aws_backup_vault.runner[0].kms_key_arn])
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
    ]
  })
}

resource "aws_backup_plan" "runner" {
  count = local.runner_count

  name = "${var.name}-runner"
  tags = var.tags
  rule {
    rule_name         = "daily-runner-storage"
    target_vault_name = aws_backup_vault.runner[0].name
    schedule          = "cron(0 5 * * ? *)"
    start_window      = 60
    completion_window = 180
    lifecycle {
      delete_after = 7
    }
  }
}

resource "aws_backup_selection" "runner" {
  count = local.runner_count

  name         = "${var.name}-runner"
  plan_id      = aws_backup_plan.runner[0].id
  iam_role_arn = aws_iam_role.runner_backup[0].arn
  resources    = [aws_efs_file_system.agents[0].arn]
  depends_on   = [aws_iam_role_policy.runner_backup]
}
