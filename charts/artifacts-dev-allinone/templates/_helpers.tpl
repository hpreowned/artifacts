{{- define "allinone.validate" -}}
{{- range list "platform" "staticGateway" "viewerShell" }}
{{- if not (index $.Values.images .) }}{{ fail (printf "images.%s is required" .) }}{{ end }}
{{- end }}
{{- if not .Values.hosts.shell }}{{ fail "hosts.shell is required" }}{{ end }}
{{- if not .Values.hosts.artifactDomain }}{{ fail "hosts.artifactDomain is required" }}{{ end }}
{{- if eq .Values.hosts.shell .Values.hosts.artifactDomain }}{{ fail "hosts.shell and hosts.artifactDomain must differ (and should be different registrable domains)" }}{{ end }}
{{- end -}}

{{- define "allinone.labels" -}}
app.kubernetes.io/name: artifacts-dev-allinone
app.kubernetes.io/instance: {{ .Release.Name }}
artifacts.corp.com/dev-only: "true"
{{- end -}}

{{- define "allinone.parentRef" -}}
- name: {{ .Values.gateway.name }}
  namespace: {{ .Values.gateway.namespace }}
  {{- if .Values.gateway.sectionName }}
  sectionName: {{ .Values.gateway.sectionName }}
  {{- end }}
{{- end -}}

{{- define "allinone.restricted" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}
