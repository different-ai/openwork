{{/*
Guard known organization-only paths and any future chart values moved to Org
Config. Check presence after Helm coalescing, not truthiness: false is a choice.
Do not put a guarded key in values.yaml or reject an existing deployment gate
until its replacement preserves the gate's behavior.
*/}}
{{- define "openwork-ee.validateOrganizationConfigBoundary" -}}
{{- $guidance := "Use Organization Config Import (acme.config.json) instead." -}}
{{- if eq (toString (get .Values "format")) "openwork.config-blob" -}}
  {{- fail (printf "An organization config file was passed as Helm values. Remove it from the Helm command. %s" $guidance) -}}
{{- end -}}
{{- $orgOnly := dict "config.audit.captureOn" "settings.audit → spec.captureOn" -}}
{{- range $path, $destination := $orgOnly -}}
  {{- $node := $.Values -}}
  {{- $present := true -}}
  {{- range $part := splitList "." $path -}}
    {{- if and (kindIs "map" $node) (hasKey $node $part) -}}
      {{- $node = index $node $part -}}
    {{- else -}}
      {{- $present = false -}}
      {{- break -}}
    {{- end -}}
  {{- end -}}
  {{- if $present -}}
    {{- fail (printf "%s is not a Helm setting. Remove it from your Helm values and set %s. %s" $path $destination $guidance) -}}
  {{- end -}}
{{- end -}}
{{- end -}}
