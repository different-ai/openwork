# Offline check that the AWS root honours the provider-neutral contract.
# Mocked providers: no AWS credentials and no network. `terraform test`.

mock_provider "aws" {
  override_during = plan
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/test" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/test"
      domain_validation_options = [
        { domain_name = "openwork.example.com", resource_record_name = "_a.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
        { domain_name = "api.openwork.example.com", resource_record_name = "_b.api.openwork.example.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
      ]
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/test" }
  }
}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  deployment_id        = "0cf7aa5c-4c1a-43dc-ac34-819509b527fa"
  domain_name          = "openwork.example.com"
  owner_email          = "admin@example.com"
  openwork_version     = "0.18.57"
  control_plane_origin = "https://api.openworklabs.com"
  region               = "us-east-1"
  account_id           = "123456789012"
  route53_zone_id      = "ZTEST123"
}

run "contract_outputs" {
  command = plan
  assert {
    condition     = output.web_url == "https://openwork.example.com" && output.api_url == "https://api.openwork.example.com"
    error_message = "Contract URLs must derive from domain_name."
  }
  assert {
    condition     = module.contract.name == "ow-0cf7aa5c4c1a"
    error_message = "Resource names must match the CloudFormation bootstrap's scoping."
  }
  assert {
    condition     = output.health_agent == "openwork-0cf7aa5c4c1a43dcac34819509b527fa-health"
    error_message = "The health agent name must match the identity the control plane verifies."
  }
}

run "dedicated_network_by_default" {
  command = plan
  assert {
    condition     = length(module.network) == 1 && module.platform.service_names.den_api == "den-api"
    error_message = "A dedicated account gets its own VPC, and its services keep their unprefixed names."
  }
}

run "existing_vpc_and_cluster" {
  command = plan
  variables {
    network_mode             = "existing"
    vpc_id                   = "vpc-0123456789abcdef0"
    service_subnet_ids       = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
    load_balancer_subnet_ids = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
    ecs_cluster_arn          = "arn:aws:ecs:us-east-1:123456789012:cluster/platform"
  }
  assert {
    condition     = length(module.network) == 0
    error_message = "An existing network must not create a VPC, subnets or NAT gateway."
  }
  assert {
    condition     = module.platform.cluster_name == "platform" && module.platform.service_names.den_api == "ow-0cf7aa5c4c1a-den-api"
    error_message = "Services run in the customer's cluster with names unique to this deployment."
  }
}
