# Custom domains (optional) ---------------------------------------------------
#
# Azure checks DNS when a hostname is bound, so the records in the
# custom_domain_dns_records output must exist before domain_name is set.

locals {
  # Without a certificate nothing is bound; den-api's precondition explains why.
  bind_custom_domains = local.custom_domains && nonsensitive(var.custom_domain_certificate != null)
}

resource "azurerm_container_app_environment_certificate" "this" {
  count = local.bind_custom_domains ? 1 : 0

  name                         = "${var.name}-den"
  container_app_environment_id = local.environment_id
  certificate_blob_base64      = var.custom_domain_certificate.pfx_base64
  certificate_password         = var.custom_domain_certificate.password
  tags                         = var.tags
}

resource "azurerm_container_app_custom_domain" "web" {
  count = local.bind_custom_domains ? 1 : 0

  name                                     = local.web_host
  container_app_id                         = azapi_resource.web.id
  container_app_environment_certificate_id = azurerm_container_app_environment_certificate.this[0].id
  certificate_binding_type                 = "SniEnabled"
}

resource "azurerm_container_app_custom_domain" "api" {
  count = local.bind_custom_domains ? 1 : 0

  name                                     = local.api_host
  container_app_id                         = azapi_resource.api.id
  container_app_environment_certificate_id = azurerm_container_app_environment_certificate.this[0].id
  certificate_binding_type                 = "SniEnabled"
}
