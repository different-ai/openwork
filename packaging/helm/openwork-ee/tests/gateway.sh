#!/usr/bin/env bash
# Render-only compatibility matrix. Requires Helm 3; no cluster or credentials.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
passed=0
failed=0
rendered="$tmp_dir/rendered.yaml"
errors="$tmp_dir/errors.txt"
valid=(--set gateway.enabled=true
  --set config.internal.gatewayProxyBaseUrl=http://openwork-ee-inference:8791
  --set config.public.gatewayPublicBaseUrl=https://gateway.example.com
  --set secret.create=false --set secret.existingSecret=gateway-test)
created=("${valid[@]}" --set secret.create=true
  --set secret.values.databaseUrl=mysql://test:fixture@mysql:3306/openwork
  --set secret.values.denDbEncryptionKey=fixture-encryption-key-at-least-32-characters)

render() {
  helm template openwork-ee "$chart_dir" --skip-tests "$@" > "$rendered" 2> "$errors"
}
contains() { grep -Fq -- "$1" "$rendered"; }
absent() { ! contains "$1"; }
count() { [[ "$(grep -Fc -- "$1" "$rendered" || true)" == "$2" ]]; }
env_value() { grep -A1 -F -- "- name: $1" "$rendered" | grep -Fq -- "value: \"$2\""; }
reject() {
  local expected="$1"
  shift
  if render "$@"; then return 1; fi
  grep -Fq -- "$expected" "$errors" && ! grep -Fq -- 'do-not-disclose' "$errors"
}
check() {
  local name="$1"
  shift
  # Each case is a subprocess with errexit, not a conditional (which disables it).
  set +e
  ( set -e; "$@" )
  local status=$?
  set -e
  if [[ "$status" == 0 ]]; then
    passed=$((passed + 1))
    printf 'PASS %s\n' "$name"
  else
    failed=$((failed + 1))
    printf 'FAIL %s (exit %s)\n' "$name" "$status" >&2
  fi
}

defaults() {
  render
  absent 'name: openwork-ee-inference'
  absent 'INFERENCE_PROXY_BASE_URL:'
  env_value GATEWAY_ENABLED false
  count '- name: GATEWAY_ENABLED' 1
}
legacy() {
  render --set inference.enabled=true --set inference.service.port=9876
  contains 'name: openwork-ee-inference'
  contains 'INFERENCE_PROXY_BASE_URL: "http://openwork-ee-inference:9876"'
  absent 'GATEWAY_PROXY_BASE_URL:'
  count '- name: GATEWAY_ENABLED' 2
  count 'value: "false"' 2
}
enabled() {
  render "${valid[@]}"
  count '- name: GATEWAY_ENABLED' 2
  count 'value: "true"' 2
  count '- name: GATEWAY_PUBLIC_BASE_URL' 2
  env_value GATEWAY_PROXY_BASE_URL http://openwork-ee-inference:8791
  env_value INFERENCE_PROXY_BASE_URL https://gateway.example.com
  contains 'INFERENCE_PROXY_BASE_URL: "https://gateway.example.com"'
  count 'key: "DEN_DB_ENCRYPTION_KEY"' 2
  count 'key: "DATABASE_URL"' 2
  count 'optional: false' 4
  env_value GATEWAY_ADMIN_TOKEN ''
  env_value INFERENCE_ADMIN_TOKEN ''
  env_value GATEWAY_WEBHOOK_SECRET ''
  absent 'den-gateway'
}
disabled_wins() {
  render --set inference.enabled=true --set gateway.enabled=false --set inference.retention.enabled=true
  absent 'name: openwork-ee-inference'
  absent 'kind: CronJob'
  env_value GATEWAY_ENABLED false
}
structural() {
  render "${valid[@]}" --set inference.replicaCount=5 --set gateway.replicaCount=0 \
    --set inference.service.port=9876 --set gateway.service.port=8792 \
    --set gateway.containerPort=8793 --set inference.service.loadBalancerClass=old \
    --set-string gateway.service.loadBalancerClass= \
    --set-json 'inference.service.loadBalancerSourceRanges=["192.0.2.0/24"]' \
    --set-json 'gateway.service.loadBalancerSourceRanges=[]' \
    --set inference.service.annotations.old=discard --set-json 'gateway.service.annotations={}' \
    --set inference.env.OLD=discard --set-json 'gateway.env={}' \
    --set inference.podLabels.old=discard --set-json 'gateway.podLabels={}' \
    --set inference.podAnnotations.old=discard --set-json 'gateway.podAnnotations={}' \
    --set inference.resources.limits.cpu=2 --set-json 'gateway.resources={}' \
    --set-json 'gateway.probes={}'
  contains 'replicas: 0'
  contains 'port: 8792'
  contains 'containerPort: 8793'
  env_value PORT 8793
  absent 'discard'
  absent '192.0.2.0/24'
  absent 'loadBalancerClass:'
  absent 'cpu: 2'
  # Only Den API and Den Web probes remain.
  count 'livenessProbe:' 2
  count 'readinessProbe:' 2
}
sparse() {
  render "${valid[@]}" --set inference.env.KEEP=legacy --set gateway.env.NEW=canonical \
    --set inference.service.annotations.keep=legacy --set gateway.service.annotations.new=canonical \
    --set inference.probes.readiness.periodSeconds=21 --set gateway.probes.readiness.timeoutSeconds=9
  env_value KEEP legacy
  env_value NEW canonical
  contains 'keep: legacy'
  contains 'new: canonical'
  contains 'periodSeconds: 21'
  contains 'timeoutSeconds: 9'
}
empty_url() {
  render --set inference.enabled=true --set config.internal.inferenceProxyBaseUrl=https://legacy.example.com \
    --set-string config.internal.gatewayProxyBaseUrl=
  contains 'GATEWAY_PROXY_BASE_URL: ""'
  contains 'INFERENCE_PROXY_BASE_URL: "https://legacy.example.com"'
}
legacy_url() {
  render --set gateway.enabled=true --set config.internal.inferenceProxyBaseUrl=http://legacy:8791 \
    --set config.public.gatewayPublicBaseUrl=https://gateway.example.com \
    --set secret.create=false --set secret.existingSecret=gateway-test
  env_value GATEWAY_PROXY_BASE_URL http://legacy:8791
  env_value INFERENCE_PROXY_BASE_URL http://legacy:8791
}
canonical_url() {
  render "${valid[@]}" --set config.internal.inferenceProxyBaseUrl=https://legacy.example.com
  count '- name: INFERENCE_PROXY_BASE_URL' 2
  count 'value: "https://legacy.example.com"' 2
  contains 'INFERENCE_PROXY_BASE_URL: "https://legacy.example.com"'
  contains 'GATEWAY_PROXY_BASE_URL: "http://openwork-ee-inference:8791"'
  env_value INFERENCE_PROXY_BASE_URL https://legacy.example.com
  env_value GATEWAY_PROXY_BASE_URL http://openwork-ee-inference:8791
  env_value GATEWAY_PUBLIC_BASE_URL https://gateway.example.com
}
disabled_canonical_url() {
  render --set inference.enabled=true --set config.internal.inferenceProxyBaseUrl=https://legacy.example.com \
    --set config.internal.gatewayProxyBaseUrl=http://gateway:8791
  env_value GATEWAY_PROXY_BASE_URL http://gateway:8791
  env_value INFERENCE_PROXY_BASE_URL https://legacy.example.com
  contains 'INFERENCE_PROXY_BASE_URL: "https://legacy.example.com"'
}
disabled_public_url() {
  render "${valid[@]}" --set gateway.enabled=false --set config.internal.inferenceProxyBaseUrl=https://models.example.com
  env_value GATEWAY_ENABLED false
  env_value INFERENCE_PROXY_BASE_URL https://models.example.com
  env_value GATEWAY_PUBLIC_BASE_URL https://gateway.example.com
  # Retain the legacy component without management admission, with public-only config.
  render --set inference.enabled=true --set config.internal.gatewayProxyBaseUrl=http://gateway:8791 \
    --set config.public.gatewayPublicBaseUrl=https://gateway.example.com
  count '- name: GATEWAY_ENABLED' 2
  env_value GATEWAY_ENABLED false
  env_value INFERENCE_PROXY_BASE_URL https://gateway.example.com
  count '- name: GATEWAY_PUBLIC_BASE_URL' 2
  absent 'optional: false'
}
legacy_env() {
  render --set inference.enabled=true --set inference.env.INFERENCE_PROXY_BASE_URL=https://legacy.example.com
  env_value INFERENCE_PROXY_BASE_URL https://legacy.example.com
  absent 'GATEWAY_PROXY_BASE_URL'
}
retention() {
  render "${valid[@]}" --set gateway.retention.enabled=true \
    --set gateway.retention.adminTokenSecret=retention-only --set gateway.retention.adminTokenKey=shared-token
  contains 'name: openwork-ee-inference-retention'
  count 'name: "retention-only"' 4
  count 'key: "shared-token"' 4
  count '- name: GATEWAY_ADMIN_TOKEN' 2
  count '- name: INFERENCE_ADMIN_TOKEN' 2
  contains 'Bearer ${process.env.GATEWAY_ADMIN_TOKEN}'
  contains '/internal/rollups/run'
}
legacy_retention() {
  render --set inference.enabled=true --set inference.retention.enabled=true \
    --set inference.retention.adminTokenSecret=retention-only
  count 'name: "retention-only"' 4
  count '- name: GATEWAY_ENABLED' 2
  env_value GATEWAY_ENABLED false
}
retention_disabled() {
  render "${valid[@]}" --set inference.retention.enabled=true --set gateway.retention.enabled=false
  absent 'kind: CronJob'
  render "${valid[@]}" --set inference.retention.enabled=true --set-json 'gateway.retention={}'
  absent 'kind: CronJob'
}
tags() {
  local version
  version="$(sed -n -E 's/^appVersion: *"?([^"]+)"?$/\1/p' "$chart_dir/Chart.yaml")"
  render --set inference.enabled=true --set inference.retention.enabled=true \
    --set inference.retention.adminTokenSecret=retention-only
  count "image: \"ghcr.io/different-ai/openwork-inference:$version\"" 2
  render "${valid[@]}" --set gateway.retention.enabled=true --set gateway.retention.adminTokenSecret=retention-only \
    --set image.tag=global --set inference.image.tag=legacy --set gateway.image.tag=canonical
  count 'image: "ghcr.io/different-ai/openwork-inference:canonical"' 2
  render "${valid[@]}" --set gateway.retention.enabled=true --set gateway.retention.adminTokenSecret=retention-only \
    --set image.tag=global --set inference.image.tag=legacy --set-string gateway.image.tag=
  count 'image: "ghcr.io/different-ai/openwork-inference:global"' 2
}
identities() {
  render "${valid[@]}" --set ingress.enabled=true --set ingress.web.host=web.example.com --set ingress.api.host=api.example.com
  count 'name: openwork-ee-inference' 2
  count 'app.kubernetes.io/component: inference' 5
  contains '- name: inference'
  contains 'ghcr.io/different-ai/openwork-inference:'
  contains 'host: "web.example.com"'
  contains 'host: "api.example.com"'
  absent 'name: openwork-ee-gateway'
}
secrets() {
  render "${valid[@]}" --set secret.keys.databaseUrl=db-uri --set secret.keys.denDbEncryptionKey=shared-encryption \
    --set gateway.admin.enabled=true --set gateway.webhook.enabled=true \
    --set secret.keys.gatewayAdminToken=admin-key --set secret.keys.gatewayWebhookSecret=webhook-key
  count 'key: "db-uri"' 2
  count 'key: "shared-encryption"' 2
  count 'key: "admin-key"' 2
  count 'key: "webhook-key"' 2
  count 'optional: false' 8
}
planetscale() {
  render "${valid[@]}" --set config.databaseMode=planetscale --set secret.keys.databaseHost=db-host \
    --set secret.keys.databaseUsername=db-user --set secret.keys.databasePassword=db-password
  count 'key: "db-host"' 2
  count 'key: "db-user"' 2
  count 'key: "db-password"' 2
  # Only the migration Job uses TCP DATABASE_URL; runtime pods use HTTP keys.
  count '- name: DATABASE_URL' 1
}
created_secret() {
  render "${valid[@]}" --set secret.create=true \
    --set secret.values.databaseUrl=mysql://test:fixture@mysql:3306/openwork \
    --set secret.values.denDbEncryptionKey=fixture-encryption-key-at-least-32-characters \
    --set gateway.admin.enabled=true --set secret.values.inferenceAdminToken=discard \
    --set secret.values.gatewayAdminToken=fixture-token
  contains 'INFERENCE_ADMIN_TOKEN: "fixture-token"'
  absent 'discard'
  count 'key: "INFERENCE_ADMIN_TOKEN"' 2
}
token_clear() {
  render "${valid[@]}" --set secret.create=true \
    --set secret.values.databaseUrl=mysql://test:fixture@mysql:3306/openwork \
    --set secret.values.denDbEncryptionKey=fixture-encryption-key-at-least-32-characters \
    --set secret.values.inferenceAdminToken=discard --set-string secret.values.gatewayAdminToken= \
    --set-string secret.keys.gatewayWebhookSecret=
  contains 'INFERENCE_ADMIN_TOKEN: ""'
  absent 'discard'
  absent 'INFERENCE_WEBHOOK_SECRET:'
  env_value GATEWAY_WEBHOOK_SECRET ''
}
canonical_ca() {
  render "${valid[@]}" --set customCa.enabled=true --set customCa.existingSecret=custom-ca \
    --set inference.env.NODE_EXTRA_CA_CERTS=/discard --set-json 'gateway.env={}'
  absent '/discard'
  count '- name: NODE_EXTRA_CA_CERTS' 4
}
valid_origins() {
  render "${valid[@]}" --set config.internal.gatewayProxyBaseUrl=http://gateway.svc.cluster.local:8791/ \
    --set config.public.gatewayPublicBaseUrl=https://gateway.example.com/
  env_value GATEWAY_PUBLIC_BASE_URL https://gateway.example.com/
  render "${valid[@]}" --set-string 'config.internal.gatewayProxyBaseUrl=http://[2001:db8::2]:8791' \
    --set-string 'config.public.gatewayPublicBaseUrl=https://[2001:db8::3]'
  env_value GATEWAY_PUBLIC_BASE_URL 'https://[2001:db8::3]'
}
created_planetscale() {
  render "${created[@]}" --set config.databaseMode=planetscale \
    --set secret.values.databaseHost=mysql.example.internal --set secret.values.databaseUsername=fixture \
    --set secret.values.databasePassword=fixture
  contains 'DATABASE_HOST: "mysql.example.internal"'
  count 'key: "DATABASE_HOST"' 2
  count '- name: DATABASE_URL' 1
}
retention_overrides_shared() {
  render "${created[@]}" --set gateway.retention.enabled=true --set gateway.retention.adminTokenSecret=retention-only \
    --set secret.values.gatewayAdminToken=unused-shared-token --set secret.keys.gatewayAdminToken=GATEWAY_ADMIN_TOKEN
  contains 'GATEWAY_ADMIN_TOKEN: "unused-shared-token"'
  count 'name: "retention-only"' 4
  absent 'key: "GATEWAY_ADMIN_TOKEN"'
}

check default defaults
check legacy-runtime-only legacy
check canonical-enabled enabled
check explicit-false-wins disabled_wins
check zero-empty-string-list-map-clears structural
check sparse-nested-merge sparse
check canonical-empty-url-clears empty_url
check legacy-explicit-url-alias legacy_url
check enabled-models-legacy-public-split canonical_url
check disabled-canonical-url-wins disabled_canonical_url
check disabled-management-preserves-public-destinations disabled_public_url
check legacy-models-env-compatibility legacy_env
check retention-authoritative-both-aliases retention
check legacy-retention legacy_retention
check retention-false-and-empty-map retention_disabled
check tag-fallback-and-overrides tags
check immutable-resources-and-ingress identities
check shared-and-optional-secret-refs secrets
check planetscale-refs-and-migration planetscale
check created-secret-alias created_secret
check optional-token-clear token_clear
check canonical-custom-ca canonical_ca
check valid-origins-and-trailing-slash valid_origins
check created-planetscale created_planetscale
check retention-overrides-shared-token retention_overrides_shared
check missing-internal reject config.internal.gatewayProxyBaseUrl --set gateway.enabled=true
check missing-public reject config.public.gatewayPublicBaseUrl --set gateway.enabled=true --set config.internal.gatewayProxyBaseUrl=http://gateway:8791
check canonical-empty-enabled reject config.internal.gatewayProxyBaseUrl "${valid[@]}" --set config.internal.inferenceProxyBaseUrl=http://legacy:8791 --set-string config.internal.gatewayProxyBaseUrl=
check invalid-flag reject 'YAML boolean' --set-string gateway.enabled=true
check missing-secret-name reject secret.existingSecret "${valid[@]}" --set-string secret.existingSecret=
check missing-db-key reject secret.keys.databaseUrl "${valid[@]}" --set-string secret.keys.databaseUrl=
check missing-encryption-key reject secret.keys.denDbEncryptionKey "${valid[@]}" --set-string secret.keys.denDbEncryptionKey=
check placeholder-secrets reject non-placeholder "${valid[@]}" --set secret.create=true
check short-encryption reject 'at least 32 characters' "${created[@]}" --set secret.values.denDbEncryptionKey=do-not-disclose
# Isolate Gateway validation; migration URL diagnostics have their own matrix.
check missing-database reject non-placeholder "${created[@]}" --set migrations.enabled=false --set-string secret.values.databaseUrl=
check malformed-database reject 'mysql:// URL' "${created[@]}" --set migrations.enabled=false --set secret.values.databaseUrl=do-not-disclose
check local-database reject 'databaseUrl host' "${created[@]}" --set secret.values.databaseUrl=mysql://test:do-not-disclose@127.0.0.1:3306/openwork
check numeric-loopback-database reject 'databaseUrl host' "${created[@]}" --set secret.values.databaseUrl=mysql://test:do-not-disclose@0x7f000001:3306/openwork
check numeric-loopback-planetscale reject 'databaseHost' "${created[@]}" --set config.databaseMode=planetscale --set secret.values.databaseHost=0x7f000001 --set secret.values.databaseUsername=fixture --set secret.values.databasePassword=do-not-disclose
check missing-planetscale-credentials reject non-placeholder "${created[@]}" --set config.databaseMode=planetscale
check admin-missing-key reject secret.keys.gatewayAdminToken "${valid[@]}" --set gateway.admin.enabled=true --set-string secret.keys.gatewayAdminToken=
check webhook-missing-key reject secret.keys.gatewayWebhookSecret "${valid[@]}" --set gateway.webhook.enabled=true --set-string secret.keys.gatewayWebhookSecret=
check admin-missing-value reject secret.values.inferenceAdminToken "${created[@]}" --set gateway.admin.enabled=true
check webhook-missing-value reject secret.values.inferenceWebhookSecret "${created[@]}" --set gateway.webhook.enabled=true
check admin-empty-canonical-clears reject secret.values.gatewayAdminToken "${created[@]}" --set gateway.admin.enabled=true --set secret.values.inferenceAdminToken=fixture --set-string secret.values.gatewayAdminToken=
check invalid-db-mode reject config.databaseMode "${valid[@]}" --set config.databaseMode=postgres
check blank-image-clears reject gateway.image.repository "${valid[@]}" --set-json 'gateway.image={}'
check blank-service-clears reject gateway.service.type "${valid[@]}" --set-json 'gateway.service={}'
check zero-port reject 'integers between' "${valid[@]}" --set gateway.service.port=0
check negative-replicas reject non-negative "${valid[@]}" --set gateway.replicaCount=-1
check raw-flag-cannot-advertise reject 'Use gateway.enabled' --set denApi.env.GATEWAY_ENABLED=true
check raw-legacy-flag-cannot-advertise reject 'Use gateway.enabled' --set inference.enabled=true --set inference.env.GATEWAY_ENABLED=true
check database-env-conflict reject 'shared config/secret' "${valid[@]}" --set denApi.env.DATABASE_URL=do-not-disclose
check port-env-conflict reject gateway.containerPort "${valid[@]}" --set gateway.env.GATEWAY_PORT=9999
check retention-missing-secret reject gateway.retention.adminTokenSecret "${valid[@]}" --set gateway.retention.enabled=true
check retention-empty-key reject gateway.retention.adminTokenKey "${valid[@]}" --set gateway.retention.enabled=true --set gateway.retention.adminTokenSecret=retention-only --set-string gateway.retention.adminTokenKey=
for alias in GATEWAY_ADMIN_TOKEN INFERENCE_ADMIN_TOKEN; do
  check "retention-env-conflict-$alias" reject 'instead of' "${valid[@]}" --set gateway.retention.enabled=true --set gateway.retention.adminTokenSecret=retention-only --set "inference.env.$alias=do-not-disclose"
done
for origin in http://gateway.example.com https://localhost https://127.0.0.2 https://gateway.svc https://gateway.example.com/path 'https://gateway.example.com?x=do-not-disclose' 'https://do-not-disclose@gateway.example.com' https://gateway.example.com:0; do
  check "invalid-public-$origin" reject config.public.gatewayPublicBaseUrl "${valid[@]}" --set-string "config.public.gatewayPublicBaseUrl=$origin"
done
for origin in http://localhost:8791 http://127.0.0.2:8791 'http://[::1]:8791' 'http://[::0001]:8791' http://gateway:65536 http://gateway/path http://2130706433 http://999.999.999.999; do
  check "invalid-internal-$origin" reject config.internal.gatewayProxyBaseUrl "${valid[@]}" --set-string "config.internal.gatewayProxyBaseUrl=$origin"
done
printf 'Gateway render matrix: %s passed, %s failed, 0 skipped\n' "$passed" "$failed"
[[ "$failed" == 0 ]]
