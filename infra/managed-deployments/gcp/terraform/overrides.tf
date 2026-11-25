# Customer tuning. The runner reads deployments/<id>/overrides.json from the
# customer's state bucket, validates it against this allowlist and passes it as
# this one typed variable. Database version, deletion protection, backups,
# secrets, images and the network are not part of the type, so they cannot be
# tuned. Same keys and units as the AWS root; log retention is not offered here
# because Cloud Run logs live in the project's Cloud Logging buckets.
variable "overrides" {
  description = "Allowlisted tuning for one deployment: service size and instance counts, database tier, disk and high availability, and OTEL_ environment variables."
  type = object({
    api = optional(object({
      cpu           = optional(number)
      memory        = optional(number)
      min_instances = optional(number)
      max_instances = optional(number)
    }), {})
    web = optional(object({
      cpu           = optional(number)
      memory        = optional(number)
      min_instances = optional(number)
      max_instances = optional(number)
    }), {})
    database = optional(object({
      tier              = optional(string)
      disk_size_gb      = optional(number)
      high_availability = optional(bool)
    }), {})
    extra_environment = optional(map(string), {})
  })
  default  = {}
  nullable = false

  validation {
    condition = alltrue([for name, service in { den_api = var.overrides.api, den_web = var.overrides.web } :
      contains(
        lookup(local.cloud_run_memory, tostring(coalesce(service.cpu, local.profile[name].cpu)), []),
        coalesce(service.memory, local.profile[name].memory)
      )
    ])
    error_message = "overrides: cpu and memory must be a Cloud Run size (cpu 1024, 2048, 4096 or 8192 with a memory value Cloud Run offers for it, in whole GiB as MiB)."
  }
  validation {
    condition = alltrue([for name, service in { den_api = var.overrides.api, den_web = var.overrides.web } :
      coalesce(service.cpu, local.profile[name].cpu) >= local.profile[name].cpu &&
      coalesce(service.memory, local.profile[name].memory) >= local.profile[name].memory
    ])
    error_message = "overrides: cpu and memory cannot be smaller than the deployment's size profile."
  }
  validation {
    condition = alltrue([for name, service in { den_api = var.overrides.api, den_web = var.overrides.web } :
      (service.min_instances == null ? true : service.min_instances >= 1 && service.min_instances <= 10 && floor(service.min_instances) == service.min_instances) &&
      (service.max_instances == null ? true : service.max_instances >= 1 && service.max_instances <= 100 && floor(service.max_instances) == service.max_instances) &&
      coalesce(service.max_instances, local.profile[name].max_instances) >= coalesce(service.min_instances, local.profile[name].min_instances)
    ])
    error_message = "overrides: min_instances must be a whole number from 1 to 10 and max_instances from 1 to 100, not below min_instances."
  }
  validation {
    condition     = var.overrides.database.tier == null ? true : can(regex("^db-custom-(1|2|4|8|16|32)-[1-9][0-9]{3,5}$", var.overrides.database.tier))
    error_message = "overrides: database.tier must be a Cloud SQL custom tier such as db-custom-2-7680."
  }
  validation {
    condition = var.overrides.database.disk_size_gb == null ? true : (
      var.overrides.database.disk_size_gb >= local.profile.database.disk_size_gb && var.overrides.database.disk_size_gb <= 4096 &&
      floor(var.overrides.database.disk_size_gb) == var.overrides.database.disk_size_gb
    )
    error_message = "overrides: database.disk_size_gb must be a whole number from the size profile's disk up to 4096."
  }
  validation {
    condition = length(var.overrides.extra_environment) <= 32 && alltrue([for name, value in var.overrides.extra_environment :
      can(regex("^OTEL_[A-Z0-9_]{1,120}$", name)) &&
      !can(regex("(?i)(secret|password|passwd|token|api_key|private_key|encryption_key|credential|authorization|headers|bootstrap_code|database_url|smtp_pass)", name)) &&
      length(value) <= 2048 && !can(regex("://[^/@[:space:]]*@", value))
    ])
    error_message = "overrides: extra_environment accepts at most 32 OTEL_ names that carry no credential (no headers, tokens or keys, and no user:password in a URL)."
  }
}

locals {
  # Memory (MiB) Cloud Run allows for each CPU value (1024 per vCPU), in whole GiB.
  cloud_run_memory = {
    "1024" = range(1024, 4097, 1024)
    "2048" = range(1024, 8193, 1024)
    "4096" = range(2048, 16385, 1024)
    "8192" = range(4096, 32769, 1024)
  }
  # Without overrides every value below equals what the root passed before
  # overrides existed: "2"/"2Gi" and "1"/"1Gi", 1 to 10 instances, a zonal
  # db-custom-1-3840 with 20 GB.
  tuned = merge({ for name, key in { den_api = "api", den_web = "web" } : name => {
    cpu           = tostring(coalesce(var.overrides[key].cpu, local.profile[name].cpu) / 1024)
    memory        = "${coalesce(var.overrides[key].memory, local.profile[name].memory) / 1024}Gi"
    min_instances = coalesce(var.overrides[key].min_instances, local.profile[name].min_instances)
    max_instances = coalesce(var.overrides[key].max_instances, local.profile[name].max_instances)
    } }, {
    database = {
      tier              = coalesce(var.overrides.database.tier, local.profile.database.tier)
      disk_size_gb      = coalesce(var.overrides.database.disk_size_gb, local.profile.database.disk_size_gb)
      availability_type = coalesce(var.overrides.database.high_availability, local.profile.database.high_availability) ? "REGIONAL" : "ZONAL"
    }
  })
}
