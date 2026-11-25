{{/* Resolve legacy env once for ConfigMap rendering and NOTES. Helm can't
 distinguish a saved default from a new default after coalescing. Preserve
 the full legacy default behavior for Cloud/configured provisioners. */}}
{{- define "openwork-ee.legacyEnv" -}}
{{- $config := .Values.config -}}
{{- $provisioner := $config.provisioner -}}
{{- $active := or (eq $config.deployment "cloud") (ne ($provisioner.mode | default "stub") "stub") (hasKey .Values.denApi.env "CLOUD_RUNTIME_PROVIDER") (hasKey .Values.denApi.env "PROVISIONER_MODE") -}}
{{- $groups := dict
  "provisioner" (dict "reconcileIntervalMs" "WORKER_PROVISIONING_RECONCILE_INTERVAL_MS" "reconcileStaleMs" "WORKER_PROVISIONING_RECONCILE_STALE_MS" "reconcileBatchSize" "WORKER_PROVISIONING_RECONCILE_BATCH_SIZE" "workerUrlTemplate" "WORKER_URL_TEMPLATE")
  "daytona" (dict "apiUrl" "DAYTONA_API_URL" "target" "DAYTONA_TARGET" "sandboxClass" "DAYTONA_SANDBOX_CLASS" "snapshot" "DAYTONA_SNAPSHOT" "sandboxImage" "DAYTONA_SANDBOX_IMAGE" "sandboxCpu" "DAYTONA_SANDBOX_CPU" "sandboxMemory" "DAYTONA_SANDBOX_MEMORY" "sandboxDisk" "DAYTONA_SANDBOX_DISK" "sandboxPublic" "DAYTONA_SANDBOX_PUBLIC" "sandboxAutoStopInterval" "DAYTONA_SANDBOX_AUTO_STOP_INTERVAL" "sandboxAutoPauseInterval" "DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL" "sandboxAutoArchiveInterval" "DAYTONA_SANDBOX_AUTO_ARCHIVE_INTERVAL" "sandboxAutoDeleteInterval" "DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL" "signedPreviewExpiresSeconds" "DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS" "sandboxNamePrefix" "DAYTONA_SANDBOX_NAME_PREFIX" "sharedVolumeName" "DAYTONA_SHARED_VOLUME_NAME" "volumeNamePrefix" "DAYTONA_VOLUME_NAME_PREFIX" "workspaceMountPath" "DAYTONA_WORKSPACE_MOUNT_PATH" "dataMountPath" "DAYTONA_DATA_MOUNT_PATH" "runtimeWorkspacePath" "DAYTONA_RUNTIME_WORKSPACE_PATH" "runtimeDataPath" "DAYTONA_RUNTIME_DATA_PATH" "sidecarDir" "DAYTONA_SIDECAR_DIR" "openworkPort" "DAYTONA_OPENWORK_PORT" "opencodePort" "DAYTONA_OPENCODE_PORT" "createTimeoutSeconds" "DAYTONA_CREATE_TIMEOUT_SECONDS" "deleteTimeoutSeconds" "DAYTONA_DELETE_TIMEOUT_SECONDS" "healthcheckTimeoutMs" "DAYTONA_HEALTHCHECK_TIMEOUT_MS")
  "inference" (dict "openRouterWorkspaceId" "OPENROUTER_WORKSPACE_ID" "stripeInferencePriceId" "STRIPE_INFERENCE_PRICE_ID" "openRouterUpstreamUrl" "OPENROUTER_UPSTREAM_URL" "creditsPerDollar" "INFERENCE_CREDITS_PER_DOLLAR") -}}
{{- $defaults := dict "reconcileIntervalMs" "60000" "reconcileStaleMs" "1200000" "reconcileBatchSize" "10" "workerUrlTemplate" "" "signedPreviewExpiresSeconds" "86400" "sandboxClass" "container" -}}
{{- $result := dict -}}
{{- range $group, $fields := $groups -}}
  {{- $settings := get $config $group | default dict -}}
  {{- range $field, $env := $fields -}}
    {{- $value := get $settings $field | toString -}}
    {{- if and (eq $field "sandboxClass") (not $value) -}}{{- $value = "container" -}}{{- end -}}
    {{- if or (and $active (hasKey $defaults $field)) (and $value (ne $value (get $defaults $field))) -}}
      {{- $_ := set $result $env $value -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- toYaml $result -}}
{{- end -}}

{{/* These two old chart defaults differ from Den's unset behavior even on
 stub installs. Keep them on the processes that use them, without putting
 them in the shared ConfigMap or shadowing an explicit env override. */}}
{{- define "openwork-ee.legacyStubEnv" -}}
{{- $legacy := include "openwork-ee.legacyEnv" . | fromYaml -}}
{{- range $key, $field := dict "WORKER_PROVISIONING_RECONCILE_STALE_MS" "reconcileStaleMs" "WORKER_URL_TEMPLATE" "workerUrlTemplate" -}}
  {{- if and (not (hasKey $legacy $key)) (not (hasKey $.Values.denApi.env $key)) (hasKey $.Values.config.provisioner $field) }}
- name: {{ $key }}
  value: {{ get $.Values.config.provisioner $field | quote }}
  {{- end -}}
{{- end -}}
{{- end -}}
