terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.9"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    azapi = {
      source                = "Azure/azapi"
      version               = "~> 2.13"
      configuration_aliases = [azapi.secret_read]
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}
