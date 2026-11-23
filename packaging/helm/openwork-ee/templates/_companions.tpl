{{/* Defaults live here as well as in the documented interface so old --reuse-values
     releases with no companion roots remain default-off. */}}
{{- define "openwork-ee.headlessRunner" -}}
{{- $defaults := fromYaml `
enabled: false
image:
  repository: ghcr.io/different-ai/openwork-headless-runner
  tag: ""
model:
  protocol: ""
  alias: ""
secret:
  existingSecret: ""
  apiTokenKey: HEADLESS_API_TOKEN
  callbackTokenKey: HEADLESS_DEN_CALLBACK_TOKEN
  grantKey: HEADLESS_GRANT_KEY
persistence:
  enabled: false
  existingClaim: ""
  size: 10Gi
  storageClass: null
resources: {}
` -}}
{{- $raw := .Values.headlessRunner | default dict -}}
{{- if not (kindIs "map" $raw) -}}{{- fail "headlessRunner must be a map" -}}{{- end -}}
{{- toYaml (mergeOverwrite $defaults $raw) -}}
{{- end -}}

{{- define "openwork-ee.workbot" -}}
{{- $defaults := fromYaml `
enabled: false
image:
  repository: ghcr.io/different-ai/openwork-workbot
  tag: ""
publicUrl: ""
secret:
  existingSecret: ""
  sessionSecretKey: WORKBOT_SESSION_SECRET
ingress:
  enabled: false
  className: ""
  annotations: {}
  tlsSecretName: ""
resources: {}
` -}}
{{- $raw := .Values.workbot | default dict -}}
{{- if not (kindIs "map" $raw) -}}{{- fail "workbot must be a map" -}}{{- end -}}
{{- toYaml (mergeOverwrite $defaults $raw) -}}
{{- end -}}

{{- define "openwork-ee.companions.apiOrigin" -}}
{{- default .Values.config.public.webOrigin .Values.config.public.apiOrigin | trimSuffix "/" -}}
{{- end -}}

{{- define "openwork-ee.companions.runnerUrl" -}}
http://{{ include "openwork-ee.fullname" . }}-headless-runner:8795
{{- end -}}

{{- define "openwork-ee.companions.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret | quote }}
      key: {{ .key | quote }}
      optional: false
{{- end -}}

{{- define "openwork-ee.companions.fields" -}}
{{- if not (kindIs "map" .value) -}}{{- fail (printf "%s must be a map" .name) -}}{{- end -}}
{{- range $key, $_ := .value -}}
{{- if not (has $key $.allowed) -}}{{- fail (printf "%s.%s is not supported by the chart-managed companion interface" $.name $key) -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.companions.validate" -}}
{{- range $name, $allowed := dict "headlessRunner" (list "enabled" "image" "model" "secret" "persistence" "resources") "workbot" (list "enabled" "image" "publicUrl" "secret" "ingress" "resources") -}}
{{- $raw := get $.Values $name -}}
{{- if hasKey $.Values $name -}}
{{- include "openwork-ee.companions.fields" (dict "name" $name "value" $raw "allowed" $allowed) -}}
{{- range $child, $fields := dict "image" (list "repository" "tag") "model" (list "protocol" "alias") "persistence" (list "enabled" "existingClaim" "size" "storageClass") "secret" (ternary (list "existingSecret" "apiTokenKey" "callbackTokenKey" "grantKey") (list "existingSecret" "sessionSecretKey") (eq $name "headlessRunner")) "ingress" (list "enabled" "className" "annotations" "tlsSecretName") -}}
{{- if hasKey $raw $child -}}
{{- include "openwork-ee.companions.fields" (dict "name" (printf "%s.%s" $name $child) "value" (get $raw $child) "allowed" $fields) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $r := include "openwork-ee.headlessRunner" . | fromYaml -}}
{{- $w := include "openwork-ee.workbot" . | fromYaml -}}
{{- range $setting := list (dict "name" "headlessRunner.enabled" "value" $r.enabled) (dict "name" "workbot.enabled" "value" $w.enabled) (dict "name" "headlessRunner.persistence.enabled" "value" $r.persistence.enabled) (dict "name" "workbot.ingress.enabled" "value" $w.ingress.enabled) -}}
{{- if not (kindIs "bool" $setting.value) -}}{{- fail (printf "%s must be a YAML boolean" $setting.name) -}}{{- end -}}
{{- end -}}
{{- range $settings := list (dict "name" "headlessRunner" "value" $r) (dict "name" "workbot" "value" $w) -}}
{{- if not (kindIs "map" $settings.value.resources) -}}{{- fail (printf "%s.resources must be a map" $settings.name) -}}{{- end -}}
{{- end -}}
{{- if and $r.persistence.enabled (not $r.persistence.existingClaim) -}}
{{- if or (not (kindIs "string" $r.persistence.size)) (not (regexMatch `^[1-9][0-9]*(Ki|Mi|Gi|Ti|Pi|Ei)?$` $r.persistence.size)) -}}{{- fail "headlessRunner.persistence.size must be a positive storage quantity (for example 10Gi)" -}}{{- end -}}
{{- if and (not (kindIs "invalid" $r.persistence.storageClass)) (not (kindIs "string" $r.persistence.storageClass)) -}}{{- fail "headlessRunner.persistence.storageClass must be null or a string" -}}{{- end -}}
{{- end -}}
{{- if and $w.enabled (not $r.enabled) -}}{{- fail "workbot.enabled requires headlessRunner.enabled; external runners are not supported by this chart interface" -}}{{- end -}}
{{- if $r.enabled -}}
{{- if not $r.persistence.enabled -}}{{- fail "headlessRunner.enabled requires headlessRunner.persistence.enabled (no ephemeral SQLite)" -}}{{- end -}}
{{- if ne (include "openwork-ee.gatewayEnabled" .) "true" -}}{{- fail "headlessRunner.enabled requires gateway.enabled=true for member-scoped model access" -}}{{- end -}}
{{- if not (has $r.model.protocol (list "anthropic" "openai" "openai-responses")) -}}{{- fail "headlessRunner.model.protocol must be anthropic, openai or openai-responses" -}}{{- end -}}
{{- if or (not (kindIs "string" $r.model.alias)) (not (regexMatch `^gwm_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}$` $r.model.alias)) -}}{{- fail "headlessRunner.model.alias must be an explicit configured Gateway model alias (gwm_...)" -}}{{- end -}}
{{- include "openwork-ee.gatewayOrigin.validate" (dict "name" "config.public.webOrigin" "value" .Values.config.public.webOrigin "public" true) -}}
{{- include "openwork-ee.gatewayOrigin.validate" (dict "name" "config.public.apiOrigin (or webOrigin)" "value" (default .Values.config.public.webOrigin .Values.config.public.apiOrigin) "public" true) -}}
{{- range $field := list "existingSecret" "apiTokenKey" "callbackTokenKey" "grantKey" -}}
{{- if not (get $r.secret $field) -}}{{- fail (printf "headlessRunner.secret.%s is required" $field) -}}{{- end -}}
{{- end -}}
{{- if or (eq $r.secret.apiTokenKey $r.secret.callbackTokenKey) (eq $r.secret.apiTokenKey $r.secret.grantKey) (eq $r.secret.callbackTokenKey $r.secret.grantKey) -}}{{- fail "headlessRunner secret keys must be distinct; use independent API, callback and grant values" -}}{{- end -}}
{{- if eq $r.secret.existingSecret (include "openwork-ee.secretName" .) -}}{{- fail "headlessRunner requires a dedicated operator-owned Secret, not the shared Den Secret" -}}{{- end -}}
{{- $denTag := include "openwork-ee.imageTag" (dict "root" . "componentTag" .Values.denApi.image.tag) -}}
{{- $gateway := include "openwork-ee.gateway" . | fromYaml -}}
{{- range $image := list $r.image $gateway.image .Values.denWeb.image -}}
{{- if or (not $image.repository) (ne (include "openwork-ee.imageTag" (dict "root" $ "componentTag" $image.tag)) $denTag) -}}{{- fail "chart-managed companions require matching Den API, Den Web, Gateway and runner image tags and nonempty repositories" -}}{{- end -}}
{{- end -}}
{{- /* Legacy env remains legal with opt-ins off, but must never override managed wiring. */ -}}
{{- range $env := list .Values.denApi.env .Values.denWeb.env -}}
{{- range $key, $_ := $env -}}
{{- if or (hasPrefix "DEN_HEADLESS_RUNNER_" $key) (eq $key "DEN_WORKBOT_URL") -}}{{- fail "remove DEN_HEADLESS_RUNNER_* and DEN_WORKBOT_URL env overrides before enabling chart-managed companions" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if $w.enabled -}}
{{- include "openwork-ee.gatewayOrigin.validate" (dict "name" "workbot.publicUrl" "value" $w.publicUrl "public" true) -}}
{{- range $origin := list $.Values.config.public.webOrigin (include "openwork-ee.companions.apiOrigin" $) $.Values.config.public.gatewayPublicBaseUrl -}}
{{- if eq (lower (urlParse $w.publicUrl).host) (lower (urlParse $origin).host) -}}{{- fail "workbot.publicUrl must use a separate host from Den Web, Den API and Gateway" -}}{{- end -}}
{{- end -}}
{{- if or (not $w.image.repository) (ne (include "openwork-ee.imageTag" (dict "root" . "componentTag" $w.image.tag)) $denTag) -}}{{- fail "workbot image tag must match Den API and runner; repository must be nonempty" -}}{{- end -}}
{{- if or (not $w.secret.existingSecret) (not $w.secret.sessionSecretKey) -}}{{- fail "workbot.secret.existingSecret and sessionSecretKey are required" -}}{{- end -}}
{{- if eq $w.secret.existingSecret (include "openwork-ee.secretName" .) -}}{{- fail "workbot requires a dedicated operator-owned Secret, not the shared Den Secret" -}}{{- end -}}
{{- if and (eq $w.secret.existingSecret $r.secret.existingSecret) (has $w.secret.sessionSecretKey (list $r.secret.apiTokenKey $r.secret.callbackTokenKey $r.secret.grantKey)) -}}{{- fail "Workbot session secret must use a distinct key" -}}{{- end -}}
{{- if and $w.ingress.enabled (not $w.ingress.tlsSecretName) -}}{{- fail "workbot.ingress.tlsSecretName is required for HTTPS ingress" -}}{{- end -}}
{{- if and $w.ingress.enabled (contains ":" (urlParse $w.publicUrl).host) -}}{{- fail "workbot.publicUrl must not include a port when chart ingress is enabled" -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.companions.denEnv" -}}
{{- $r := include "openwork-ee.headlessRunner" . | fromYaml -}}
{{- if $r.enabled -}}
- name: DEN_HEADLESS_RUNNER_URL
  value: {{ include "openwork-ee.companions.runnerUrl" . | quote }}
{{ include "openwork-ee.companions.secretEnv" (dict "env" "DEN_HEADLESS_RUNNER_TOKEN" "secret" $r.secret.existingSecret "key" $r.secret.apiTokenKey) }}
{{ include "openwork-ee.companions.secretEnv" (dict "env" "DEN_HEADLESS_RUNNER_CALLBACK_TOKEN" "secret" $r.secret.existingSecret "key" $r.secret.callbackTokenKey) }}
{{- end -}}
{{- end -}}

{{- define "openwork-ee.companions.workbotEnv" -}}
{{- $w := include "openwork-ee.workbot" . | fromYaml -}}
{{- if $w.enabled -}}
- name: DEN_WORKBOT_URL
  value: {{ $w.publicUrl | trimSuffix "/" | quote }}
{{- end -}}
{{- end -}}
