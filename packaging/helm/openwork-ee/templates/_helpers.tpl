{{- define "openwork-ee.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openwork-ee.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- /*
  Dedupe in both directions: contains handles release names that already
  include the chart name (my-openwork-ee); hasPrefix handles release names
  that prefix the chart name (release "openwork", chart "openwork-ee"), which
  would otherwise produce doubled names like openwork-openwork-ee-secret.
*/ -}}
{{- if or (contains $name .Release.Name) (hasPrefix .Release.Name $name) -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.namespace" -}}
{{- .Values.namespace | default .Release.Namespace | toString | quote -}}
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

{{/*
  Returns the workload Secret name as a quoted string: existingSecret values
  are user-supplied and may look like YAML scalars (true, 1234), which would
  otherwise render non-string manifest fields and fail at apply time.
  Consumers that need the bare name trim the quotes.
*/}}
{{- define "openwork-ee.secretName" -}}
{{- if eq .Values.secret.secretsMode "existingSecret" -}}
{{- .Values.secret.existingSecret | toString | trim | quote -}}
{{- else -}}
{{- printf "%s-secret" (include "openwork-ee.fullname" .) | quote -}}
{{- end -}}
{{- end -}}

{{/* Bare (unquoted) Secret name for contexts that need it (e.g. lookup). */}}
{{- define "openwork-ee.secretNameRaw" -}}
{{- include "openwork-ee.secretName" . | trimAll "\"" -}}
{{- end -}}

{{/* Bare (unquoted) namespace name for contexts that need it. */}}
{{- define "openwork-ee.namespaceRaw" -}}
{{- include "openwork-ee.namespace" . | trimAll "\"" -}}
{{- end -}}

{{/*
  Workload roll trigger for secret content. In inline mode the rendered
  secret.yaml hash already changes with secret.values. In externalSecrets mode
  secret.yaml renders empty, so hash the inputs that change the Secret ESO
  materializes — the resolved key set, pathPrefix, the secretStoreRef, and the
  conversion/decoding strategies (which change the decoded bytes). envFrom keys
  and values are fixed at pod start, so any of these changing must roll the
  workloads. Non-content ExternalSecret fields (refreshInterval, metadataPolicy,
  hook annotations, target policies) are deliberately excluded so they do not
  cause spurious rolls. existingSecret mode is operator-managed — no chart
  values drive its content, so no trigger is possible there.
*/}}
{{- define "openwork-ee.secretChecksum" -}}
{{- if eq .Values.secret.secretsMode "externalSecrets" -}}
{{- $requiredKeys := list "databaseUrl" "betterAuthSecret" "denDbEncryptionKey" -}}
{{- $optionalKeys := .Values.externalSecrets.optionalKeys | default (list) -}}
{{- $resolvedKeys := list -}}
{{- range $name := concat $requiredKeys $optionalKeys | uniq | sortAlpha -}}
{{- $resolvedKeys = append $resolvedKeys (index $.Values.secret.keys $name) -}}
{{- end -}}
{{- $store := .Values.externalSecrets.secretStoreRef | default dict -}}
{{- $input := dict
    "keys" ($resolvedKeys | uniq | sortAlpha)
    "pathPrefix" (.Values.externalSecrets.pathPrefix | toString | trim | trimSuffix "/")
    "secretStoreName" ($store.name | default "")
    "secretStoreKind" ($store.kind | default "")
    "conversionStrategy" .Values.externalSecrets.conversionStrategy
    "decodingStrategy" .Values.externalSecrets.decodingStrategy -}}
{{- $input | toJson | sha256sum -}}
{{- else -}}
{{- include (print $.Template.BasePath "/secret.yaml") . | sha256sum -}}
{{- end -}}
{{- end -}}

{{/*
  Resolved provider key set the workloads expect in the Secret: the three
  boot-critical keys plus opted-in optionalKeys. Drives the wait-for-secret
  init container. Only meaningful in externalSecrets mode.
*/}}
{{- define "openwork-ee.expectedSecretKeys" -}}
{{- $requiredKeys := list "databaseUrl" "betterAuthSecret" "denDbEncryptionKey" -}}
{{- $optionalKeys := .Values.externalSecrets.optionalKeys | default (list) -}}
{{- $resolved := list -}}
{{- range $name := concat $requiredKeys $optionalKeys | uniq | sortAlpha -}}
{{- $resolved = append $resolved (index $.Values.secret.keys $name) -}}
{{- end -}}
{{- $resolved | uniq | sortAlpha | join " " -}}
{{- end -}}

{{/*
  Init container that blocks until the workload Secret exists and, in
  externalSecrets mode, contains the full expected key set. envFrom imports the
  keys present at pod start and never refreshes, so a pod that starts before
  ESO reconciles a newly-added optional key would hold a stale env until its
  next restart. Required keys block indefinitely (the workload cannot boot
  without them); the optional remainder is bounded by
  externalSecrets.optionalKeyWaitSeconds so a typo'd optional key degrades
  (pod starts without it) rather than bricking the Deployment.
*/}}
{{- define "openwork-ee.waitForSecretInitContainer" -}}
- name: wait-for-secret
  image: "{{ .Values.migrations.kubectlImage.repository }}:{{ .Values.migrations.kubectlImage.tag }}"
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command:
    - sh
    - -c
    - |
        set -u
        SECRET="{{ include "openwork-ee.secretNameRaw" . }}"
        NS="{{ include "openwork-ee.namespaceRaw" . }}"
        until kubectl get secret "$SECRET" -n "$NS" > /dev/null 2>&1; do
          echo "waiting for secret $SECRET..."
          sleep 3
        done
        {{- if eq .Values.secret.secretsMode "externalSecrets" }}
        # Wait without bound for the three boot-critical keys.
        for key in {{ include "openwork-ee.requiredSecretKeys" . }}; do
          until kubectl get secret "$SECRET" -n "$NS" -o jsonpath="{.data.$key}" 2>/dev/null | grep -q .; do
            echo "waiting for required key $key in secret $SECRET..."
            sleep 3
          done
        done
        # Bounded wait for the optional remainder, then proceed. Rendered
        # directly (not via `default`) so an explicit 0 truly skips the wait —
        # `default 60` treats numeric 0 as empty and would force 60.
        deadline=$(( $(date +%s) + {{ .Values.externalSecrets.optionalKeyWaitSeconds }} ))
        for key in {{ include "openwork-ee.optionalSecretKeys" . }}; do
          while ! kubectl get secret "$SECRET" -n "$NS" -o jsonpath="{.data.$key}" 2>/dev/null | grep -q .; do
            if [ "$(date +%s)" -ge "$deadline" ]; then
              echo "proceeding without optional key $key (waited {{ .Values.externalSecrets.optionalKeyWaitSeconds }}s)"
              break
            fi
            echo "waiting for optional key $key in secret $SECRET..."
            sleep 3
          done
        done
        {{- end }}
{{- end -}}

{{/* Required provider key names (env names) in externalSecrets mode. */}}
{{- define "openwork-ee.requiredSecretKeys" -}}
{{- $out := list -}}
{{- range $name := list "databaseUrl" "betterAuthSecret" "denDbEncryptionKey" -}}
{{- $out = append $out (index $.Values.secret.keys $name) -}}
{{- end -}}
{{- $out | join " " -}}
{{- end -}}

{{/* Opt-in optional provider key names (env names) in externalSecrets mode. */}}
{{- define "openwork-ee.optionalSecretKeys" -}}
{{- $out := list -}}
{{- range $name := .Values.externalSecrets.optionalKeys | default (list) -}}
{{- $out = append $out (index $.Values.secret.keys $name) -}}
{{- end -}}
{{- $out | join " " -}}
{{- end -}}

{{- define "openwork-ee.secretsMode.validate" -}}
{{- if not (has .Values.secret.secretsMode (list "inline" "existingSecret" "externalSecrets")) -}}
{{- fail "secretsMode must be one of inline, existingSecret, externalSecrets" -}}
{{- end -}}
{{- if eq .Values.secret.secretsMode "existingSecret" -}}
{{- if not (.Values.secret.existingSecret | toString | trim) -}}
{{- fail "secret.existingSecret is required when secretsMode=existingSecret" -}}
{{- end -}}
{{- end -}}
{{- if ne .Values.secret.secretsMode "existingSecret" -}}
{{- if .Values.secret.existingSecret -}}
{{- fail "secret.existingSecret is only allowed when secretsMode=existingSecret" -}}
{{- end -}}
{{- end -}}
{{- if ne .Values.secret.secretsMode "inline" -}}
{{- if .Values.secret.create -}}
{{- fail "secret.create must be false when secretsMode is not inline" -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.secret.secretsMode "inline") (not .Values.secret.create) -}}
{{- /* Legacy migration shim: values files from before secretsMode shipped that
       set create=false with untouched placeholder values meant "no inline
       secrets" — treat that as existingSecret mode. Real-looking values with
       create=false are incoherent and must fail, not be silently rerouted. */ -}}
{{- $dsn := .Values.secret.values.databaseUrl | toString -}}
{{- $auth := .Values.secret.values.betterAuthSecret | toString -}}
{{- $enc := .Values.secret.values.denDbEncryptionKey | toString -}}
{{- /*
  Reroute only when ALL three required values are still placeholders: a
  partially-filled inline block means someone set real values and create=false
  is incoherent — fail rather than silently ignoring their real values.
*/ -}}
{{- $dsnIsPlaceholder := or (contains "change-me@" $dsn) (contains "******" $dsn) -}}
{{- if and (hasPrefix "CHANGE_ME" $auth) (hasPrefix "CHANGE_ME" $enc) $dsnIsPlaceholder -}}
{{- $_ := set .Values.secret "secretsMode" "existingSecret" -}}
{{- if not (.Values.secret.existingSecret | toString | trim) -}}
{{- $_ := set .Values.secret "existingSecret" (include "openwork-ee.fullname" . | printf "%s-secret") -}}
{{- end -}}
{{- else -}}
{{- fail "secret.create must be true when secretsMode=inline (set secretsMode=existingSecret or externalSecrets to source secrets externally)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.externalSecrets.apiVersion" -}}
{{- if .Capabilities.APIVersions.Has "external-secrets.io/v1" -}}
external-secrets.io/v1
{{- else -}}
external-secrets.io/v1beta1
{{- end -}}
{{- end -}}

{{- define "openwork-ee.externalSecrets.validate" -}}
{{- if eq .Values.secret.secretsMode "externalSecrets" -}}
{{- $storeName := "" -}}
{{- if .Values.externalSecrets.secretStoreRef -}}
{{- $storeName = .Values.externalSecrets.secretStoreRef.name | toString | trim -}}
{{- end -}}
{{- if not $storeName -}}
{{- fail "externalSecrets.secretStoreRef.name is required when secretsMode=externalSecrets" -}}
{{- end -}}
{{- $storeKind := "" -}}
{{- if .Values.externalSecrets.secretStoreRef -}}
{{- $storeKind = .Values.externalSecrets.secretStoreRef.kind | toString -}}
{{- end -}}
{{- if not (has $storeKind (list "SecretStore" "ClusterSecretStore")) -}}
{{- fail "externalSecrets.secretStoreRef.kind must be SecretStore or ClusterSecretStore" -}}
{{- end -}}
{{- if not (.Values.externalSecrets.pathPrefix | toString | trim) -}}
{{- fail "externalSecrets.pathPrefix is required when secretsMode=externalSecrets" -}}
{{- end -}}
{{- range $key := .Values.externalSecrets.optionalKeys | default (list) -}}
{{- if not (hasKey $.Values.secret.keys $key) -}}
{{- fail (printf "externalSecrets.optionalKeys contains %q, which is not a known secret.keys.* name" $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.denApiServiceName" -}}
{{ include "openwork-ee.fullname" . }}-den-api
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
{{- default (printf "http://%s:%v" (include "openwork-ee.inferenceServiceName" .) .Values.inference.service.port) .Values.config.internal.inferenceProxyBaseUrl -}}
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
{{- if hasKey .Values.inference.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "inference.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
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
