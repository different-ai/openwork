# Certificate: bring your own (certificate_arn), or let the module create and
# DNS-validate one when every hostname (web, API, and the OpenWork Web gateway
# when enabled) lives in route53_zone_id.

locals {
  create_certificate = var.certificate_arn == ""
  certificate_arn    = local.create_certificate ? aws_acm_certificate_validation.this[0].certificate_arn : var.certificate_arn
}

resource "aws_acm_certificate" "this" {
  count = local.create_certificate ? 1 : 0

  domain_name               = var.domain_name
  subject_alternative_names = concat([local.api_host], local.web_enabled ? [local.gateway_host] : [], local.workbot_enabled ? [local.workbot_host] : [])
  validation_method         = "DNS"
  tags                      = var.tags

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = var.route53_zone_id != ""
      error_message = "Set certificate_arn, or route53_zone_id so the module can create and validate a certificate."
    }
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.create_certificate ? {
    for o in aws_acm_certificate.this[0].domain_validation_options : o.domain_name => o
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count = local.create_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}
