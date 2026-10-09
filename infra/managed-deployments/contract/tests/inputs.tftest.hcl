variables {
  deployment_id        = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.57"
  control_plane_origin = "https://api.openworklabs.com"
}

run "derives_names_and_urls" {
  command = plan
  assert {
    condition     = output.name == "ow-0cf7aa5c4c1a" && output.compact_id == "0cf7aa5c4c1a43dcac34819509b527fa"
    error_message = "Names must stay stable; bootstrap IAM scoping depends on them."
  }
  assert {
    condition     = output.api_url == "https://api.openwork.example.com"
    error_message = "The API is served at api.<domain_name>."
  }
}

run "rejects_mutable_versions" {
  command = plan
  variables {
    openwork_version = "latest"
  }
  expect_failures = [var.openwork_version]
}

run "rejects_plain_http_control_plane" {
  command = plan
  variables {
    control_plane_origin = "http://api.example.com"
  }
  expect_failures = [var.control_plane_origin]
}

run "rejects_uppercase_or_url_domains" {
  command = plan
  variables {
    domain_name = "https://OpenWork.example.com"
  }
  expect_failures = [var.domain_name]
}

run "only_small_size" {
  command = plan
  variables {
    size = "xlarge"
  }
  expect_failures = [var.size]
}
