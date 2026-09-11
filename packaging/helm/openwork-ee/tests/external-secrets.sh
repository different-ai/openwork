#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_count() {
  local file="$1"
  local needle="$2"
  local expected="$3"
  local count
  count="$(grep -F -c -- "$needle" "$file" || true)"
  if [[ "$count" != "$expected" ]]; then
    printf 'Expected %s occurrences of %s, found %s\n' "$expected" "$needle" "$count" >&2
    return 1
  fi
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart to contain %s\n' "$needle" >&2
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart not to contain %s\n' "$needle" >&2
    return 1
  fi
}

assert_failure() {
  local values_file="$1"
  local expected="$2"
  local output_file="$tmp_dir/failure-output.yaml"
  local error_file="$tmp_dir/failure-error.txt"

  if helm template openwork-ee "$chart_dir" -f "$values_file" > "$output_file" 2> "$error_file"; then
    printf 'Expected helm template to fail for %s\n' "$values_file" >&2
    return 1
  fi
  assert_contains "$error_file" "$expected"
}

# Default render: no ExternalSecret, Secret still rendered from inline values.
default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_count "$default_rendered" 'kind: ExternalSecret' 0
assert_count "$default_rendered" 'kind: Secret' 1

# externalSecrets mode: ExternalSecret rendered from secret.keys, no v1/Secret.
enabled_values="$tmp_dir/enabled-values.yaml"
cat > "$enabled_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: external-secrets
    kind: ClusterSecretStore
  pathPrefix: "eks/openwork/prod/den"
  refreshInterval: 5m
YAML
enabled_rendered="$tmp_dir/enabled.yaml"
helm template openwork-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered"
assert_count "$enabled_rendered" 'kind: ExternalSecret' 1
assert_count "$enabled_rendered" 'kind: Secret' 0
assert_contains "$enabled_rendered" 'apiVersion: external-secrets.io/v1beta1'
assert_contains "$enabled_rendered" 'name: "external-secrets"'
assert_contains "$enabled_rendered" 'kind: ClusterSecretStore'
assert_count "$enabled_rendered" 'refreshInterval: "5m"' 1
assert_contains "$enabled_rendered" 'creationPolicy: Owner'
assert_contains "$enabled_rendered" 'deletionPolicy: Retain'
assert_count "$enabled_rendered" 'dataFrom:' 0
# spec.data renders the three boot-critical keys only by default (ESO remoteRef
# has no skip-if-missing, so optional keys are opt-in via optionalKeys).
assert_count "$enabled_rendered" 'secretKey:' 3
assert_contains "$enabled_rendered" 'secretKey: "DATABASE_URL"'
assert_contains "$enabled_rendered" 'secretKey: "BETTER_AUTH_SECRET"'
assert_contains "$enabled_rendered" 'secretKey: "DEN_DB_ENCRYPTION_KEY"'
assert_not_contains "$enabled_rendered" 'secretKey: "SMTP_PASS"'
assert_not_contains "$enabled_rendered" 'secretKey: "DAYTONA_API_KEY"'
# Remote keys resolve to pathPrefix + env key name.
assert_contains "$enabled_rendered" 'key: "eks/openwork/prod/den/DATABASE_URL"'
assert_contains "$enabled_rendered" 'key: "eks/openwork/prod/den/DEN_DB_ENCRYPTION_KEY"'
# Uniform strategies on every entry.
assert_count "$enabled_rendered" 'conversionStrategy: Default' 3
assert_count "$enabled_rendered" 'decodingStrategy: None' 3
assert_count "$enabled_rendered" 'metadataPolicy: None' 3
# remoteRef.optional does not exist in the ESO CRD; it must never render.
assert_not_contains "$enabled_rendered" 'optional:'

# optionalKeys pulls additional keys; sorted with the required three.
optional_keys_values="$tmp_dir/optional-keys-values.yaml"
cat > "$optional_keys_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: external-secrets
    kind: ClusterSecretStore
  pathPrefix: "eks/openwork/prod/den"
  optionalKeys:
    - smtpPass
    - databaseRedisUrl
YAML
optional_keys_rendered="$tmp_dir/optional-keys.yaml"
helm template openwork-ee "$chart_dir" -f "$optional_keys_values" > "$optional_keys_rendered"
assert_count "$optional_keys_rendered" 'secretKey:' 5
assert_contains "$optional_keys_rendered" 'secretKey: "SMTP_PASS"'
assert_contains "$optional_keys_rendered" 'secretKey: "DATABASE_REDIS_URL"'
assert_contains "$optional_keys_rendered" 'key: "eks/openwork/prod/den/SMTP_PASS"'

# Adding an optionalKeys entry must roll the workloads: in ESO mode secret.yaml
# renders empty, so checksum/secret hashes the resolved key set (required +
# optionalKeys) to change the pod template when the key set changes. envFrom
# keys are fixed at pod start, so without this the new key never reaches pods.
checksum_annotation() {
  grep 'checksum/secret:' "$1" | sort -u
}
if [[ "$(checksum_annotation "$enabled_rendered")" == "$(checksum_annotation "$optional_keys_rendered")" ]]; then
  printf 'Expected checksum/secret to change when optionalKeys changes\n' >&2
  exit 1
fi
# Stable across renders of the same values (no spurious rolls).
enabled_rendered_2="$tmp_dir/enabled-2.yaml"
helm template openwork-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered_2"
if [[ "$(checksum_annotation "$enabled_rendered")" != "$(checksum_annotation "$enabled_rendered_2")" ]]; then
  printf 'Expected checksum/secret to be stable across identical renders\n' >&2
  exit 1
fi

# Unknown optionalKeys entries fail fast.
bad_optional_values="$tmp_dir/bad-optional-values.yaml"
cat > "$bad_optional_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  pathPrefix: trunk
  optionalKeys:
    - notARealKey
YAML
assert_failure "$bad_optional_values" 'externalSecrets.optionalKeys contains "notARealKey", which is not a known secret.keys.* name'
# Target Secret keeps the chart secret name so envFrom/secretKeyRef wiring holds.
# 7 name: occurrences: ExternalSecret metadata.name + target.name, envFrom in
assert_count "$enabled_rendered" 'name: "openwork-ee-secret"' 7
assert_count "$enabled_rendered" 'secretKeyRef:' 2
# The migration Job waits for the asynchronously materialized Secret instead of
# failing on a missing one, and the ExternalSecret applies before the Job
# (hook weight -10 precedes the Job's -5).
assert_contains "$enabled_rendered" 'name: wait-for-secret'
# Workloads + migration Job all get the wait initContainer in ESO mode (inference
# is off by default): den-api, den-web, migrate Job.
assert_count "$enabled_rendered" 'name: wait-for-secret' 3
assert_contains "$enabled_rendered" 'until kubectl get secret "$SECRET" -n "$NS"'
# Workloads run under the dedicated SA so the initContainer can read the Secret.
assert_count "$enabled_rendered" 'serviceAccountName: openwork-ee-workload' 2
assert_contains "$enabled_rendered" 'image: "bitnami/kubectl:1.33.4"'
assert_not_contains "$enabled_rendered" 'kubectl:latest'
# Default optional-key wait is 60s.
assert_contains "$enabled_rendered" '+ 60 ))'

# optionalKeyWaitSeconds: 0 must render 0, not be coerced to the 60s default
# (Helm `default` treats numeric 0 as empty).
zero_wait_values="$tmp_dir/zero-wait-values.yaml"
cat > "$zero_wait_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  pathPrefix: trunk
  optionalKeys: [smtpPass]
  optionalKeyWaitSeconds: 0
YAML
zero_wait_rendered="$tmp_dir/zero-wait.yaml"
helm template openwork-ee "$chart_dir" -f "$zero_wait_values" > "$zero_wait_rendered"
assert_contains "$zero_wait_rendered" '+ 0 ))'
assert_not_contains "$zero_wait_rendered" '+ 60 ))'

# Whitespace is trimmed at render, matching validation: a padded store name,
# prefix, and existingSecret render trimmed rather than failing or embedding
# spaces.
padded_values="$tmp_dir/padded-values.yaml"
cat > "$padded_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: "  external-secrets  "
  pathPrefix: "  eks/openwork/prod/den  "
YAML
padded_rendered="$tmp_dir/padded.yaml"
helm template openwork-ee "$chart_dir" -f "$padded_values" > "$padded_rendered"
assert_contains "$padded_rendered" 'name: "external-secrets"'
assert_contains "$padded_rendered" 'key: "eks/openwork/prod/den/DATABASE_URL"'
assert_not_contains "$padded_rendered" '  external-secrets'
assert_not_contains "$padded_rendered" ' eks/openwork'

# existingSecret with padding renders the trimmed name everywhere.
padded_existing_values="$tmp_dir/padded-existing-values.yaml"
cat > "$padded_existing_values" <<'YAML'
secret:
  secretsMode: existingSecret
  create: false
  existingSecret: "  padded-secret  "
YAML
padded_existing_rendered="$tmp_dir/padded-existing.yaml"
helm template openwork-ee "$chart_dir" -f "$padded_existing_values" > "$padded_existing_rendered"
assert_count "$padded_existing_rendered" 'name: "padded-secret"' 5
assert_not_contains "$padded_existing_rendered" '  padded-secret'

# Hook ordering for the migration chain: Namespace (-11) -> ExternalSecret
# (-10) -> migration RBAC (-6) -> migration Job (-5).
assert_count "$enabled_rendered" 'helm.sh/hook-weight": "-11"' 1
assert_count "$enabled_rendered" 'helm.sh/hook-weight": "-10"' 1
assert_count "$enabled_rendered" 'helm.sh/hook-weight": "-6"' 3
assert_count "$enabled_rendered" 'helm.sh/hook-weight": "-5"' 1

# Inline mode renders no wait RBAC/initContainer and keeps the migration hook
# without the ExternalSecret hook annotations.
assert_count "$default_rendered" 'name: wait-for-secret' 0
assert_count "$default_rendered" 'kind: ServiceAccount' 0
assert_contains "$default_rendered" 'helm.sh/hook": pre-install,pre-upgrade'
assert_count "$default_rendered" 'helm.sh/hook-weight": "-10"' 0
# Inline secret values never appear in any rendered manifest.
assert_not_contains "$enabled_rendered" 'CHANGE_ME_32_CHARS_MINIMUM_BETTER_AUTH'
assert_not_contains "$enabled_rendered" 'change-me@mysql'

# Renamed target keys via secret.keys flow into both secretKey and remote path.
renamed_values="$tmp_dir/renamed-values.yaml"
cat > "$renamed_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
  keys:
    databaseUrl: CUSTOM_DB_URL
externalSecrets:
  secretStoreRef:
    name: store
  pathPrefix: "trunk"
YAML
renamed_rendered="$tmp_dir/renamed.yaml"
helm template openwork-ee "$chart_dir" -f "$renamed_values" > "$renamed_rendered"
assert_contains "$renamed_rendered" 'secretKey: "CUSTOM_DB_URL'
assert_contains "$renamed_rendered" 'key: "trunk/CUSTOM_DB_URL"'
assert_not_contains "$renamed_rendered" 'secretKey: "DATABASE_URL'

# Strategy overrides apply uniformly to every entry.
strategy_values="$tmp_dir/strategy-values.yaml"
cat > "$strategy_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: store
  pathPrefix: "trunk"
  decodingStrategy: Base64
  target:
    deletionPolicy: Delete
YAML
strategy_rendered="$tmp_dir/strategy.yaml"
helm template openwork-ee "$chart_dir" -f "$strategy_values" > "$strategy_rendered"
assert_count "$strategy_rendered" 'decodingStrategy: Base64' 3
assert_contains "$strategy_rendered" 'deletionPolicy: Delete'

# Capability-aware apiVersion selection: v1 served -> v1 rendered.
v1_rendered="$tmp_dir/v1.yaml"
helm template openwork-ee "$chart_dir" -f "$enabled_values" \
  --api-versions external-secrets.io/v1 > "$v1_rendered"
assert_contains "$v1_rendered" 'apiVersion: external-secrets.io/v1'
assert_not_contains "$v1_rendered" 'apiVersion: external-secrets.io/v1beta1'

# Validation failures.
bad_mode_values="$tmp_dir/bad-mode-values.yaml"
cat > "$bad_mode_values" <<'YAML'
secret:
  secretsMode: vault
YAML
assert_failure "$bad_mode_values" 'secretsMode must be one of inline, existingSecret, externalSecrets'

existing_no_name_values="$tmp_dir/existing-no-name-values.yaml"
cat > "$existing_no_name_values" <<'YAML'
secret:
  secretsMode: existingSecret
  create: false
YAML
assert_failure "$existing_no_name_values" 'secret.existingSecret is required when secretsMode=existingSecret'

inline_with_existing_values="$tmp_dir/inline-with-existing-values.yaml"
cat > "$inline_with_existing_values" <<'YAML'
secret:
  existingSecret: manually-managed
YAML
assert_failure "$inline_with_existing_values" 'secret.existingSecret is only allowed when secretsMode=existingSecret'

eso_with_create_values="$tmp_dir/eso-with-create-values.yaml"
cat > "$eso_with_create_values" <<'YAML'
secret:
  secretsMode: externalSecrets
externalSecrets:
  secretStoreRef:
    name: store
  pathPrefix: trunk
YAML
assert_failure "$eso_with_create_values" 'secret.create must be false when secretsMode is not inline'

no_store_values="$tmp_dir/no-store-values.yaml"
cat > "$no_store_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  pathPrefix: trunk
  secretStoreRef:
    name: ""
YAML
assert_failure "$no_store_values" 'externalSecrets.secretStoreRef.name is required when secretsMode=externalSecrets'

blank_store_values="$tmp_dir/blank-store-values.yaml"
cat > "$blank_store_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: "   "
  pathPrefix: trunk
YAML
assert_failure "$blank_store_values" 'externalSecrets.secretStoreRef.name is required when secretsMode=externalSecrets'

bad_kind_values="$tmp_dir/bad-kind-values.yaml"
cat > "$bad_kind_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: store
    kind: VaultStore
  pathPrefix: trunk
YAML
assert_failure "$bad_kind_values" 'externalSecrets.secretStoreRef.kind must be SecretStore or ClusterSecretStore'

no_prefix_values="$tmp_dir/no-prefix-values.yaml"
cat > "$no_prefix_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: store
YAML
assert_failure "$no_prefix_values" 'externalSecrets.pathPrefix is required when secretsMode=externalSecrets'

blank_prefix_values="$tmp_dir/blank-prefix-values.yaml"
cat > "$blank_prefix_values" <<'YAML'
secret:
  secretsMode: externalSecrets
  create: false
externalSecrets:
  secretStoreRef:
    name: store
  pathPrefix: "   "
YAML
assert_failure "$blank_prefix_values" 'externalSecrets.pathPrefix is required when secretsMode=externalSecrets'

blank_existing_values="$tmp_dir/blank-existing-values.yaml"
cat > "$blank_existing_values" <<'YAML'
secret:
  secretsMode: existingSecret
  create: false
  existingSecret: "   "
YAML
assert_failure "$blank_existing_values" 'secret.existingSecret is required when secretsMode=existingSecret'

existing_with_create_values="$tmp_dir/existing-with-create-values.yaml"
cat > "$existing_with_create_values" <<'YAML'
secret:
  secretsMode: existingSecret
  existingSecret: manually-managed
YAML
assert_failure "$existing_with_create_values" 'secret.create must be false when secretsMode is not inline'

empty_mode_values="$tmp_dir/empty-mode-values.yaml"
cat > "$empty_mode_values" <<'YAML'
secret:
  secretsMode: ""
YAML
assert_failure "$empty_mode_values" 'secretsMode must be one of inline, existingSecret, externalSecrets'

# Legacy shim: inline mode with create=false and untouched placeholder values
# auto-corrects to existingSecret (no Secret rendered, no inline env values).
legacy_shim_values="$tmp_dir/legacy-shim-values.yaml"
cat > "$legacy_shim_values" <<'YAML'
secret:
  create: false
YAML
legacy_shim_rendered="$tmp_dir/legacy-shim.yaml"
helm template openwork-ee "$chart_dir" -f "$legacy_shim_values" > "$legacy_shim_rendered"
assert_count "$legacy_shim_rendered" 'kind: Secret' 0
assert_count "$legacy_shim_rendered" 'kind: ExternalSecret' 0
assert_not_contains "$legacy_shim_rendered" 'change-me@mysql'
assert_not_contains "$legacy_shim_rendered" 'CHANGE_ME_32_CHARS_MINIMUM'

# The shim must also apply when the migration Job is rendered in isolation:
# --show-only skips configmap/secret templates, so the Job template has to run
# the validator (and shim) itself before its secretsMode check.
job_only_rendered="$tmp_dir/job-only.yaml"
helm template openwork-ee "$chart_dir" -f "$legacy_shim_values" \
  --show-only templates/migration-job.yaml > "$job_only_rendered"
assert_contains "$job_only_rendered" 'secretKeyRef:'
assert_not_contains "$job_only_rendered" 'change-me@mysql'
assert_not_contains "$job_only_rendered" 'CHANGE_ME_32_CHARS_MINIMUM'

# The RBAC template applies the same validation/shim when rendered in
# isolation: with legacy create=false values it renders the wait RBAC
# (existingSecret branch), and an invalid secretsMode fails fast.
rbac_only_rendered="$tmp_dir/rbac-only.yaml"
helm template openwork-ee "$chart_dir" -f "$legacy_shim_values" \
  --show-only templates/migration-rbac.yaml > "$rbac_only_rendered"
# ServiceAccount manifest + RoleBinding subject both carry "kind: ServiceAccount".
assert_count "$rbac_only_rendered" 'kind: ServiceAccount' 2

rbac_only_bad="$tmp_dir/rbac-only-bad.yaml"
cat > "$rbac_only_bad" <<'YAML'
secret:
  secretsMode: vault
YAML
if helm template openwork-ee "$chart_dir" -f "$rbac_only_bad" \
  --show-only templates/migration-rbac.yaml > /dev/null 2>&1; then
  printf 'Expected helm template to fail for invalid secretsMode in migration-rbac.yaml\n' >&2
  exit 1
fi

# inline + create=false with REAL-looking values is incoherent: fail, never
# silently reroute someone's credentials.
inline_real_values="$tmp_dir/inline-real-values.yaml"
cat > "$inline_real_values" <<'YAML'
secret:
  create: false
  values:
    databaseUrl: "mysql://app:s3cret@db.internal:3306/openwork_den"
    betterAuthSecret: "real-auth-secret-value-here-32chars"
    denDbEncryptionKey: "real-encryption-key-value-here-32ch"
YAML
assert_failure "$inline_real_values" 'secret.create must be true when secretsMode=inline'

# Partially real values must also fail: a real DSN with untouched CHANGE_ME
# placeholders is not a legacy untouched file — rerouting it would silently
# drop the real DSN the operator set.
inline_partial_values="$tmp_dir/inline-partial-values.yaml"
cat > "$inline_partial_values" <<'YAML'
secret:
  create: false
  values:
    databaseUrl: "mysql://app:s3cret@db.internal:3306/openwork_den"
YAML
assert_failure "$inline_partial_values" 'secret.create must be true when secretsMode=inline'

# existingSecret mode renders no Secret and no ExternalSecret.
existing_rendered="$tmp_dir/existing.yaml"
cat > "$tmp_dir/existing-values.yaml" <<'YAML'
secret:
  secretsMode: existingSecret
  create: false
  existingSecret: manually-managed
YAML
helm template openwork-ee "$chart_dir" -f "$tmp_dir/existing-values.yaml" > "$existing_rendered"
assert_count "$existing_rendered" 'kind: Secret' 0
assert_count "$existing_rendered" 'kind: ExternalSecret' 0
assert_count "$existing_rendered" 'name: "manually-managed"' 5

printf 'external-secrets chart checks passed\n'
