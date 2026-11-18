# Native synthetic state migration, not a Google 6 -> 8 provider refresh proof.
mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
  mock_data "google_dns_managed_zone" { defaults = { dns_name = "example.com.", visibility = "public" } }
  mock_resource "google_sql_database_instance" { defaults = { connection_name = "test-project:us-central1:ow-123456781234-mysql" } }
}
provider "random" {}
variables {
  deployment_id        = "12345678-1234-1234-1234-123456789012"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.58"
  control_plane_origin = "https://api.example.com"
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
run "legacy_managed_data" {
  command   = apply
  state_key = "managed"
  module { source = "./tests/legacy" }
}
run "adopt_managed_data" {
  command   = plan
  state_key = "managed"
}
