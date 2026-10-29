# Existing installations must explicitly retain compatibility mode or supply
# their exact existing values. Missing ephemeral values fail validation before
# changing state; upgrading the module must never silently rotate keys.
variable "write_only_secrets" {
  description = "Use ephemeral secret_values_wo and provider write-only fields. False preserves legacy random resources/state without rotating existing secrets; see the migration notes."
  type        = bool
  default     = true
}

variable "secret_values_wo" {
  description = "Ephemeral core secrets, supplied on every apply in write-only mode. For migration, supply the exact existing values, never new auth/encryption keys."
  type = object({
    database_password  = string
    better_auth_secret = string
    db_encryption_key  = string
    bootstrap_code     = string
    database_url       = optional(string, "")
  })
  sensitive = true
  ephemeral = true
  default   = { database_password = "", better_auth_secret = "", db_encryption_key = "", bootstrap_code = "" }
  validation {
    condition = !var.write_only_secrets || (
      length(var.secret_values_wo.better_auth_secret) >= 32 &&
      length(var.secret_values_wo.db_encryption_key) >= 32 &&
      length(var.secret_values_wo.bootstrap_code) >= 16 &&
      (var.create_database ? length(var.secret_values_wo.database_password) >= 16 : can(regex("[?&](sslaccept=strict|sslmode=verify-full)(&|$)", var.secret_values_wo.database_url)))
    )
    error_message = "Write-only mode needs persistent auth/encryption keys (32+), bootstrap code (16+) and managed database password (16+)."
  }
}

variable "secrets_version" {
  description = "Explicit write-only secret update counter. Keep unchanged for normal upgrades; supply identical persistent auth/encryption keys when changing it."
  type        = number
  default     = 1
}

locals {
  secret_values_wo = merge(local.secret_values, {
    DATABASE_URL = var.create_database ? format(
      "mysql://%s:%s@%s:%d/%s?%s",
      aws_db_instance.this[0].username, urlencode(var.secret_values_wo.database_password),
      aws_db_instance.this[0].address, aws_db_instance.this[0].port,
      aws_db_instance.this[0].db_name, var.database.tls_query
    ) : var.secret_values_wo.database_url
    BETTER_AUTH_SECRET               = var.secret_values_wo.better_auth_secret
    DEN_DB_ENCRYPTION_KEY            = var.secret_values_wo.db_encryption_key
    DEN_INITIAL_ADMIN_BOOTSTRAP_CODE = var.secret_values_wo.bootstrap_code
  })
}

moved {
  from = random_password.better_auth
  to   = random_password.better_auth[0]
}
moved {
  from = random_password.db_encryption
  to   = random_password.db_encryption[0]
}
moved {
  from = random_password.bootstrap_code
  to   = random_password.bootstrap_code[0]
}

variable "deletion_protection" {
  description = "Protect managed RDS from deletion. Explicitly disable only for disposable tests. database.deletion_protection remains a deprecated override."
  type        = bool
  default     = true
}

variable "migration_run_id" {
  description = "Change only to intentionally rerun a completed migration with the same task definition. Inspect failed/unknown executions before changing. One Terraform state/release coordinator must own the physical database."
  type        = string
  default     = "initial"
}

variable "database_ca_bundle" {
  description = "PEM trust roots for an existing MySQL database. Empty fetches the public AWS RDS regional bundle over HTTPS. Never put a private key here."
  type        = string
  default     = ""
}

data "http" "rds_ca" {
  count    = var.database_ca_bundle == "" ? 1 : 0
  url      = "https://truststore.pki.rds.amazonaws.com/${local.region}/${local.region}-bundle.pem"
  insecure = false
  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && strcontains(self.response_body, "-----BEGIN CERTIFICATE-----")
      error_message = "The RDS CA bundle must be fetched successfully over verified HTTPS."
    }
  }
}

locals {
  database_ca_bundle = var.database_ca_bundle != "" ? var.database_ca_bundle : data.http.rds_ca[0].response_body
  # Public CA material only. Node loads extra roots before starting the process;
  # the MySQL parser's sslaccept=strict enforces certificate verification.
  tls_check = <<-JS
    const fs = require("node:fs");
    const { X509Certificate } = require("node:crypto");
    try {
      const url = new URL(process.env.DATABASE_URL);
      const modes = [...url.searchParams].filter(([key]) => ["sslaccept", "sslmode"].includes(key));
      if (url.protocol !== "mysql:" || modes.length !== 1 || !["sslaccept=strict", "sslmode=verify-full"].includes(modes[0].join("="))) throw new Error();
      const certificates = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
        .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!certificates || !certificates.length) throw new Error();
      for (const certificate of certificates) new X509Certificate(certificate);
      console.log("OPENWORK_MANAGED_DB_TLS mode=strict ca=validated");
    } catch {
      console.error("Database TLS configuration rejected.");
      process.exit(1);
    }
  JS
  tls_setup = "printf '%s' '${base64encode(local.database_ca_bundle)}' | base64 -d > /tmp/openwork-db-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/openwork-db-ca.pem; printf '%s' '${base64encode(local.tls_check)}' | base64 -d > /tmp/openwork-db-tls-check.cjs; node /tmp/openwork-db-tls-check.cjs; "
}

resource "terraform_data" "security_contract" {
  input = "contract-v1"
  lifecycle {
    precondition {
      condition = alltrue([for image in concat(
        [local.den_api_image, local.den_web_image],
        local.web_enabled ? [local.den_gateway_image] : [],
        local.runner_managed ? [local.runner_image] : [],
        local.workbot_enabled ? [local.workbot_image] : []
      ) : can(regex("@sha256:[0-9a-f]{64}$", image))])
      error_message = "Every enabled image must be pinned with @sha256:<64 hex characters>; pass digest overrides for optional services."
    }
    precondition {
      condition     = var.create_database ? contains(["sslaccept=strict", "sslmode=verify-full"], var.database.tls_query) : (var.write_only_secrets || can(regex("[?&](sslaccept=strict|sslmode=verify-full)(&|$)", var.database_url)))
      error_message = "Database connections must verify TLS: use sslaccept=strict or sslmode=verify-full and the correct CA bundle."
    }
    precondition {
      condition = alltrue([for key in keys(var.extra_environment) :
        !can(regex("(?i)(secret|password|passwd|token|api_key|private_key|encryption_key|^DATABASE_URL$|^DATABASE_REDIS_URL$|^SMTP_(USER|PASS)$)", key)) &&
        !contains(keys(var.extra_secrets), key)
      ])
      error_message = "Secret settings belong in extra_secrets, not extra_environment; environment and secret names must not collide."
    }
  }
}
