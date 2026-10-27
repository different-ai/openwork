data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

locals {
  location      = var.location != "" ? var.location : data.azurerm_resource_group.this.location
  den_api_image = var.den_api_image != "" ? var.den_api_image : "ghcr.io/different-ai/openwork-den-api@${var.den_api_image_digest}"
  den_web_image = var.den_web_image != "" ? var.den_web_image : "ghcr.io/different-ai/openwork-den-web@${var.den_web_image_digest}"
  api_app_name  = "${var.app_name_prefix}${var.name}-den-api"
  web_app_name  = "${var.app_name_prefix}${var.name}-den-web"

  # Without a custom domain each app is served at https://<app>.<environment
  # default domain> with a Microsoft-managed certificate. The names are known
  # before the apps exist, so both apps can carry each other's URL.
  default_api_host = "${local.api_app_name}.${local.environment_default_domain}"
  default_web_host = "${local.web_app_name}.${local.environment_default_domain}"
  custom_domains   = var.domain_name != ""
  web_host         = local.custom_domains ? var.domain_name : local.default_web_host
  api_host         = var.api_domain_name != "" ? var.api_domain_name : (local.custom_domains ? "api.${var.domain_name}" : local.default_api_host)
  web_url          = "https://${local.web_host}"
  api_url          = "https://${local.api_host}"

  # den-web proxies sign-in and browser API calls to den-api server side.
  # Container Apps redirects plain HTTP to HTTPS, so use the API app's own
  # HTTPS hostname, which is valid with or without a custom domain.
  internal_api_url = "https://${local.default_api_host}"

  bool = { true = "true", false = "false" }

  database_url = var.create_database ? format(
    "mysql://%s:%s@%s:3306/%s?%s",
    azurerm_mysql_flexible_server.this[0].administrator_login,
    local.database_password,
    azurerm_mysql_flexible_server.this[0].fqdn,
    azurerm_mysql_flexible_database.this[0].name,
    var.database.tls_query,
  ) : var.database_url

  database_password_candidate = var.database_admin_password != "" ? var.database_admin_password : ephemeral.random_password.secrets["db"].result
  database_password           = var.secret_versions.database_password_version == try(local.saved_versions.database_password_version, 1) ? try(regex("^mysql://[^:]+:([^@]+)@", local.saved_secrets["database-url"])[0], local.database_password_candidate) : local.database_password_candidate
  bootstrap_code              = var.initial_admin_bootstrap_code != "" ? var.initial_admin_bootstrap_code : ephemeral.random_password.secrets["bootstrap_code"].result

  # Mirrors the env the openwork-ee Helm chart puts in its ConfigMap and the
  # openwork-aws-ecs module sets; both apps receive the same set.
  environment = { for k, v in merge({
    CI                                  = "true"
    NODE_ENV                            = "production"
    OPENWORK_DEV_MODE                   = "0"
    OPENWORK_DEPLOYMENT_SECRETS_VERSION = jsonencode(var.secret_versions)
    DB_MODE                             = "mysql"
    DEN_ORG_MODE                        = "single_org"
    DEN_SINGLE_ORG_NAME                 = var.org_name
    DEN_SINGLE_ORG_SLUG                 = var.org_slug
    DEN_SINGLE_ORG_OWNER_EMAILS         = join(",", var.owner_emails)
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP  = local.bool[var.allow_public_signup]
    DEN_REQUIRE_EMAIL_VERIFICATION      = local.bool[var.require_email_verification]
    DEN_BASE_URL                        = local.web_url
    BETTER_AUTH_URL                     = local.web_url
    # Set explicitly: Den would otherwise derive api.<web host>, which does
    # not exist for the default Container Apps hostnames. den-web returns it
    # to desktops from /api/runtime-config.
    DEN_API_PUBLIC_URL                 = local.api_url
    DEN_AUTOMATIONS_ENABLED            = local.bool[var.automations_enabled]
    DEN_DASHBOARDS_ENABLED             = local.bool[var.dashboards_enabled]
    DEN_OPENWORK_WEB_ENABLED           = "false"
    PROVISIONER_MODE                   = "stub"
    DEN_API_BASE                       = local.internal_api_url
    DEN_AUTH_FALLBACK_BASE             = local.internal_api_url
    DEN_AUTH_ORIGIN                    = local.web_url
    DEN_WEB_PUBLIC_ORIGIN              = local.web_url
    DEN_WEB_OPENWORK_AUTH_CALLBACK_URL = local.web_url
    DEN_WEB_OPENWORK_WEB_URL           = var.openwork_web_url
    EMAIL_FROM                         = var.email_from
    # smtp is sensitive as a whole (it holds the password); these parts are not.
    SMTP_HOST   = nonsensitive(var.smtp.host)
    SMTP_PORT   = nonsensitive(tostring(var.smtp.port))
    SMTP_USER   = nonsensitive(var.smtp.username)
    SMTP_SECURE = nonsensitive(local.bool[var.smtp.secure])
  }, var.extra_environment) : k => v if v != "" }

  # Container Apps secrets. Which ones exist must be known at plan time, so
  # the optional ones are chosen from their inputs, never from generated values.
  secret_env_names = concat(
    ["DATABASE_URL", "BETTER_AUTH_SECRET", "DEN_DB_ENCRYPTION_KEY", "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"],
    nonsensitive(var.smtp.password != "") ? ["SMTP_PASS"] : [],
    nonsensitive(var.resend_api_key != "") ? ["RESEND_API_KEY"] : [],
  )

  generated_secret_values = {
    DATABASE_URL                     = local.database_url
    BETTER_AUTH_SECRET               = var.better_auth_secret != "" ? var.better_auth_secret : ephemeral.random_password.secrets["better_auth"].result
    DEN_DB_ENCRYPTION_KEY            = var.db_encryption_key != "" ? var.db_encryption_key : ephemeral.random_password.secrets["db_encryption"].result
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = local.bootstrap_code
    SMTP_PASS                        = var.smtp.password
    RESEND_API_KEY                   = var.resend_api_key
    REGISTRY_PASSWORD                = var.registry_password
  }

  # Env var name => Container Apps secret name (lowercase, hyphens).
  secret_env = { for k in concat(local.secret_env_names, keys(var.extra_secrets)) : k => lower(replace(k, "_", "-")) }
}

ephemeral "random_password" "secrets" {
  for_each    = toset(["db", "better_auth", "db_encryption", "bootstrap_code"])
  length      = each.key == "db" ? 32 : (each.key == "bootstrap_code" ? 24 : 48)
  special     = false
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
}
