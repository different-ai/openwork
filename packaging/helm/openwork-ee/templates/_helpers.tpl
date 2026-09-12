{{- define "openwork-ee.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openwork-ee.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openwork-ee.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openwork-ee.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "openwork-ee.labels" -}}
helm.sh/chart: {{ include "openwork-ee.chart" . }}
{{ include "openwork-ee.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Image tag resolution: component override, then image.tag, then the chart
appVersion. Published charts are packaged with --app-version <release>, so
`helm install --version X` pins the images to X without extra values.
*/}}
{{- define "openwork-ee.imageTag" -}}
{{- .componentTag | default .root.Values.image.tag | default .root.Chart.AppVersion -}}
{{- end -}}

{{- define "openwork-ee.componentSelectorLabels" -}}
{{ include "openwork-ee.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openwork-ee.componentLabels" -}}
{{ include "openwork-ee.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openwork-ee.configName" -}}
{{ include "openwork-ee.fullname" . }}-config
{{- end -}}

{{- define "openwork-ee.allowPrivateMcpUrls" -}}
{{- $value := .Values.config.public.allowPrivateMcpUrls | default "" | toString | trim | lower -}}
{{- if eq $value "1" -}}
1
{{- else if or (eq $value "") (eq $value "0") (eq $value "false") -}}
{{- else -}}
{{- fail "config.public.allowPrivateMcpUrls must be blank, 0, false, or \"1\"" -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- include "openwork-ee.fullname" . }}-secret
{{- end -}}
{{- end -}}

{{- define "openwork-ee.denApiServiceName" -}}
{{ include "openwork-ee.fullname" . }}-den-api
{{- end -}}

{{- define "openwork-ee.migrationDatabase.validate" -}}
{{- if and (not .Values.secret.create) (not .Values.secret.existingSecret) -}}
{{- fail "migrations.enabled=true requires secret.existingSecret when secret.create=false" -}}
{{- end -}}
{{- range $key := list "databaseUrl" "denDbEncryptionKey" -}}
{{- if not (get $.Values.secret.keys $key | toString | trim) -}}
{{- fail (printf "secret.keys.%s is required when migrations.enabled=true" $key) -}}
{{- end -}}
{{- end -}}
{{- if .Values.secret.create -}}
{{- $url := .Values.secret.values.databaseUrl | toString | trim -}}
{{- if not (regexMatch `^mysql://[^/:@[:space:]][^/@[:space:]]*@[^/[:space:]]+/[^/?#[:space:]]+(\?[^#[:space:]]*)?$` $url) -}}
{{- fail "migrations.enabled=true requires secret.values.databaseUrl to be a mysql:// TCP URL with host, username and database; PlanetScale HTTP credentials alone are insufficient" -}}
{{- end -}}
{{- if and (eq .Values.config.databaseMode "planetscale") (contains "change-me" $url) -}}
{{- fail "Set secret.values.databaseUrl to an explicit migration TCP URL for the same PlanetScale database, or use secret.create=false with secret.existingSecret; the default placeholder is not a migration destination" -}}
{{- end -}}
{{- $host := regexReplaceAll `^mysql://[^/@]+@([^/]+)/.*$` $url "${1}" -}}
{{- $port := regexFind `:[0-9]+$` $host | trimPrefix ":" -}}
{{- if or (not (regexMatch `^([a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?$` $host)) (and $port (or (lt (int $port) 1) (gt (int $port) 65535))) -}}
{{- fail "secret.values.databaseUrl must have a valid migration TCP host and port (1-65535)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.denWebServiceName" -}}
{{ include "openwork-ee.fullname" . }}-den-web
{{- end -}}

{{- define "openwork-ee.inferenceServiceName" -}}
{{ include "openwork-ee.fullname" . }}-inference
{{- end -}}

{{- define "openwork-ee.denApiInternalUrl" -}}
{{- default (printf "http://%s:%v" (include "openwork-ee.denApiServiceName" .) .Values.denApi.service.port) .Values.config.internal.apiBaseUrl -}}
{{- end -}}

{{- define "openwork-ee.authFallbackInternalUrl" -}}
{{- default (include "openwork-ee.denApiInternalUrl" .) .Values.config.internal.authFallbackBaseUrl -}}
{{- end -}}

{{- define "openwork-ee.inferenceInternalUrl" -}}
{{- $gateway := include "openwork-ee.gateway" . | fromYaml -}}
{{- if hasKey .Values.config.internal "gatewayProxyBaseUrl" -}}
{{- .Values.config.internal.gatewayProxyBaseUrl -}}
{{- else -}}
{{- default (printf "http://%s:%v" (include "openwork-ee.inferenceServiceName" .) $gateway.service.port) .Values.config.internal.inferenceProxyBaseUrl -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.kubernetesWorkerNamespace" -}}
{{- default "openwork-workers" .Values.config.kubernetes.workerNamespace -}}
{{- end -}}

{{- define "openwork-ee.denApiServiceAccountName" -}}
{{- default (printf "%s-den-api" (include "openwork-ee.fullname" .)) .Values.workers.kubernetes.serviceAccount.name -}}
{{- end -}}

{{- define "openwork-ee.kubernetesWorkersValidate" -}}
{{- if eq .Values.config.provisioner.mode "kubernetes" -}}
{{- if not .Values.workers.kubernetes.serviceAccount.create -}}
{{- if not .Values.workers.kubernetes.serviceAccount.name -}}
{{- fail "workers.kubernetes.serviceAccount.name is required when workers.kubernetes.serviceAccount.create=false and config.provisioner.mode=kubernetes" -}}
{{- end -}}
{{- end -}}
{{- if not .Values.config.kubernetes.workerImage -}}
{{- fail "config.kubernetes.workerImage is required when config.provisioner.mode=kubernetes" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.customCa.mountPath" -}}
/etc/openwork/custom-ca
{{- end -}}

{{- define "openwork-ee.customCa.filePath" -}}
{{ include "openwork-ee.customCa.mountPath" . }}/ca-bundle.pem
{{- end -}}

{{- define "openwork-ee.customCa.validate" -}}
{{- if .Values.customCa.enabled -}}
{{- if and .Values.customCa.existingSecret .Values.customCa.existingConfigMap -}}
{{- fail "customCa.existingSecret and customCa.existingConfigMap are mutually exclusive when customCa.enabled=true" -}}
{{- end -}}
{{- if not (or .Values.customCa.existingSecret .Values.customCa.existingConfigMap) -}}
{{- fail "customCa.existingSecret or customCa.existingConfigMap is required when customCa.enabled=true" -}}
{{- end -}}
{{- if not .Values.customCa.key -}}
{{- fail "customCa.key is required when customCa.enabled=true" -}}
{{- end -}}
{{- if hasKey .Values.denApi.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "denApi.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
{{- end -}}
{{- if hasKey .Values.denWeb.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "denWeb.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
{{- end -}}
{{- $gateway := include "openwork-ee.gateway" . | fromYaml -}}
{{- if hasKey $gateway.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "inference.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead (also applies to gateway.env)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.customCa.volume" -}}
- name: custom-ca
  {{- if .Values.customCa.existingSecret }}
  secret:
    secretName: {{ .Values.customCa.existingSecret | quote }}
    items:
      - key: {{ .Values.customCa.key | quote }}
        path: ca-bundle.pem
  {{- else }}
  configMap:
    name: {{ .Values.customCa.existingConfigMap | quote }}
    items:
      - key: {{ .Values.customCa.key | quote }}
        path: ca-bundle.pem
  {{- end }}
{{- end -}}

{{- define "openwork-ee.customCa.volumeMount" -}}
- name: custom-ca
  mountPath: {{ include "openwork-ee.customCa.mountPath" . | quote }}
  readOnly: true
{{- end -}}

{{- define "openwork-ee.customCa.env" -}}
- name: NODE_EXTRA_CA_CERTS
  value: {{ include "openwork-ee.customCa.filePath" . | quote }}
{{- end -}}

{{- define "openwork-ee.observabilityBackend" -}}
{{- $backend := default "none" .Values.observability.backend -}}
{{- if not (has $backend (list "none" "otel" "sentry")) -}}
{{- fail "observability.backend must be one of none, otel, sentry" -}}
{{- end -}}
{{- $backend -}}
{{- end -}}

{{- define "openwork-ee.observabilityOtelExporter" -}}
{{- $exporter := default "otlp" .value -}}
{{- if not (has $exporter (list "otlp" "none")) -}}
{{- fail (printf "observability.otel.exporters.%s must be otlp or none" .signal) -}}
{{- end -}}
{{- $exporter -}}
{{- end -}}

{{- define "openwork-ee.observabilityOtelSampler" -}}
{{- $sampler := default "parentbased_always_on" . -}}
{{- if not (has $sampler (list "always_on" "always_off" "traceidratio" "parentbased_always_on" "parentbased_always_off" "parentbased_traceidratio")) -}}
{{- fail "observability.otel.tracesSampler must be a standard OpenTelemetry sampler" -}}
{{- end -}}
{{- $sampler -}}
{{- end -}}

{{- define "openwork-ee.observabilityEnv" -}}
{{- $root := .root -}}
{{- $serviceName := .serviceName -}}
{{- $backend := include "openwork-ee.observabilityBackend" $root -}}
{{- $otel := $root.Values.observability.otel -}}
{{- $sentry := $root.Values.observability.sentry -}}
- name: DEN_OBSERVABILITY_BACKEND
  value: {{ $backend | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ $serviceName | quote }}
{{- if eq $backend "otel" }}
{{- $otelSampler := include "openwork-ee.observabilityOtelSampler" $otel.tracesSampler -}}
{{- $otelProtocol := default "http/protobuf" $otel.protocol -}}
{{- if ne $otelProtocol "http/protobuf" }}
{{- fail "observability.otel.protocol must be http/protobuf" -}}
{{- end }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: {{ $otelProtocol | quote }}
{{- with $otel.endpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.tracesEndpoint }}
- name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.metricsEndpoint }}
- name: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.logsEndpoint }}
- name: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  value: {{ . | quote }}
{{- end }}
- name: OTEL_TRACES_EXPORTER
  value: {{ include "openwork-ee.observabilityOtelExporter" (dict "signal" "traces" "value" $otel.exporters.traces) | quote }}
- name: OTEL_METRICS_EXPORTER
  value: {{ include "openwork-ee.observabilityOtelExporter" (dict "signal" "metrics" "value" $otel.exporters.metrics) | quote }}
- name: OTEL_LOGS_EXPORTER
  value: {{ include "openwork-ee.observabilityOtelExporter" (dict "signal" "logs" "value" $otel.exporters.logs) | quote }}
- name: OTEL_TRACES_SAMPLER
  value: {{ $otelSampler | quote }}
{{- if has $otelSampler (list "traceidratio" "parentbased_traceidratio") }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ default "1" $otel.tracesSamplerArg | quote }}
{{- else if and $otel.tracesSamplerArg (ne (toString $otel.tracesSamplerArg) "1") }}
{{- fail "observability.otel.tracesSamplerArg is only supported for traceidratio samplers" -}}
{{- end }}
{{- with $otel.headers.existingSecret }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ . | quote }}
      key: {{ $otel.headers.key | quote }}
{{- end }}
{{- else if eq $backend "sentry" }}
{{- if and $sentry.dsn $sentry.dsnSecret.existingSecret }}
{{- fail "observability.sentry.dsn and observability.sentry.dsnSecret.existingSecret are mutually exclusive" -}}
{{- end }}
{{- if not (or $sentry.dsn $sentry.dsnSecret.existingSecret) }}
{{- fail "observability.sentry.dsn or observability.sentry.dsnSecret.existingSecret is required when observability.backend=sentry" -}}
{{- end }}
- name: SENTRY_DSN
{{- if $sentry.dsn }}
  value: {{ $sentry.dsn | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ $sentry.dsnSecret.existingSecret | quote }}
      key: {{ $sentry.dsnSecret.key | quote }}
{{- end }}
- name: SENTRY_TRACES_SAMPLE_RATE
  value: {{ $sentry.tracesSampleRate | quote }}
{{- with $sentry.environment }}
- name: SENTRY_ENVIRONMENT
  value: {{ . | quote }}
{{- end }}
{{- with $sentry.release }}
- name: SENTRY_RELEASE
  value: {{ . | quote }}
{{- end }}
{{- with $sentry.dist }}
- name: SENTRY_DIST
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}
