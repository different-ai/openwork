#!/usr/bin/env bash
set -euo pipefail

chart=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root=$(git -C "$chart" rev-parse --show-toplevel)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
render() { helm template ci-check "$chart" "$@"; }
check() {
  helm lint "$chart" "$@" >/dev/null
  render "$@" >"$scratch/rendered"
}
contains() { grep -Fq -- "$1" "$scratch/rendered" || { echo "Missing: $1" >&2; exit 1; }; }
reject() {
  local expected=$1
  shift
  if render "$@" >"$scratch/error" 2>&1; then
    echo "Expected render to reject: $*" >&2
    exit 1
  fi
  grep -Fq -- "$expected" "$scratch/error" || { cat "$scratch/error" >&2; exit 1; }
}

ci=(--set-string image.tag=ci-test --set denApi.replicaCount=2 --set denWeb.replicaCount=2
  --set secret.create=false --set-string secret.existingSecret=ci-supplied-secret
  --set-string denApi.resources.requests.cpu=250m --set-string 'denApi.podAnnotations.ci\.example\.com/revision=ci-test'
  --set-string denApi.env.NODE_OPTIONS=--max-old-space-size=2048
  --set-string denApi.env.DEN_HEADLESS_RUNNER_URL=http://runner:8080
  --set-string denWeb.env.DEN_WORKBOT_URL=https://workbot.example.com
  --set-string denApi.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED=true)
for example in "$chart"/examples/values.*.yaml; do
  check -f "$example"
  check -f "$example" "${ci[@]}"
  contains 'replicas: 2'
  contains 'ci.example.com/revision: ci-test'
  contains '- name: DEN_HEADLESS_RUNNER_URL'
  contains '- name: DEN_WORKBOT_URL'
  contains '- name: DEN_SLACK_ASSISTANT_WORKER_ENABLED'
  echo "PASS $(basename "$example") standalone and with CI overrides"
done

# Use the full previous chart values, not a hand-picked subset. Release CI
# checks out all refs. Developers can fetch origin/dev before running locally.
git -C "$root" show origin/dev:packaging/helm/openwork-ee/values.yaml >"$scratch/old.yaml"
check -f "$scratch/old.yaml"
check -f "$scratch/old.yaml" "${ci[@]}"
render --is-upgrade -f "$scratch/old.yaml" "${ci[@]}" >"$scratch/rendered"
echo "PASS upgrade with full origin/dev values, with and without CI overrides"

reject 'Unknown Helm value gatway.' --set gatway.enabled=true
reject 'Unknown Helm value denApi.replicas.' --set denApi.replicas=2
reject 'Unknown Helm value config.public.webOrigins.' --set config.public.webOrigins=typo
reject 'Unknown Helm value gateway.service.ports.' --set gateway.service.ports=1
reject 'Unknown Helm value ingress.tls[0].secretNames.' --set 'ingress.tls[0].secretNames=typo'
reject 'denApi.env.DEN_BASE_URL overrides chart-owned wiring. Remove it and use config.public.webOrigin' --set denApi.env.DEN_BASE_URL=https://other.example.com
reject 'denApi.env.DEN_FEATURE_FOO overrides chart-owned wiring. Remove it and use config.features.<featureKey>' --set denApi.env.DEN_FEATURE_FOO=false
reject 'denWeb.env.DEN_API_BASE overrides chart-owned wiring. Remove it and use config.internal.apiBaseUrl' --set denWeb.env.DEN_API_BASE=http://other:1234
reject 'config.audit.captureOn is not a Helm setting.' --set config.audit.captureOn=false
reject 'tests.liveHealthCheck must be a YAML boolean' --set-string tests.liveHealthCheck=false

# Every key of the chart-managed runner and Workbot is a supported value.
alias="gwm_$(printf '0%.0s' {1..26})_$(printf '1%.0s' {1..26})_$(printf '2%.0s' {1..26})"
companions=(--set-string image.tag=ci-test --set secret.create=false --set-string secret.existingSecret=ci-supplied-secret
  --set gateway.enabled=true --set-string config.internal.gatewayProxyBaseUrl=http://gateway:8791
  --set-string config.public.gatewayPublicBaseUrl=https://models.example.com
  --set-string config.public.webOrigin=https://den.example.com --set-string config.public.apiOrigin=https://api.example.com
  --set headlessRunner.enabled=true
  --set-string headlessRunner.image.repository=registry.example.com/openwork-headless-runner --set-string headlessRunner.image.tag=ci-test
  --set-string headlessRunner.model.protocol=openai-responses --set-string "headlessRunner.model.alias=$alias"
  --set-string headlessRunner.secret.existingSecret=runner-runtime --set-string headlessRunner.secret.apiTokenKey=api-token
  --set-string headlessRunner.secret.callbackTokenKey=callback-token --set-string headlessRunner.secret.grantKey=grant-key
  --set headlessRunner.persistence.enabled=true --set-string headlessRunner.persistence.existingClaim=
  --set-string headlessRunner.persistence.size=20Gi --set-string headlessRunner.persistence.storageClass=fast
  --set-string headlessRunner.resources.requests.cpu=250m
  --set workbot.enabled=true
  --set-string workbot.image.repository=registry.example.com/openwork-workbot --set-string workbot.image.tag=ci-test
  --set-string workbot.publicUrl=https://chat.example.com
  --set-string workbot.secret.existingSecret=workbot-runtime --set-string workbot.secret.sessionSecretKey=session-secret
  --set workbot.ingress.enabled=true --set-string workbot.ingress.className=ci-ingress
  --set-string 'workbot.ingress.annotations.ci\.example\.com/idle-timeout=3600' --set-string workbot.ingress.tlsSecretName=workbot-tls
  --set-string workbot.resources.requests.cpu=100m)
check "${companions[@]}"
contains 'name: ci-check-openwork-ee-headless-runner'
contains 'name: ci-check-openwork-ee-workbot'
contains 'image: "registry.example.com/openwork-headless-runner:ci-test"'
contains 'storage: "20Gi"'
contains 'ci.example.com/idle-timeout: "3600"'
contains '- name: DEN_HEADLESS_RUNNER_URL'
contains '- name: DEN_WORKBOT_URL'
reject 'headlessRunner.replicas is not supported by the chart-managed companion interface' "${companions[@]}" --set headlessRunner.replicas=2
reject 'headlessRunner.persistence.path is not supported by the chart-managed companion interface' "${companions[@]}" --set-string headlessRunner.persistence.path=/data
reject 'workbot.ingress.host is not supported by the chart-managed companion interface' "${companions[@]}" --set-string workbot.ingress.host=chat.example.com
echo 'PASS chart-managed runner and Workbot values'

render --show-only templates/configmap.yaml >"$scratch/rendered"
contains "OPENWORK_HELM_CHART_VERSION: \"$(awk '/^version:/ {print $2}' "$chart/Chart.yaml")\""
contains "OPENWORK_HELM_APP_VERSION: $(awk '/^appVersion:/ {print $2}' "$chart/Chart.yaml")"
if grep -Eq '^  (DAYTONA_|WORKER_|OPENROUTER_|STRIPE_INFERENCE_|INFERENCE_PROXY_BASE_URL|INFERENCE_CREDITS_PER_DOLLAR)' "$scratch/rendered"; then
  echo 'Default self-hosted ConfigMap contains legacy env' >&2
  exit 1
fi
render --show-only templates/configmap.yaml --set config.daytona.sandboxPublic=false \
  --set config.daytona.sandboxAutoPauseInterval=7 --set config.provisioner.reconcileIntervalMs=0 \
  --set config.inference.creditsPerDollar=123 >"$scratch/rendered"
contains 'DAYTONA_SANDBOX_PUBLIC: "false"'
contains 'DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL: "7"'
contains 'WORKER_PROVISIONING_RECONCILE_INTERVAL_MS: "0"'
contains 'INFERENCE_CREDITS_PER_DOLLAR: "123"'
render --show-only templates/configmap.yaml --set config.deployment=cloud >"$scratch/rendered"
contains 'WORKER_PROVISIONING_RECONCILE_STALE_MS: "1200000"'
contains 'DAYTONA_SANDBOX_CLASS: "container"'

# helm template does not print NOTES; wrap the same template in a ConfigMap
# in a scratch chart so the check stays cluster-free on Helm 3 and 4.
cp -R "$chart" "$scratch/notes-chart"
notes="$scratch/notes-chart/templates/NOTES.txt"
{
  printf '{{ define "test.notes" }}\n'
  cat "$notes"
  printf '{{ end }}\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test-notes\ndata:\n  notes: |{{ include "test.notes" . | trim | nindent 4 }}\n'
} >"$scratch/notes-chart/templates/test-notes.yaml"
helm template ci-check "$scratch/notes-chart" --show-only templates/test-notes.yaml \
  --set image.tag=ci --set denApi.image.tag=api-ci --set denWeb.image.tag=web-ci \
  --set config.daytona.snapshot=fixture >"$scratch/rendered"
contains 'WARNING: Deprecated legacy Cloud Web worker or Cloud SaaS settings'
contains 'WARNING: image.tag="ci" overrides chart appVersion'
contains 'WARNING: denApi.image.tag="api-ci" overrides chart appVersion'
contains 'WARNING: denWeb.image.tag="web-ci" overrides chart appVersion'

echo 'PASS CI guardrails, legacy compatibility and version warnings'
