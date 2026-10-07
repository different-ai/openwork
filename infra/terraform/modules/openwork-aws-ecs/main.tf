locals {
  # Den derives its public API origin as api.<web host>; it must be HTTPS.
  api_host      = var.api_domain_name != "" ? var.api_domain_name : "api.${var.domain_name}"
  web_url       = "https://${var.domain_name}"
  api_url       = "https://${local.api_host}"
  region        = split(":", aws_cloudwatch_log_group.api.arn)[3] # works on AWS provider v5 and v6
  den_api_image = var.den_api_image != "" ? var.den_api_image : "ghcr.io/different-ai/openwork-den-api:${var.openwork_version}"
  den_web_image = var.den_web_image != "" ? var.den_web_image : "ghcr.io/different-ai/openwork-den-web:${var.openwork_version}"

  # OpenWork Web: den-gateway serves the web app and proxies each member to
  # their Daytona sandbox; den-api provisions the sandboxes.
  web_enabled       = var.openwork_web_enabled
  gateway_host      = var.openwork_web_domain_name != "" ? var.openwork_web_domain_name : "web.${var.domain_name}"
  gateway_url       = "https://${local.gateway_host}"
  den_gateway_image = var.den_gateway_image != "" ? var.den_gateway_image : "ghcr.io/different-ai/openwork-den-gateway:${var.openwork_version}"
  provisioner_mode  = var.provisioner_mode != "" ? var.provisioner_mode : (local.web_enabled ? "daytona" : "stub")
  daytona_prefix    = var.daytona.name_prefix != "" ? var.daytona.name_prefix : var.name

  # den-web reaches den-api privately through Cloud Map, not the public ALB.
  internal_api_url = "http://den-api.${aws_service_discovery_private_dns_namespace.this.name}:8788"

  bool = { true = "true", false = "false" }

  database_url = var.create_database ? format(
    "mysql://%s:%s@%s:%d/%s?%s",
    aws_db_instance.this[0].username,
    random_password.db[0].result,
    aws_db_instance.this[0].address,
    aws_db_instance.this[0].port,
    aws_db_instance.this[0].db_name,
    var.database.tls_query,
  ) : var.database_url

  redis_url = var.create_redis ? "rediss://${aws_elasticache_replication_group.this[0].primary_endpoint_address}:6379" : ""

  bootstrap_code = var.initial_admin_bootstrap_code != "" ? var.initial_admin_bootstrap_code : random_password.bootstrap_code.result

  # Mirrors the env the openwork-ee Helm chart puts in its ConfigMap; both
  # services receive the same set, as they do on Kubernetes.
  environment = merge({
    CI                                 = "true"
    NODE_ENV                           = "production"
    OPENWORK_DEV_MODE                  = "0"
    DB_MODE                            = "mysql"
    DEN_ORG_MODE                       = "single_org"
    DEN_SINGLE_ORG_NAME                = var.org_name
    DEN_SINGLE_ORG_SLUG                = var.org_slug
    DEN_SINGLE_ORG_OWNER_EMAILS        = join(",", var.owner_emails)
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = local.bool[var.allow_public_signup]
    DEN_REQUIRE_EMAIL_VERIFICATION     = local.bool[var.require_email_verification]
    DEN_BASE_URL                       = local.web_url
    BETTER_AUTH_URL                    = local.web_url
    DEN_API_PUBLIC_URL                 = local.api_url
    DEN_AUTOMATIONS_ENABLED            = local.bool[var.automations_enabled]
    DEN_DASHBOARDS_ENABLED             = local.bool[var.dashboards_enabled]
    DEN_OPENWORK_WEB_ENABLED           = local.bool[var.openwork_web_enabled]
    PROVISIONER_MODE                   = local.provisioner_mode
    DEN_API_BASE                       = local.internal_api_url
    DEN_AUTH_FALLBACK_BASE             = local.internal_api_url
    DEN_AUTH_ORIGIN                    = local.web_url
    DEN_WEB_PUBLIC_ORIGIN              = local.web_url
    DEN_WEB_OPENWORK_AUTH_CALLBACK_URL = local.web_url
    DEN_WEB_OPENWORK_WEB_URL           = var.openwork_web_url != "" ? var.openwork_web_url : (local.web_enabled ? local.gateway_url : "")
    # ElastiCache in this module always uses TLS (rediss://).
    DATABASE_REDIS_ALLOW_INSECURE_INTERNAL = "0"
    EMAIL_FROM                             = var.email_from
    SMTP_HOST                              = var.smtp.host
    SMTP_PORT                              = tostring(var.smtp.port)
    SMTP_USER                              = var.smtp.username
    SMTP_SECURE                            = local.bool[var.smtp.secure]
  }, local.web_environment, var.extra_environment)

  # Empty values are dropped below, so these are unset while Web is off.
  web_environment = {
    # The gateway signs members in through den-web and calls den-api from its
    # own origin; den-api trusts only listed origins for both.
    DEN_GATEWAY_ORIGIN              = local.web_enabled ? local.gateway_url : ""
    CORS_ORIGINS                    = local.web_enabled ? local.gateway_url : ""
    DEN_BETTER_AUTH_TRUSTED_ORIGINS = local.web_enabled ? local.gateway_url : ""
    # Sandboxes report activity to the public API; the default (den-web) does
    # not serve /v1. Daytona must be able to reach it, so not internal_alb.
    WORKER_ACTIVITY_BASE_URL    = local.web_enabled ? local.api_url : ""
    DAYTONA_API_URL             = local.provisioner_mode == "daytona" ? var.daytona.api_url : ""
    DAYTONA_SNAPSHOT            = local.provisioner_mode == "daytona" ? var.daytona.snapshot : ""
    DAYTONA_TARGET              = local.provisioner_mode == "daytona" ? var.daytona.target : ""
    DAYTONA_SANDBOX_NAME_PREFIX = local.provisioner_mode == "daytona" ? "${local.daytona_prefix}-worker" : ""
    DAYTONA_SHARED_VOLUME_NAME  = local.provisioner_mode == "daytona" ? "${local.daytona_prefix}-workers" : ""
  }

  environment_list = [for k, v in local.environment : { name = k, value = v } if v != ""]

  # Only keys with a value are written, so ECS never references a missing key.
  secret_values = { for k, v in {
    DATABASE_URL                     = local.database_url
    BETTER_AUTH_SECRET               = random_password.better_auth.result
    DEN_DB_ENCRYPTION_KEY            = random_password.db_encryption.result
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = local.bootstrap_code
    DATABASE_REDIS_URL               = local.redis_url
    SMTP_PASS                        = var.smtp.password
    RESEND_API_KEY                   = var.resend_api_key
    DAYTONA_API_KEY                  = local.provisioner_mode == "daytona" ? var.daytona_api_key : ""
    DEN_GATEWAY_KEY                  = try(random_password.gateway_key[0].result, "")
  } : k => v if v != "" }

  secrets_list = concat(
    [for k in keys(local.secret_values) : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }],
    [for k, arn in var.extra_secrets : { name = k, valueFrom = arn }],
  )

  # Strip an optional ":json-key:version-stage:version-id" suffix to get the IAM resource ARN.
  extra_secret_resource_arns = distinct([
    for arn in values(var.extra_secrets) : join(":", slice(split(":", arn), 0, min(7, length(split(":", arn)))))
  ])
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

resource "aws_secretsmanager_secret" "app" {
  name_prefix             = "${var.name}-den-"
  description             = "OpenWork Den secrets (${var.name})"
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.secret_values)
}
