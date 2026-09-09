#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

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
    printf 'Expected rendered chart NOT to contain %s\n' "$needle" >&2
    return 1
  fi
}

# Document-kind assertions match "kind: <Kind>" as a standalone YAML document
# line, so nested fields like roleRef.kind: Role or subjects[].kind:
# ServiceAccount do not produce false positives.
assert_document() {
  local file="$1"
  local kind="$2"
  if ! grep -E -q "^kind: ${kind}$" "$file"; then
    printf 'Expected rendered chart to contain a %s document\n' "$kind" >&2
    return 1
  fi
}

assert_not_document() {
  local file="$1"
  local kind="$2"
  if grep -E -q "^kind: ${kind}$" "$file"; then
    printf 'Expected rendered chart NOT to contain a %s document\n' "$kind" >&2
    return 1
  fi
}

# Default (stub) render: no kubernetes RBAC objects, no KUBERNETES_ env vars
# in the config map (the release secret may carry an empty KUBERNETES_API_TOKEN
# key, mirroring the unconditional DAYTONA_API_KEY convention).
default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_not_document "$default_rendered" "Role"
assert_not_document "$default_rendered" "RoleBinding"
assert_not_document "$default_rendered" "ServiceAccount"
assert_not_document "$default_rendered" "Namespace"
default_configmap="$tmp_dir/default-configmap.yaml"
helm template openwork-ee "$chart_dir" --show-only templates/configmap.yaml > "$default_configmap"
assert_not_contains "$default_configmap" "KUBERNETES_"

# Kubernetes mode: ServiceAccount + namespaced Role/RoleBinding + worker
# namespace + the full KUBERNETES_ config surface, and never anything
# cluster-scoped.
kubernetes_values="$tmp_dir/kubernetes-values.yaml"
cat > "$kubernetes_values" <<'EOF'
config:
  provisioner:
    mode: kubernetes
    workerUrlTemplate: "https://{workerId}.workers.example.com"
  kubernetes:
    apiUrl: "https://kubernetes.default.svc"
    apiCaFile: "/etc/openwork/ca.crt"
    workerNamespace: ""
    workerImage: "registry.example/openwork-microsandbox:test"
    workerImagePullPolicy: "Always"
    workerPort: "8787"
    workerApprovalMode: "auto"
    workerCpuRequest: "500m"
    workerCpuLimit: "2"
    workerMemoryRequest: "1Gi"
    workerMemoryLimit: "4Gi"
    workerWorkspaceVolumeSize: "10Gi"
    workerDataVolumeSize: "5Gi"
    workerStorageClass: "ceph-block"
    healthcheckTimeoutMs: "300000"
    pollIntervalMs: "1000"
    workerRecordTtlSeconds: "3600"
EOF
kubernetes_rendered="$tmp_dir/kubernetes.yaml"
helm template openwork-ee "$chart_dir" -f "$kubernetes_values" > "$kubernetes_rendered"
kubernetes_configmap="$tmp_dir/kubernetes-configmap.yaml"
helm template openwork-ee "$chart_dir" -f "$kubernetes_values" --show-only templates/configmap.yaml > "$kubernetes_configmap"
assert_document "$kubernetes_rendered" "ServiceAccount"
assert_document "$kubernetes_rendered" "Role"
assert_document "$kubernetes_rendered" "RoleBinding"
assert_document "$kubernetes_rendered" "Namespace"
assert_contains "$kubernetes_rendered" "name: openwork-workers"
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_NAMESPACE: \"openwork-workers\""
assert_contains "$kubernetes_configmap" "KUBERNETES_API_URL: \"https://kubernetes.default.svc\""
assert_contains "$kubernetes_configmap" "KUBERNETES_API_CA_FILE: \"/etc/openwork/ca.crt\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_IMAGE: \"registry.example/openwork-microsandbox:test\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_IMAGE_PULL_POLICY: \"Always\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_PORT: \"8787\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_APPROVAL_MODE: \"auto\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_CPU_REQUEST: \"500m\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_MEMORY_LIMIT: \"4Gi\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_WORKSPACE_VOLUME_SIZE: \"10Gi\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_DATA_VOLUME_SIZE: \"5Gi\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_STORAGE_CLASS: \"ceph-block\""
assert_contains "$kubernetes_configmap" "KUBERNETES_HEALTHCHECK_TIMEOUT_MS: \"300000\""
assert_contains "$kubernetes_configmap" "KUBERNETES_POLL_INTERVAL_MS: \"1000\""
assert_contains "$kubernetes_configmap" "KUBERNETES_WORKER_RECORD_TTL_SECONDS: \"3600\""
assert_contains "$kubernetes_rendered" "KUBERNETES_API_TOKEN"
assert_contains "$kubernetes_rendered" "serviceAccountName:"
assert_not_document "$kubernetes_rendered" "ClusterRole"
assert_not_document "$kubernetes_rendered" "ClusterRoleBinding"

# Custom namespace and pre-created service account are honored.
custom_values="$tmp_dir/custom-values.yaml"
cat > "$custom_values" <<'EOF'
config:
  provisioner:
    mode: kubernetes
  kubernetes:
    workerNamespace: "my-workers"
workers:
  kubernetes:
    createNamespace: false
    serviceAccount:
      create: false
      name: "precreated-den-api"
EOF
custom_rendered="$tmp_dir/custom.yaml"
helm template openwork-ee "$chart_dir" -f "$custom_values" > "$custom_rendered"
assert_contains "$custom_rendered" "KUBERNETES_WORKER_NAMESPACE: \"my-workers\""
assert_contains "$custom_rendered" "serviceAccountName: precreated-den-api"
assert_not_document "$custom_rendered" "Namespace"
assert_not_document "$custom_rendered" "ServiceAccount"

# Missing service account name with create=false fails loudly.
if helm template openwork-ee "$chart_dir" \
    --set config.provisioner.mode=kubernetes \
    --set workers.kubernetes.serviceAccount.create=false \
    > "$tmp_dir/invalid.yaml" 2> "$tmp_dir/invalid.err"; then
  printf 'Expected chart render to fail when serviceAccount.create=false and no name is set\n' >&2
  exit 1
fi
grep -q "serviceAccount.name is required" "$tmp_dir/invalid.err"

printf 'kubernetes-workers chart checks passed\n'
