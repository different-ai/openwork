locals {
  identity_ids         = distinct(compact(concat(var.user_assigned_identity_ids, [var.key_vault_identity_id])))
  registry_password    = var.registry != null && nonsensitive(var.registry_password != "")
  managed_secret_names = concat(local.secret_env_names, local.registry_password ? ["REGISTRY_PASSWORD"] : [])
  extra_secret_metadata = [for name, id in var.extra_secrets : {
    name = lower(replace(name, "_", "-")), keyVaultUrl = id, identity = var.key_vault_identity_id
  }]
  secret_metadata = concat([for name in local.managed_secret_names : { name = lower(replace(name, "_", "-")) }], local.extra_secret_metadata)
  secret_payload  = concat([for name in local.managed_secret_names : { name = lower(replace(name, "_", "-")), value = local.secret_values[name] }], local.extra_secret_metadata)
  registries = var.registry == null ? [] : [{
    server            = var.registry.server
    identity          = var.registry.identity != "" ? var.registry.identity : null
    username          = var.registry.username != "" ? var.registry.username : null
    passwordSecretRef = local.registry_password ? "registry-password" : null
  }]
  plain_env            = [for name, value in local.environment : { name = name, value = value }]
  secret_env_values    = [for name, reference in local.secret_env : { name = name, secretRef = reference }]
  ingress_restrictions = [for index, cidr in var.allowed_ingress_cidrs : { name = "allow-${index}", action = "Allow", ipAddressRange = cidr }]
  app_specs = {
    api = { name = "den-api", port = 8788, health = "/health", cpu = var.den_api.cpu, memory = var.den_api.memory, replicas = var.den_api.replicas, image = local.den_api_image }
    web = { name = "den-web", port = 3005, health = "/api/health", cpu = var.den_web.cpu, memory = var.den_web.memory, replicas = var.den_web.replicas, image = local.den_web_image }
  }
  app_bodies = { for key, app in local.app_specs : key => {
    properties = {
      managedEnvironmentId = local.environment_id
      workloadProfileName  = var.workload_profile_name != "" ? var.workload_profile_name : null
      configuration = {
        activeRevisionsMode = "Single"
        secrets             = local.secret_metadata
        registries          = local.registries
        ingress = {
          external               = true, targetPort = app.port, transport = "Auto", allowInsecure = false
          traffic                = [{ latestRevision = true, weight = 100 }]
          ipSecurityRestrictions = local.ingress_restrictions
        }
      }
      template = {
        # Clear a legacy per-replica migrator explicitly on imported apps.
        initContainers = []
        scale          = { minReplicas = app.replicas, maxReplicas = app.replicas }
        containers = [{
          name      = app.name, image = app.image
          resources = { cpu = app.cpu, memory = app.memory }
          env       = concat([{ name = "PORT", value = tostring(app.port) }], local.plain_env, local.secret_env_values)
          probes = concat(
            [{ type = "Liveness", httpGet = { path = app.health, port = app.port, scheme = "HTTP" }, initialDelaySeconds = 10, periodSeconds = 30 }],
            key == "api" ? [{ type = "Readiness", httpGet = { path = "/ready", port = app.port, scheme = "HTTP" }, periodSeconds = 10 }] : [],
          )
        }]
      }
    }
  } }
  # PUT requires the complete secret collection, even when values are unchanged.
  # Version this write-only property by NON-SECRET deployment configuration; the
  # payload is ephemerally recovered from the cloud unless a *_version rotates it.
  app_write_versions = { for key, body in local.app_bodies : key => {
    "properties.configuration.secrets" = sha256(jsonencode({ body = body, tags = var.tags, identities = local.identity_ids, location = local.app_location }))
  } }
}

resource "azapi_resource" "api" {
  type                   = "Microsoft.App/containerApps@2025-01-01"
  name                   = local.api_app_name
  parent_id              = data.azurerm_resource_group.this.id
  location               = local.app_location
  tags                   = var.tags
  ignore_null_property   = true
  response_export_values = ["properties.outboundIpAddresses"]
  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }
  body                   = local.app_bodies.api
  sensitive_body         = { properties = { configuration = { secrets = local.secret_payload } } }
  sensitive_body_version = local.app_write_versions.api
  depends_on             = [data.external.migration_completion]
  lifecycle {
    precondition {
      condition     = var.create_database || nonsensitive(var.database_url != "")
      error_message = "Set database_url when create_database = false."
    }
    precondition {
      condition     = !local.custom_domains || var.custom_domain_certificate != null
      error_message = "domain_name needs custom_domain_certificate (a PFX covering both hostnames)."
    }
  }
}
resource "azapi_resource" "web" {
  type                   = "Microsoft.App/containerApps@2025-01-01"
  name                   = local.web_app_name
  parent_id              = data.azurerm_resource_group.this.id
  location               = local.app_location
  tags                   = var.tags
  ignore_null_property   = true
  response_export_values = []
  dynamic "identity" {
    for_each = length(local.identity_ids) > 0 ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = local.identity_ids
    }
  }
  body                   = local.app_bodies.web
  sensitive_body         = { properties = { configuration = { secrets = local.secret_payload } } }
  sensitive_body_version = local.app_write_versions.web
  depends_on             = [azapi_resource.api]
}
