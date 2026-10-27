# Test-only immutable installer variant: copy this file into the lab bundle's
# AWS Terraform root under the same *_override.tf name. Do not include it in a
# production release. No version, image, credential or database input changes.
variable "tls_task_revision" {
  default = "second-update"
}
