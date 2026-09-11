{{/* Sparse override, unlike mergeOverwrite: an explicit empty map clears. */}}
{{- define "openwork-ee.sparseOverride" -}}
{{- $result := deepCopy .legacy -}}
{{- range $key, $value := .canonical -}}
  {{- if and (kindIs "map" $value) (not (empty $value)) (kindIs "map" (get $result $key)) -}}
    {{- $_ := set $result $key (include "openwork-ee.sparseOverride" (dict "legacy" (get $result $key) "canonical" $value) | fromYaml) -}}
  {{- else -}}
    {{- $_ := set $result $key $value -}}
  {{- end -}}
{{- end -}}
{{- toYaml $result -}}
{{- end -}}

{{/* --reuse-values can replace new chart defaults with old computed values. */}}
{{- define "openwork-ee.gatewayOverrides" -}}
{{- if hasKey .Values "gateway" -}}
{{- if not (kindIs "map" .Values.gateway) -}}
{{- fail "gateway must be a sparse values map" -}}
{{- end -}}
{{- toYaml .Values.gateway -}}
{{- else -}}
{}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.gateway" -}}
{{- include "openwork-ee.sparseOverride" (dict "legacy" .Values.inference "canonical" (include "openwork-ee.gatewayOverrides" . | fromYaml)) -}}
{{- end -}}

{{- define "openwork-ee.gatewayEnabled" -}}
{{- $gateway := include "openwork-ee.gatewayOverrides" . | fromYaml -}}
{{- if hasKey $gateway "enabled" -}}
  {{- if not (kindIs "bool" $gateway.enabled) -}}
    {{- fail "gateway.enabled must be a YAML boolean true or false" -}}
  {{- end -}}
  {{- $gateway.enabled -}}
{{- else -}}
false
{{- end -}}
{{- end -}}

{{- define "openwork-ee.gatewayProxyUrl" -}}
{{- if hasKey .Values.config.internal "gatewayProxyBaseUrl" -}}
{{- .Values.config.internal.gatewayProxyBaseUrl -}}
{{- else -}}
{{- .Values.config.internal.inferenceProxyBaseUrl -}}
{{- end -}}
{{- end -}}

{{/* Never include an origin's value in a validation error. */}}
{{- define "openwork-ee.gatewayOrigin.validate" -}}
{{- $message := printf "%s must be an explicit non-local HTTP(S) origin without credentials, path, query or fragment (public origins require HTTPS and a qualified hostname)" .name -}}
{{- if not (kindIs "string" .value) -}}{{- fail $message -}}{{- end -}}
{{- if not (regexMatch `^https?://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?/?$` .value) -}}{{- fail $message -}}{{- end -}}
{{- $url := urlParse .value -}}
{{- $host := lower (regexReplaceAll `:[0-9]+$` $url.host "") -}}
{{- $port := regexFind `:[0-9]+$` $url.host | trimPrefix ":" -}}
{{- if and $port (or (lt (int $port) 1) (gt (int $port) 65535)) -}}{{- fail $message -}}{{- end -}}
{{- if or (regexMatch `(^localhost(\.|$)|\.localhost\.?$|^127\.|^0\.0\.0\.0$|^\[(:+|0*:)*0*[01]\]$|^\[::ffff:(7f[0-9a-f]{2}:|0:0\]))` $host) (eq $host "[::]") -}}{{- fail $message -}}{{- end -}}
{{- if not (hasPrefix "[" $host) -}}
  {{- if gt (len $host) 253 -}}{{- fail $message -}}{{- end -}}
  {{- range $label := splitList "." $host -}}
    {{- if not (regexMatch `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` $label) -}}{{- fail $message -}}{{- end -}}
  {{- end -}}
  {{- if regexMatch `(^|\.)([0-9]+|0x[0-9a-f]+)$` $host -}}
    {{- if not (regexMatch `^[0-9.]+$` $host) -}}{{- fail $message -}}{{- end -}}
    {{- if ne (len (splitList "." $host)) 4 -}}{{- fail $message -}}{{- end -}}
    {{- range $part := splitList "." $host -}}
      {{- if or (gt (int $part) 255) (and (gt (len $part) 1) (hasPrefix "0" $part)) -}}{{- fail $message -}}{{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- if and .public (or (ne $url.scheme "https") (and (not (hasPrefix "[" $host)) (or (not (contains "." $host)) (regexMatch `\.(local|internal|svc|cluster\.local)$` $host)))) -}}{{- fail $message -}}{{- end -}}
{{- end -}}

{{/* Required keys are shared by Den API and Gateway, including remapped keys. */}}
{{- define "openwork-ee.gatewayDatabaseKeys" -}}
{{- $keys := dict "DEN_DB_ENCRYPTION_KEY" "denDbEncryptionKey" -}}
{{- if eq .Values.config.databaseMode "mysql" -}}
{{- $_ := set $keys "DATABASE_URL" "databaseUrl" -}}
{{- else if eq .Values.config.databaseMode "planetscale" -}}
{{- $_ := set $keys "DATABASE_HOST" "databaseHost" -}}
{{- $_ := set $keys "DATABASE_USERNAME" "databaseUsername" -}}
{{- $_ := set $keys "DATABASE_PASSWORD" "databasePassword" -}}
{{- else -}}
{{- fail "config.databaseMode must be mysql or planetscale when gateway.enabled=true" -}}
{{- end -}}
{{- toYaml $keys -}}
{{- end -}}

{{- define "openwork-ee.gatewayTokenKey" -}}
{{- $canonical := printf "gateway%s" .suffix -}}
{{- if hasKey .root.Values.secret.keys $canonical -}}
{{- get .root.Values.secret.keys $canonical -}}
{{- else -}}
{{- get .root.Values.secret.keys (printf "inference%s" .suffix) -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.gateway.validate" -}}
{{- $gateway := include "openwork-ee.gateway" . | fromYaml -}}
{{- $enabled := eq (include "openwork-ee.gatewayEnabled" .) "true" -}}
{{- if not (kindIs "bool" $gateway.enabled) -}}{{- fail "inference.enabled must be a YAML boolean true or false" -}}{{- end -}}
{{- range $name := list "env" "service" "image" "probes" "resources" "podLabels" "podAnnotations" "retention" -}}
{{- if not (kindIs "map" (get $gateway $name)) -}}{{- fail (printf "gateway.%s (or inference.%s) must be a map" $name $name) -}}{{- end -}}
{{- end -}}
{{- range $name := list "admin" "webhook" -}}
{{- if hasKey $gateway $name -}}
{{- $feature := get $gateway $name -}}
{{- if not (kindIs "map" $feature) -}}{{- fail (printf "gateway.%s must be a map" $name) -}}{{- end -}}
{{- if and (hasKey $feature "enabled") (not (kindIs "bool" $feature.enabled)) -}}{{- fail (printf "gateway.%s.enabled must be a YAML boolean" $name) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (hasKey $gateway.retention "enabled") (not (kindIs "bool" $gateway.retention.enabled)) -}}{{- fail "gateway.retention.enabled must be a YAML boolean" -}}{{- end -}}
{{- if $gateway.enabled -}}
  {{- if not $gateway.image.repository -}}{{- fail "gateway.image.repository (or inference.image.repository) is required; an empty image map clears the legacy repository" -}}{{- end -}}
  {{- if not $gateway.service.type -}}{{- fail "gateway.service.type (or inference.service.type) is required" -}}{{- end -}}
  {{- range $port := list $gateway.containerPort $gateway.service.port -}}
    {{- if or (not (regexMatch `^[0-9]+$` (toString $port))) (lt (int $port) 1) (gt (int $port) 65535) -}}{{- fail "gateway.containerPort and gateway.service.port (or inference aliases) must be integers between 1 and 65535" -}}{{- end -}}
  {{- end -}}
  {{- if not (regexMatch `^[0-9]+$` (toString $gateway.replicaCount)) -}}{{- fail "gateway.replicaCount must be a non-negative integer" -}}{{- end -}}
{{- end -}}
{{- range $env := list .Values.denApi.env $gateway.env -}}
  {{- if hasKey $env "GATEWAY_ENABLED" -}}{{- fail "Use gateway.enabled, not denApi.env/inference.env/gateway.env.GATEWAY_ENABLED" -}}{{- end -}}
  {{- if and (hasKey $.Values.config.internal "gatewayProxyBaseUrl") (or (hasKey $env "GATEWAY_PROXY_BASE_URL") (hasKey $env "INFERENCE_PROXY_BASE_URL")) -}}{{- fail "config.internal.gatewayProxyBaseUrl cannot be combined with proxy URL env overrides" -}}{{- end -}}
{{- end -}}
{{- if and $gateway.enabled $gateway.retention.enabled -}}
  {{- range $field := list "adminTokenSecret" "adminTokenKey" "schedule" "timeZone" -}}
    {{- if not (get $gateway.retention $field) -}}{{- fail (printf "gateway.retention.%s (or inference.retention.%s) is required" $field $field) -}}{{- end -}}
  {{- end -}}
  {{- if or (hasKey $gateway.env "GATEWAY_ADMIN_TOKEN") (hasKey $gateway.env "INFERENCE_ADMIN_TOKEN") -}}{{- fail "Use gateway.retention.adminTokenSecret instead of inference.env/gateway.env admin token aliases when retention is enabled" -}}{{- end -}}
{{- end -}}
{{- if $enabled -}}
  {{- include "openwork-ee.gatewayOrigin.validate" (dict "value" (include "openwork-ee.gatewayProxyUrl" .) "name" "config.internal.gatewayProxyBaseUrl (or inferenceProxyBaseUrl when absent)" "public" false) -}}
  {{- include "openwork-ee.gatewayOrigin.validate" (dict "value" .Values.config.public.gatewayPublicBaseUrl "name" "config.public.gatewayPublicBaseUrl" "public" true) -}}
  {{- if and (not .Values.secret.create) (not .Values.secret.existingSecret) -}}{{- fail "gateway.enabled=true requires secret.existingSecret when secret.create=false" -}}{{- end -}}
  {{- $keys := include "openwork-ee.gatewayDatabaseKeys" . | fromYaml -}}
  {{- range $envName, $key := $keys -}}
    {{- if not (get $.Values.secret.keys $key) -}}{{- fail (printf "secret.keys.%s is required when gateway.enabled=true" $key) -}}{{- end -}}
    {{- if $.Values.secret.create -}}
      {{- $value := get $.Values.secret.values $key | toString | trim -}}
      {{- if or (not $value) (hasPrefix "CHANGE_ME" $value) (and (eq $key "databaseUrl") (contains "change-me" $value)) -}}{{- fail (printf "Set secret.values.%s to a non-placeholder value, or use secret.create=false and secret.existingSecret, when gateway.enabled=true" $key) -}}{{- end -}}
      {{- if and (eq $key "denDbEncryptionKey") (lt (len $value) 32) -}}{{- fail "secret.values.denDbEncryptionKey must contain at least 32 characters" -}}{{- end -}}
      {{- if and (eq $key "databaseUrl") (not (regexMatch `^mysql://[^/@[:space:]]+@[^/[:space:]]+/[^/?#[:space:]]+(\?[^#[:space:]]*)?$` $value)) -}}{{- fail "secret.values.databaseUrl must be a mysql:// URL with username, host and database" -}}{{- end -}}
      {{- if eq $key "databaseUrl" -}}
        {{- $host := regexReplaceAll `^mysql://[^/@]+@([^/]+)/.*$` $value "${1}" -}}
        {{- include "openwork-ee.gatewayOrigin.validate" (dict "value" (printf "http://%s" $host) "name" "secret.values.databaseUrl host" "public" false) -}}
      {{- else if eq $key "databaseHost" -}}
        {{- if contains ":" $value -}}{{- fail "secret.values.databaseHost must be a hostname without a scheme or port" -}}{{- end -}}
        {{- include "openwork-ee.gatewayOrigin.validate" (dict "value" (printf "http://%s" $value) "name" "secret.values.databaseHost" "public" false) -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- range $key := list "PORT" "GATEWAY_PORT" "INFERENCE_PORT" -}}
    {{- if hasKey $gateway.env $key -}}{{- fail "Use gateway.containerPort instead of Gateway port env overrides when gateway.enabled=true" -}}{{- end -}}
  {{- end -}}
  {{- range $env := list .Values.denApi.env $gateway.env -}}
    {{- range $key := concat (keys $keys) (list "DB_MODE" "NODE_ENV" "GATEWAY_PROXY_BASE_URL" "INFERENCE_PROXY_BASE_URL" "GATEWAY_PUBLIC_BASE_URL") -}}
      {{- if hasKey $env $key -}}{{- fail (printf "Remove denApi.env/inference.env/gateway.env.%s; use shared config/secret values when gateway.enabled=true" $key) -}}{{- end -}}
    {{- end -}}
  {{- end -}}
  {{- range $feature, $suffix := dict "admin" "AdminToken" "webhook" "WebhookSecret" -}}
    {{- $settings := get $gateway $feature | default dict -}}
    {{- if not (and (eq $feature "admin") $gateway.retention.enabled) -}}
      {{- range $prefix := list "GATEWAY" "INFERENCE" -}}
        {{- $envKey := printf "%s_%s" $prefix (ternary "ADMIN_TOKEN" "WEBHOOK_SECRET" (eq $feature "admin")) -}}
        {{- if hasKey $gateway.env $envKey -}}{{- fail (printf "Use gateway.%s.enabled and secret.keys/values instead of Gateway token env overrides" $feature) -}}{{- end -}}
      {{- end -}}
      {{- if $settings.enabled -}}
        {{- if not (include "openwork-ee.gatewayTokenKey" (dict "root" $ "suffix" $suffix)) -}}{{- fail (printf "secret.keys.gateway%s (or inference%s) is required" $suffix $suffix) -}}{{- end -}}
        {{- $key := printf "inference%s" $suffix -}}
        {{- if hasKey $.Values.secret.values (printf "gateway%s" $suffix) -}}{{- $key = printf "gateway%s" $suffix -}}{{- end -}}
        {{- if and $.Values.secret.create (not (get $.Values.secret.values $key | toString | trim)) -}}{{- fail (printf "secret.values.%s is required for gateway.%s.enabled" $key $feature) -}}{{- end -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.modelsProxyUrl" -}}
{{- if or (eq (include "openwork-ee.gatewayEnabled" .) "true") .Values.config.public.gatewayPublicBaseUrl -}}
{{- .Values.config.internal.inferenceProxyBaseUrl | default .Values.config.public.gatewayPublicBaseUrl -}}
{{- else if and (hasKey .Values.config.internal "gatewayProxyBaseUrl") .Values.config.internal.inferenceProxyBaseUrl -}}
{{- .Values.config.internal.inferenceProxyBaseUrl -}}
{{- else -}}
{{- include "openwork-ee.inferenceInternalUrl" . -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.gatewayDeploymentEnv" -}}
{{- $env := .env -}}
{{- $root := .root -}}
{{- with .root -}}
- name: GATEWAY_ENABLED
  value: {{ include "openwork-ee.gatewayEnabled" . | quote }}
{{- if eq (include "openwork-ee.gatewayEnabled" .) "true" }}
- name: NODE_ENV
  value: "production"
- name: DB_MODE
  value: {{ .Values.config.databaseMode | quote }}
{{- range $name, $key := (include "openwork-ee.gatewayDatabaseKeys" . | fromYaml) }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "openwork-ee.secretName" $root | quote }}
      key: {{ get $root.Values.secret.keys $key | quote }}
      optional: false
{{- end }}
{{- end }}
{{- if and (or (eq (include "openwork-ee.gatewayEnabled" .) "true") .Values.config.public.gatewayPublicBaseUrl) (not (hasKey $env "GATEWAY_PUBLIC_BASE_URL")) }}
- name: GATEWAY_PUBLIC_BASE_URL
  value: {{ .Values.config.public.gatewayPublicBaseUrl | quote }}
{{- end }}
{{- if or (eq (include "openwork-ee.gatewayEnabled" .) "true") (hasKey .Values.config.internal "gatewayProxyBaseUrl") }}
- name: GATEWAY_PROXY_BASE_URL
  value: {{ include "openwork-ee.gatewayProxyUrl" . | quote }}
- name: INFERENCE_PROXY_BASE_URL
  value: {{ include "openwork-ee.modelsProxyUrl" . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "openwork-ee.gatewayTokenEnv" -}}
{{- $gateway := include "openwork-ee.gateway" . | fromYaml -}}
{{- range $feature, $suffix := dict "admin" "AdminToken" "webhook" "WebhookSecret" -}}
{{- $retention := and (eq $feature "admin") (not (empty $gateway.retention.enabled)) -}}
{{- $settings := get $gateway $feature | default dict -}}
{{- if or $retention (eq (include "openwork-ee.gatewayEnabled" $) "true") -}}
{{- range $prefix := list "GATEWAY" "INFERENCE" }}
- name: {{ $prefix }}_{{ ternary "ADMIN_TOKEN" "WEBHOOK_SECRET" (eq $feature "admin") }}
  {{- if or $retention $settings.enabled }}
  valueFrom:
    secretKeyRef:
      name: {{ ternary $gateway.retention.adminTokenSecret (include "openwork-ee.secretName" $) $retention | quote }}
      key: {{ ternary $gateway.retention.adminTokenKey (include "openwork-ee.gatewayTokenKey" (dict "root" $ "suffix" $suffix)) $retention | quote }}
      optional: false
  {{- else }}
  value: ""
  {{- end }}
{{- end }}
{{- end -}}
{{- end -}}
{{- end -}}
