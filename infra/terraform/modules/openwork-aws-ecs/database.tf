# RDS MySQL ------------------------------------------------------------------

resource "random_password" "db" {
  count = var.create_database ? 1 : 0

  length  = 32
  special = false # embedded in DATABASE_URL
}

resource "aws_db_subnet_group" "this" {
  count = var.create_database ? 1 : 0

  name_prefix = "${var.name}-den-"
  subnet_ids  = var.database_subnet_ids
  tags        = var.tags
}

resource "aws_security_group" "db" {
  count = var.create_database ? 1 : 0

  name_prefix = "${var.name}-db-"
  description = "OpenWork RDS MySQL"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  count = var.create_database ? 1 : 0

  security_group_id            = aws_security_group.db[0].id
  from_port                    = 3306
  to_port                      = 3306
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_db_instance" "this" {
  count = var.create_database ? 1 : 0

  identifier_prefix = "${var.name}-den-"
  engine            = "mysql"
  engine_version    = var.database.engine_version
  instance_class    = var.database.instance_class

  db_name  = "openwork_den"
  username = "openwork"
  password = random_password.db[0].result
  port     = 3306

  allocated_storage     = var.database.allocated_storage_gb
  max_allocated_storage = var.database.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  vpc_security_group_ids = [aws_security_group.db[0].id]
  publicly_accessible    = false
  multi_az               = var.database.multi_az

  backup_retention_period   = var.database.backup_retention_days
  deletion_protection       = var.database.deletion_protection
  skip_final_snapshot       = var.database.skip_final_snapshot
  final_snapshot_identifier = var.database.skip_final_snapshot ? null : "${var.name}-den-final"
  copy_tags_to_snapshot     = true
  apply_immediately         = var.database.apply_immediately

  auto_minor_version_upgrade = true
  tags                       = var.tags

  lifecycle {
    precondition {
      condition     = length(var.database_subnet_ids) >= 2
      error_message = "database_subnet_ids needs subnets in at least two AZs when create_database = true."
    }
  }
}

# ElastiCache Redis (optional) -----------------------------------------------

resource "aws_elasticache_subnet_group" "this" {
  count = var.create_redis ? 1 : 0

  name       = "${var.name}-den"
  subnet_ids = var.database_subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "redis" {
  count = var.create_redis ? 1 : 0

  name_prefix = "${var.name}-redis-"
  description = "OpenWork ElastiCache"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-redis" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  count = var.create_redis ? 1 : 0

  security_group_id            = aws_security_group.redis[0].id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_elasticache_replication_group" "this" {
  count = var.create_redis ? 1 : 0

  replication_group_id       = "${var.name}-den"
  description                = "OpenWork Den cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this[0].name
  security_group_ids         = [aws_security_group.redis[0].id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  apply_immediately          = true
  tags                       = var.tags
}
