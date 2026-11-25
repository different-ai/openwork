{{/* Validate coalesced values, including sparse aliases not in values.yaml.
 Kubernetes metadata/resources, extra env and registry-owned feature maps are
 intentionally open. Do not include user-supplied values in errors. */}}
{{- define "openwork-ee.validateValues" -}}
{{- $rules := fromYaml `
"": nameOverride fullnameOverride image imagePullSecrets config observability customCa redis secret installerArtifacts denApi denWeb gateway inference migrations ingress tests headlessRunner workbot global
image: tag pullPolicy
config: databaseMode openworkDevMode denApiNodeOptions deployment features administratorRecovery tenancy audit auth email githubConnector public internal provisioner daytona inference web
config.administratorRecovery: mode expectedMembers organization team teams
config.tenancy: mode singleOrgName singleOrgSlug ownerEmails allowPublicSignup requireEmailVerification
config.audit: selfHostedEnabled captureEnabled visibilityEnabled
config.auth: passwordBreachScreeningEnabled apiKeyRateLimitMax
config.email: supportAddress
config.githubConnector: appId clientId
config.public: gatewayPublicBaseUrl webOrigin apiOrigin mcpResourceUrl mcpAdditionalResources allowPrivateMcpUrls mcpClaimNamespace desktopDenBaseUrl corsOrigins betterAuthCookieDomain betterAuthTrustedOrigins webAppHosts bootstrapAdminEmails automationsEnabled dashboardsEnabled openworkWebEnabled automationsRuntimeEnabled generatedArtifactViewsEnabled appMcpServersEnabled openworkWebUrl installerReleaseTag installerReleaseRepo authCallbackUrl
config.internal: apiBaseUrl authFallbackBaseUrl inferenceProxyBaseUrl gatewayProxyBaseUrl
config.provisioner: mode reconcileIntervalMs reconcileStaleMs reconcileBatchSize workerUrlTemplate
config.daytona: apiUrl target sandboxClass snapshot sandboxImage sandboxCpu sandboxMemory sandboxDisk sandboxPublic sandboxAutoStopInterval sandboxAutoPauseInterval sandboxAutoArchiveInterval sandboxAutoDeleteInterval signedPreviewExpiresSeconds sandboxNamePrefix sharedVolumeName volumeNamePrefix workspaceMountPath dataMountPath runtimeWorkspacePath runtimeDataPath sidecarDir openworkPort opencodePort createTimeoutSeconds deleteTimeoutSeconds healthcheckTimeoutMs
config.inference: openRouterWorkspaceId stripeInferencePriceId openRouterUpstreamUrl creditsPerDollar
config.web: posthogKey posthogHost
observability: backend serviceNames otel sentry
observability.serviceNames: denApi denWeb
observability.otel: endpoint tracesEndpoint metricsEndpoint logsEndpoint protocol exporters tracesSampler tracesSamplerArg headers
observability.otel.exporters: traces metrics logs
observability.otel.headers: existingSecret key
observability.sentry: dsn dsnSecret tracesSampleRate environment release dist
observability.sentry.dsnSecret: existingSecret key
customCa: enabled existingSecret existingConfigMap key
redis: allowInsecureInternal
secret: create existingSecret keys values
installerArtifacts: enabled existingClaim hostPath mountPath
denApi: replicaCount image service containerPort auditUsage githubReconcile env podAnnotations podLabels resources probes
denApi.auditUsage: enabled schedule timeZone tokenSecret tokenKey
denApi.githubReconcile: enabled schedule timeZone tokenSecret tokenKey
denWeb: replicaCount image service containerPort env podAnnotations podLabels resources probes
inference: enabled retention replicaCount image service containerPort env podAnnotations podLabels resources probes admin webhook
migrations: enabled hook hookDeletePolicy writersStoppedFor0097 backoffLimit activeDeadlineSeconds podAnnotations resources command args
ingress: enabled className annotations web api tls
ingress.web: host path pathType
ingress.api: enabled host path pathType
ingress.tls[]: hosts secretName
imagePullSecrets[]: name
tests: liveHealthCheck
` -}}
{{- $secretFields := "databaseUrl databaseHost databaseUsername databasePassword databaseRedisUrl betterAuthSecret denDbEncryptionKey daytonaApiKey openRouterManagementApiKey inferenceAdminToken inferenceWebhookSecret gatewayAdminToken gatewayWebhookSecret emailFrom smtpHost smtpPort smtpUser smtpPass smtpSecure githubConnectorAppClientSecret githubConnectorAppPrivateKey githubConnectorAppWebhookSecret initialAdminBootstrapCode maintenanceToken typesafeApiKey" -}}
{{- $_ := set $rules "secret.keys" $secretFields -}}
{{- $_ := set $rules "secret.values" $secretFields -}}
{{- $_ := set $rules "gateway" (get $rules "inference") -}}
{{- range $component := list "gateway" "inference" -}}
  {{- $_ := set $rules (printf "%s.retention" $component) "enabled schedule timeZone maxBucketsPerRun maxSourceRowsPerBucket adminTokenSecret adminTokenKey" -}}
  {{- $_ := set $rules (printf "%s.admin" $component) "enabled" -}}
  {{- $_ := set $rules (printf "%s.webhook" $component) "enabled" -}}
{{- end -}}
{{- range $component := list "denApi" "denWeb" "gateway" "inference" -}}
  {{- $_ := set $rules (printf "%s.image" $component) "repository tag" -}}
  {{- $_ := set $rules (printf "%s.service" $component) "type port annotations loadBalancerClass loadBalancerSourceRanges" -}}
  {{- $_ := set $rules (printf "%s.probes" $component) "liveness readiness" -}}
  {{- range $probe := list "liveness" "readiness" -}}
    {{- $_ := set $rules (printf "%s.probes.%s" $component $probe) "initialDelaySeconds periodSeconds timeoutSeconds failureThreshold" -}}
  {{- end -}}
{{- end -}}
{{/* Companion maps have their own validation when the companion chart work lands. */}}
{{- $open := list "config.features" "config.administratorRecovery.teams" "global" "headlessRunner" "workbot" "ingress.annotations" "migrations.podAnnotations" "migrations.resources" -}}
{{- range $component := list "denApi" "denWeb" "gateway" "inference" -}}
  {{- range $field := list "env" "podAnnotations" "podLabels" "resources" "service.annotations" -}}
    {{- $open = append $open (printf "%s.%s" $component $field) -}}
  {{- end -}}
{{- end -}}
{{- include "openwork-ee.walkValues" (dict "value" .Values "rules" $rules "open" $open "path" "" "display" "") -}}
{{- include "openwork-ee.validateEnvOverrides" . -}}
{{- if and .Values.tests (hasKey .Values.tests "liveHealthCheck") (not (kindIs "bool" .Values.tests.liveHealthCheck)) -}}
  {{- fail "tests.liveHealthCheck must be a YAML boolean true or false" -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.walkValues" -}}
{{- $allowed := splitList " " (get .rules .path) -}}
{{- range $key, $value := .value -}}
  {{- $path := ternary $key (printf "%s.%s" $.path $key) (eq $.path "") -}}
  {{- $display := ternary $key (printf "%s.%s" $.display $key) (eq $.display "") -}}
  {{- if not (has $key $allowed) -}}
    {{- fail (printf "Unknown Helm value %s. Check values.yaml for the supported keys at this location." $display) -}}
  {{- end -}}
  {{- if has $path $.open -}}
    {{- continue -}}
  {{- else if kindIs "map" $value -}}
    {{- if not (hasKey $.rules $path) -}}
      {{- fail (printf "Helm value %s does not accept nested keys. Check values.yaml." $display) -}}
    {{- end -}}
    {{- include "openwork-ee.walkValues" (dict "value" $value "rules" $.rules "open" $.open "path" $path "display" $display) -}}
  {{- else if and (kindIs "slice" $value) (hasKey $.rules (printf "%s[]" $path)) -}}
    {{- range $index, $item := $value -}}
      {{- if kindIs "map" $item -}}
        {{- include "openwork-ee.walkValues" (dict "value" $item "rules" $.rules "open" $.open "path" (printf "%s[]" $path) "display" (printf "%s[%d]" $display $index)) -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.validateEnvOverrides" -}}
{{- $owned := dict
  "DEN_DEPLOYMENT" "config.deployment"
  "DEN_ORG_MODE" "config.tenancy.mode"
  "DB_MODE" "config.databaseMode"
  "DEN_BASE_URL" "config.public.webOrigin"
  "DEN_AUTH_ORIGIN" "config.public.webOrigin"
  "DEN_API_BASE" "config.internal.apiBaseUrl (or denApi.service.port for the in-cluster default)"
  "OPENWORK_HELM_CHART_VERSION" "the installed chart version (stamped automatically)"
  "OPENWORK_HELM_APP_VERSION" "the chart appVersion (stamped automatically)" -}}
{{- range $component := list "denApi" "denWeb" -}}
  {{- range $key, $_ := (get $.Values $component).env -}}
    {{- $setting := get $owned $key -}}
    {{- if hasPrefix "DEN_FEATURE_" $key -}}{{- $setting = "config.features.<featureKey>" -}}{{- end -}}
    {{- if $setting -}}
      {{- fail (printf "%s.env.%s overrides chart-owned wiring. Remove it and use %s instead." $component $key $setting) -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end -}}
