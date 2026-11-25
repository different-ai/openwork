# Removal by a customer who has taken the deployment over.
mock_provider "google" {}
provider "random" {} # Local-only; ephemeral mocks are unsupported.

override_data {
  target = data.google_project.target
  values = { number = "123456789012" }
}
override_data {
  target = data.google_dns_managed_zone.target
  values = { dns_name = "example.com.", visibility = "public" }
}
variables {
  deployment_id        = "12345678-1234-1234-1234-123456789012"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.0"
  control_plane_origin = "https://api.example.com"
  size                 = "small"
  project_id           = "test-project"
  project_number       = "123456789012"
  region               = "us-central1"
  dns_zone_name        = "public-zone"
  images = {
    den_api = "us-central1-docker.pkg.dev/test-project/ow-123456781234/den_api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    den_web = "us-central1-docker.pkg.dev/test-project/ow-123456781234/den_web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    health  = "us-central1-docker.pkg.dev/test-project/ow-123456781234/health@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}
run "managed_run_keeps_deletion_protection" {
  command = plan
}
run "removal_turns_protection_off_only_when_asked" {
  command = plan
  variables { allow_destroy = true }
}
