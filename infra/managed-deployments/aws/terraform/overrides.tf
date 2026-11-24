# Customer tuning. The installer reads deployments/<id>/overrides.json from the
# customer's state bucket, validates it against this allowlist and passes it as
# this one typed variable. Engine version, deletion protection, backups, secrets
# and the network are not part of the type, so they cannot be tuned.
variable "overrides" {
  description = "Allowlisted tuning for one deployment: task size and count, database tier, disk and high availability, OTEL_ environment variables and log retention."
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
    extra_environment  = optional(map(string), {})
    log_retention_days = optional(number)
  })
  default = {}

  validation {
    condition = alltrue([for name, service in { den_api = var.overrides.api, den_web = var.overrides.web } :
      contains(
        lookup(local.fargate_memory, tostring(coalesce(service.cpu, local.profile[name].cpu)), []),
        coalesce(service.memory, local.profile[name].memory)
      )
    ])
    error_message = "overrides: cpu and memory must be a Fargate size (cpu 256, 512, 1024, 2048 or 4096 with a memory value AWS offers for it)."
  }
  validation {
    condition = alltrue([for name, service in { den_api = var.overrides.api, den_web = var.overrides.web } :
      coalesce(service.cpu, local.profile[name].cpu) >= local.profile[name].cpu &&
      coalesce(service.memory, local.profile[name].memory) >= local.profile[name].memory
    ])
    error_message = "overrides: cpu and memory cannot be smaller than the deployment's size profile."
  }
  validation {
    condition = alltrue([for service in [var.overrides.api, var.overrides.web] :
      (service.min_instances == null ? true : service.min_instances >= 1 && service.min_instances <= 10 && floor(service.min_instances) == service.min_instances) &&
      (service.max_instances == null ? true : service.max_instances == coalesce(service.min_instances, 1))
    ])
    error_message = "overrides: min_instances must be a whole number from 1 to 10. AWS runs a fixed number of tasks, so max_instances must equal min_instances."
  }
  validation {
    condition     = var.overrides.database.tier == null ? true : can(regex("^db\\.(t4g\\.(micro|small|medium|large|xlarge|2xlarge)|(m6g|m7g|r6g|r7g)\\.(large|xlarge|2xlarge|4xlarge))$", var.overrides.database.tier))
    error_message = "overrides: database.tier must be a db.t4g, db.m6g, db.m7g, db.r6g or db.r7g instance class."
  }
  validation {
    condition = var.overrides.database.disk_size_gb == null ? true : (
      var.overrides.database.disk_size_gb >= local.profile.database.allocated_storage_gb && var.overrides.database.disk_size_gb <= 4096 &&
      floor(var.overrides.database.disk_size_gb) == var.overrides.database.disk_size_gb
    )
    error_message = "overrides: database.disk_size_gb must be a whole number from the size profile's disk up to 4096."
  }
  validation {
    condition = alltrue([for name, value in var.overrides.extra_environment :
      can(regex("^OTEL_[A-Z0-9_]{1,120}$", name)) &&
      !can(regex("(?i)(secret|password|passwd|token|api_key|private_key|encryption_key|credential|authorization|headers)", name)) &&
      length(value) <= 2048 && !can(regex("://[^/@[:space:]]*@", value))
    ])
    error_message = "overrides: extra_environment accepts only OTEL_ names that carry no credential (no headers, tokens or keys, and no user:password in a URL)."
  }
  validation {
    condition     = var.overrides.log_retention_days == null ? true : contains([7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.overrides.log_retention_days)
    error_message = "overrides: log_retention_days must be a CloudWatch Logs retention period of at least 7 days."
  }
}

# Public trust roots only. Empty downloads the regional RDS bundle on every
# plan. The installer records the downloaded bundle in applied/, so a plan made
# from that record needs no download and cannot differ because AWS republished it.
variable "database_ca_bundle" {
  description = "PEM trust roots for the deployment's RDS database. Empty downloads the public AWS RDS regional bundle. Never a private key."
  type        = string
  default     = ""
  validation {
    condition     = var.database_ca_bundle == "" || (strcontains(var.database_ca_bundle, "-----BEGIN CERTIFICATE-----") && !strcontains(var.database_ca_bundle, "PRIVATE KEY"))
    error_message = "database_ca_bundle must be PEM certificates only."
  }
}

locals {
  # Memory (MiB) AWS Fargate offers for each task CPU value.
  fargate_memory = {
    "256"  = [512, 1024, 2048]
    "512"  = range(1024, 4097, 1024)
    "1024" = range(2048, 8193, 1024)
    "2048" = range(4096, 16385, 1024)
    "4096" = range(8192, 30721, 1024)
  }
  # Without overrides every value below equals what the size profile and the
  # shared module's defaults gave before overrides existed.
  tuned = {
    den_api = {
      cpu           = coalesce(var.overrides.api.cpu, local.profile.den_api.cpu)
      memory        = coalesce(var.overrides.api.memory, local.profile.den_api.memory)
      desired_count = coalesce(var.overrides.api.min_instances, local.profile.den_api.desired_count)
    }
    den_web = {
      cpu           = coalesce(var.overrides.web.cpu, local.profile.den_web.cpu)
      memory        = coalesce(var.overrides.web.memory, local.profile.den_web.memory)
      desired_count = coalesce(var.overrides.web.min_instances, local.profile.den_web.desired_count)
    }
    database = {
      instance_class       = coalesce(var.overrides.database.tier, local.profile.database.instance_class)
      allocated_storage_gb = coalesce(var.overrides.database.disk_size_gb, local.profile.database.allocated_storage_gb)
      # Storage autoscaling needs headroom above the allocated disk.
      max_allocated_storage = max(local.profile.database.max_allocated_storage, 2 * coalesce(var.overrides.database.disk_size_gb, 0))
      multi_az              = coalesce(var.overrides.database.high_availability, false)
    }
    log_retention_days = coalesce(var.overrides.log_retention_days, 30)
  }
}
