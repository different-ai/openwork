locals {
  chart_version = var.chart_version != "" ? var.chart_version : var.openwork_version

  # Mirrors the chart's openwork-ee.fullname helper.
  chart_fullname = strcontains(var.release_name, "openwork-ee") ? var.release_name : "${var.release_name}-openwork-ee"

  generate_auth_secret   = var.better_auth_secret == ""
  generate_db_encryption = var.den_db_encryption_key == ""

  better_auth_secret    = local.generate_auth_secret ? random_password.better_auth_secret[0].result : var.better_auth_secret
  den_db_encryption_key = local.generate_db_encryption ? random_password.den_db_encryption_key[0].result : var.den_db_encryption_key

  # Who owns the Kubernetes Secret the pods read through envFrom:
  #   existing  - an operator-managed Secret (External Secrets, Vault, kubectl)
  #   terraform - this module writes it with kubernetes_secret_v1
  #   chart     - the chart renders it from secret.values
  secret_owner = var.existing_secret_name != "" ? "existing" : (var.manage_secret_with_terraform ? "terraform" : "chart")
  secret_name  = var.existing_secret_name != "" ? var.existing_secret_name : "${var.release_name}-openwork-secrets"

  # Keys are env var names: den-api and den-web load the Secret with envFrom.
  secret_data = { for key, value in {
    DATABASE_URL                     = var.database_url
    DATABASE_REDIS_URL               = var.redis_url
    BETTER_AUTH_SECRET               = local.better_auth_secret
    DEN_DB_ENCRYPTION_KEY            = local.den_db_encryption_key
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = var.initial_admin_bootstrap_code
    EMAIL_FROM                       = var.email_from
    SMTP_HOST                        = var.smtp.host
    SMTP_PORT                        = var.smtp.host == "" ? "" : tostring(var.smtp.port)
    SMTP_USER                        = var.smtp.username
    SMTP_PASS                        = var.smtp.password
    SMTP_SECURE                      = var.smtp.host == "" ? "" : tostring(var.smtp.secure)
  } : key => value if value != "" }

  chart_secret_values = {
    databaseUrl               = var.database_url
    databaseRedisUrl          = var.redis_url
    betterAuthSecret          = local.better_auth_secret
    denDbEncryptionKey        = local.den_db_encryption_key
    initialAdminBootstrapCode = var.initial_admin_bootstrap_code
    emailFrom                 = var.email_from
    smtpHost                  = var.smtp.host
    smtpPort                  = tostring(var.smtp.port)
    smtpUser                  = var.smtp.username
    smtpPass                  = var.smtp.password
    smtpSecure                = tostring(var.smtp.secure)
  }

  bool_string = { true = "true", false = "false" }

  chart_values = {
    image = {
      tag = var.image_tag
    }
    imagePullSecrets = [for name in var.image_pull_secret_names : { name = name }]

    config = {
      databaseMode = "mysql"
      tenancy = {
        mode                     = "single_org"
        singleOrgName            = var.org_name
        singleOrgSlug            = var.org_slug
        ownerEmails              = join(",", var.owner_emails)
        allowPublicSignup        = local.bool_string[var.allow_public_signup]
        requireEmailVerification = local.bool_string[var.require_email_verification]
      }
      public = {
        webOrigin                 = var.web_origin
        authCallbackUrl           = var.web_origin
        apiOrigin                 = var.api_origin
        mcpClaimNamespace         = var.mcp_claim_namespace
        allowPrivateMcpUrls       = var.allow_private_mcp_urls ? "1" : ""
        installLinksGatingEnabled = local.bool_string[var.install_links_gating_enabled]
        automationsEnabled        = local.bool_string[var.automations_enabled]
        dashboardsEnabled         = local.bool_string[var.dashboards_enabled]
      }
    }

    observability = {
      backend = var.observability.backend
      otel = {
        endpoint = var.observability.otel_endpoint
        headers = {
          existingSecret = var.observability.otel_headers_secret
        }
      }
      sentry = {
        dsnSecret = {
          existingSecret = var.observability.sentry_dsn_secret
        }
        environment = var.observability.sentry_environment
      }
    }

    customCa = {
      enabled           = var.custom_ca.existing_secret != "" || var.custom_ca.existing_config_map != ""
      existingSecret    = var.custom_ca.existing_secret
      existingConfigMap = var.custom_ca.existing_config_map
      key               = var.custom_ca.key
    }

    redis = {
      allowInsecureInternal = var.redis_allow_insecure_internal
    }

    secret = {
      create         = local.secret_owner == "chart"
      existingSecret = local.secret_owner == "chart" ? "" : local.secret_name
      values         = local.secret_owner == "chart" ? local.chart_secret_values : {}
    }

    denApi = {
      replicaCount = var.den_api.replicas
      resources    = var.den_api.resources
      env          = var.den_api.env
    }

    denWeb = {
      replicaCount = var.den_web.replicas
      resources    = var.den_web.resources
      env          = var.den_web.env
    }

    ingress = {
      enabled     = var.ingress.enabled
      className   = var.ingress.class_name
      annotations = var.ingress.annotations
      web = {
        host = var.ingress.web_host
      }
      api = {
        enabled = var.ingress.api_host != ""
        host    = var.ingress.api_host
      }
      tls = var.ingress.tls_secret_name == "" ? [] : [{
        secretName = var.ingress.tls_secret_name
        hosts      = compact([var.ingress.web_host, var.ingress.api_host])
      }]
    }
  }
}

resource "random_password" "better_auth_secret" {
  count   = local.generate_auth_secret ? 1 : 0
  length  = 48
  special = false
}

resource "random_password" "den_db_encryption_key" {
  count   = local.generate_db_encryption ? 1 : 0
  length  = 48
  special = false
}

resource "kubernetes_namespace_v1" "this" {
  count = var.create_namespace ? 1 : 0

  metadata {
    name   = var.namespace
    labels = var.labels
  }
}

resource "kubernetes_secret_v1" "openwork" {
  count = local.secret_owner == "terraform" ? 1 : 0

  metadata {
    name      = local.secret_name
    namespace = var.namespace
    labels    = var.labels
  }

  type = "Opaque"
  data = local.secret_data

  depends_on = [kubernetes_namespace_v1.this]
}

resource "helm_release" "openwork" {
  name       = var.release_name
  namespace  = var.namespace
  repository = var.chart_repository
  chart      = "openwork-ee"
  version    = local.chart_version

  # The migration hook Job pulls the den-api image on a cold node; keep this at
  # least as long as the chart's migrations.activeDeadlineSeconds.
  timeout         = var.helm_timeout_seconds
  atomic          = var.atomic
  cleanup_on_fail = var.atomic
  wait            = true
  max_history     = 10

  # Helm deep-merges these in order, so extra_helm_values can override any
  # single key without restating the whole block.
  values = [
    yamlencode(local.chart_values),
    yamlencode(var.extra_helm_values),
  ]

  depends_on = [
    kubernetes_namespace_v1.this,
    kubernetes_secret_v1.openwork,
  ]
}
