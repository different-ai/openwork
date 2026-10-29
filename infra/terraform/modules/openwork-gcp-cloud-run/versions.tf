terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    google = {
      source = "hashicorp/google"
      # 8.0 adds run_execution_token, which runs the migration job during apply.
      version = "~> 8.7"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}
