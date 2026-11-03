locals {
  ingress = local.custom_domain && var.restrict_ingress_to_load_balancer ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"

  vpc_access = var.network != "" ? [{ network = var.network, subnetwork = var.subnetwork }] : []
  cloud_sql  = local.cloud_sql_connection_name != "" ? [local.cloud_sql_connection_name] : []

  # Runs the migration job again whenever the den-api image or migration_run_id changes.
  migration_token = substr(sha256("${local.den_api_image}|${var.migration_run_id}"), 0, 12)
}

# Migrations -----------------------------------------------------------------

# Same migration the Helm chart runs as a pre-install/pre-upgrade Job.
# run_execution_token makes apply execute it and wait for it to succeed
# before den-api is updated, so a failed migration fails the apply.
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = local.migrate_job_name
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = var.labels
  run_execution_token = local.migration_token

  template {
    task_count = 1

    template {
      service_account = local.service_account_email
      max_retries     = 0
      timeout         = "1800s"

      containers {
        image   = local.den_api_image
        command = ["node"]
        args    = ["/app/ee/packages/den-db/dist/scripts/bootstrap.js"]

        resources {
          limits = {
            cpu    = var.den_api.cpu
            memory = var.den_api.memory
          }
        }

        dynamic "env" {
          for_each = local.environment_list
          content {
            name  = env.key
            value = env.value
          }
        }


        dynamic "env" {
          for_each = local.secret_refs
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value.secret
                version = env.value.version
              }
            }
          }
        }

        dynamic "volume_mounts" {
          for_each = local.cloud_sql
          content {
            name       = "cloudsql"
            mount_path = "/cloudsql"
          }
        }
      }

      dynamic "volumes" {
        for_each = local.cloud_sql
        content {
          name = "cloudsql"
          cloud_sql_instance {
            instances = [volumes.value]
          }
        }
      }

      dynamic "vpc_access" {
        for_each = local.vpc_access
        content {
          egress = var.vpc_egress
          network_interfaces {
            network    = vpc_access.value.network
            subnetwork = vpc_access.value.subnetwork
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = !var.managed_legacy || (!var.write_only_secrets && var.web_service_account_email != "" && var.smtp.password == "" && var.resend_api_key == "")
      error_message = "Managed compatibility requires legacy secrets, a separate web identity, and no new optional generated secrets."
    }
    precondition {
      condition     = var.create_database || var.write_only_secrets || nonsensitive(var.database_url != "")
      error_message = "Set database_url when create_database = false."
    }
    precondition {
      condition     = local.images_pinned
      error_message = "Pin every image by digest: set image_digests for the published images (see the README), give den_api_image / den_web_image as <image>@sha256:<digest>, or set allow_mutable_image_tags = true."
    }
    precondition {
      condition     = var.network == "" || var.subnetwork != ""
      error_message = "network needs subnetwork for Direct VPC egress."
    }
  }

  depends_on = [
    # Secrets readable, database ready, image mirror present.
    google_secret_manager_secret_iam_member.app,
    google_secret_manager_secret_iam_member.extra,
    google_project_iam_member.cloudsql_client,
    google_sql_user.openwork,
    google_sql_database.den,
    google_artifact_registry_repository.ghcr,
  ]
}

# Den API --------------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  project              = var.project_id
  name                 = local.api_service_name
  location             = var.region
  ingress              = local.ingress
  deletion_protection  = var.deletion_protection
  invoker_iam_disabled = var.public_access
  default_uri_disabled = local.custom_domain && var.restrict_ingress_to_load_balancer
  labels               = var.labels

  # On adoption, prepare API-only revisions while still disabled. The runner
  # verifies latest-ready/traffic ownership before a separate autoscaling apply.
  dynamic "scaling" {
    for_each = var.managed_legacy ? [1] : []
    content {
      scaling_mode          = var.managed_maintenance ? "MANUAL" : "AUTOMATIC"
      manual_instance_count = var.managed_maintenance ? 0 : null
    }
  }

  dynamic "traffic" {
    for_each = var.managed_legacy ? [1] : []
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }

  template {
    service_account = local.service_account_email
    timeout         = "300s"

    scaling {
      min_instance_count = var.den_api.min_instances
      max_instance_count = var.den_api.max_instances
    }

    containers {
      image   = local.den_api_image
      command = var.managed_legacy ? ["node"] : null
      args    = var.managed_legacy ? ["/app/ee/apps/den-api/dist/main.js"] : null

      ports {
        container_port = 8788
      }

      resources {
        limits = {
          cpu    = var.den_api.cpu
          memory = var.den_api.memory
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 24
      }

      dynamic "env" {
        for_each = local.environment_list
        content {
          name  = env.key
          value = env.value
        }
      }


      dynamic "env" {
        for_each = local.secret_refs
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = local.cloud_sql
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }

    dynamic "volumes" {
      for_each = local.cloud_sql
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [volumes.value]
        }
      }
    }

    dynamic "vpc_access" {
      for_each = local.vpc_access
      content {
        egress = var.vpc_egress
        network_interfaces {
          network    = vpc_access.value.network
          subnetwork = vpc_access.value.subnetwork
        }
      }
    }
  }

  depends_on = [google_cloud_run_v2_job.migrate]
}

# Den web --------------------------------------------------------------------

resource "google_cloud_run_v2_service" "web" {
  project              = var.project_id
  name                 = local.web_service_name
  location             = var.region
  ingress              = local.ingress
  deletion_protection  = var.deletion_protection
  invoker_iam_disabled = var.public_access
  default_uri_disabled = local.custom_domain && var.restrict_ingress_to_load_balancer
  labels               = var.labels

  # On adoption, prepare API-only revisions while still disabled. The runner
  # verifies latest-ready/traffic ownership before a separate autoscaling apply.
  dynamic "scaling" {
    for_each = var.managed_legacy ? [1] : []
    content {
      scaling_mode          = var.managed_maintenance ? "MANUAL" : "AUTOMATIC"
      manual_instance_count = var.managed_maintenance ? 0 : null
    }
  }

  dynamic "traffic" {
    for_each = var.managed_legacy ? [1] : []
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }

  template {
    service_account = var.managed_legacy ? var.web_service_account_email : local.service_account_email
    timeout         = "300s"

    scaling {
      min_instance_count = var.den_web.min_instances
      max_instance_count = var.den_web.max_instances
    }

    containers {
      image = local.den_web_image

      ports {
        container_port = 3005
      }

      resources {
        limits = {
          cpu    = var.den_web.cpu
          memory = var.den_web.memory
        }
      }

      startup_probe {
        http_get {
          path = "/api/health"
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 24
      }

      dynamic "env" {
        for_each = local.environment_list
        content {
          name  = env.key
          value = env.value
        }
      }


      dynamic "env" {
        for_each = var.managed_legacy ? {} : local.secret_refs
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
    }

    dynamic "vpc_access" {
      for_each = local.vpc_access
      content {
        egress = var.vpc_egress
        network_interfaces {
          network    = vpc_access.value.network
          subnetwork = vpc_access.value.subnetwork
        }
      }
    }
  }

  depends_on = [google_cloud_run_v2_service.api]
}
