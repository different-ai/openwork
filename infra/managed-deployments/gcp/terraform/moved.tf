# Managed adoption changes addresses, not physical identities or secret bytes.
moved {
  from = google_sql_database_instance.main
  to   = module.platform.google_sql_database_instance.this[0]
}
moved {
  from = google_sql_database.main
  to   = module.platform.google_sql_database.den[0]
}
moved {
  from = google_sql_user.main
  to   = module.platform.google_sql_user.openwork[0]
}
moved {
  from = random_password.values["database"]
  to   = module.platform.random_password.db[0]
}
moved {
  from = random_password.values["auth"]
  to   = module.platform.random_password.better_auth
}
moved {
  from = random_password.values["encryption"]
  to   = module.platform.random_password.db_encryption
}
moved {
  from = random_password.values["bootstrap"]
  to   = module.platform.random_password.bootstrap_code
}
moved {
  from = google_secret_manager_secret.values["database-url"]
  to   = module.platform.google_secret_manager_secret.app["DATABASE_URL"]
}
moved {
  from = google_secret_manager_secret.values["auth"]
  to   = module.platform.google_secret_manager_secret.app["BETTER_AUTH_SECRET"]
}
moved {
  from = google_secret_manager_secret.values["encryption"]
  to   = module.platform.google_secret_manager_secret.app["DEN_DB_ENCRYPTION_KEY"]
}
moved {
  from = google_secret_manager_secret.values["bootstrap"]
  to   = module.platform.google_secret_manager_secret.app["DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"]
}
moved {
  from = google_secret_manager_secret_version.values["database-url"]
  to   = module.platform.google_secret_manager_secret_version.app["DATABASE_URL"]
}
moved {
  from = google_secret_manager_secret_version.values["auth"]
  to   = module.platform.google_secret_manager_secret_version.app["BETTER_AUTH_SECRET"]
}
moved {
  from = google_secret_manager_secret_version.values["encryption"]
  to   = module.platform.google_secret_manager_secret_version.app["DEN_DB_ENCRYPTION_KEY"]
}
moved {
  from = google_secret_manager_secret_version.values["bootstrap"]
  to   = module.platform.google_secret_manager_secret_version.app["DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"]
}
moved {
  from = google_secret_manager_secret_iam_member.runtime["database-url"]
  to   = module.platform.google_secret_manager_secret_iam_member.app["DATABASE_URL"]
}
moved {
  from = google_secret_manager_secret_iam_member.runtime["auth"]
  to   = module.platform.google_secret_manager_secret_iam_member.app["BETTER_AUTH_SECRET"]
}
moved {
  from = google_secret_manager_secret_iam_member.runtime["encryption"]
  to   = module.platform.google_secret_manager_secret_iam_member.app["DEN_DB_ENCRYPTION_KEY"]
}
moved {
  from = google_secret_manager_secret_iam_member.runtime["bootstrap"]
  to   = module.platform.google_secret_manager_secret_iam_member.app["DEN_INITIAL_ADMIN_BOOTSTRAP_CODE"]
}
moved {
  from = google_cloud_run_v2_job.migrate
  to   = module.platform.google_cloud_run_v2_job.migrate
}
moved {
  from = google_cloud_run_v2_service.services["den_api"]
  to   = module.platform.google_cloud_run_v2_service.api
}
moved {
  from = google_cloud_run_v2_service.services["den_web"]
  to   = module.platform.google_cloud_run_v2_service.web
}
moved {
  from = google_compute_region_network_endpoint_group.services["den_api"]
  to   = module.platform.google_compute_region_network_endpoint_group.run["api"]
}
moved {
  from = google_compute_region_network_endpoint_group.services["den_web"]
  to   = module.platform.google_compute_region_network_endpoint_group.run["web"]
}
moved {
  from = google_compute_backend_service.services["den_api"]
  to   = module.platform.google_compute_backend_service.run["api"]
}
moved {
  from = google_compute_backend_service.services["den_web"]
  to   = module.platform.google_compute_backend_service.run["web"]
}
moved {
  from = google_compute_global_address.main
  to   = module.platform.google_compute_global_address.lb[0]
}
moved {
  from = google_compute_managed_ssl_certificate.main
  to   = module.platform.google_compute_managed_ssl_certificate.this[0]
}
moved {
  from = google_compute_url_map.main
  to   = module.platform.google_compute_url_map.https[0]
}
moved {
  from = google_compute_target_https_proxy.main
  to   = module.platform.google_compute_target_https_proxy.this[0]
}
moved {
  from = google_compute_global_forwarding_rule.https
  to   = module.platform.google_compute_global_forwarding_rule.https[0]
}
